import type { ModelToolCall } from "@/models/provider";
import type { ToolAccess, ToolAccessDecision } from "@/tools/mode-policy";
import {
  toolFailure,
  type ToolExecutionResult,
  type ToolMutability,
  type WorkspaceBoundary,
} from "@/tools/types";

const FILE_TOOL_TIMEOUT_MS = 10_000;
const COMMAND_TOOL_TIMEOUT_MS = 120_000;
export const MAX_READ_ONLY_CONCURRENCY = 8;

export type ToolCallResult = {
  readonly call: ModelToolCall;
  readonly sequence: number;
  readonly result: ToolExecutionResult;
};

export type ToolScheduleEvent =
  | {
      readonly type: "started";
      readonly call: ModelToolCall;
      readonly sequence: number;
    }
  | ({ readonly type: "result" } & ToolCallResult)
  | {
      readonly type: "batch-completed";
      readonly orderedResults: readonly ToolCallResult[];
    };

type PreparedCall = {
  readonly call: ModelToolCall;
  readonly sequence: number;
  readonly decision: ToolAccessDecision;
  readonly arguments:
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly result: ToolExecutionResult };
};

export async function* scheduleToolCalls(options: {
  readonly calls: readonly ModelToolCall[];
  readonly access: ToolAccess;
  readonly workspace: WorkspaceBoundary;
  readonly signal: AbortSignal;
  readonly readOnlyConcurrency?: number;
}): AsyncIterable<ToolScheduleEvent> {
  const concurrency = options.readOnlyConcurrency ?? MAX_READ_ONLY_CONCURRENCY;
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_READ_ONLY_CONCURRENCY
  ) {
    throw new Error(`只读工具并发数必须在 1 到 ${MAX_READ_ONLY_CONCURRENCY} 之间。`);
  }

  const prepared = options.calls.map((call, sequence) =>
    prepareCall(call, sequence, options.access),
  );
  const completed: ToolCallResult[] = [];
  let cursor = 0;

  while (cursor < prepared.length && !options.signal.aborted) {
    const current = prepared[cursor];
    if (isRunnableReadOnly(current)) {
      const contiguous: PreparedCall[] = [];
      while (
        cursor < prepared.length &&
        isRunnableReadOnly(prepared[cursor])
      ) {
        contiguous.push(prepared[cursor]);
        cursor += 1;
      }
      for (let offset = 0; offset < contiguous.length; offset += concurrency) {
        if (options.signal.aborted) break;
        const group = contiguous.slice(offset, offset + concurrency);
        for await (const event of executeConcurrentReadOnly(group, options)) {
          if (event.type === "result") completed.push(event);
          yield event;
        }
      }
      continue;
    }

    cursor += 1;
    if (current.arguments.ok === false) {
      const result = toCallResult(current, current.arguments.result);
      completed.push(result);
      yield { type: "result", ...result };
      continue;
    }
    if (current.decision.kind !== "allowed") {
      const result = toCallResult(
        current,
        await options.access.execute(
          current.call.name,
          current.arguments.value,
          executionContext(options, "read-only"),
        ),
      );
      completed.push(result);
      yield { type: "result", ...result };
      continue;
    }

    const execution = safeExecute(current, options);
    yield {
      type: "started",
      call: current.call,
      sequence: current.sequence,
    };
    const result = toCallResult(current, await execution);
    completed.push(result);
    yield { type: "result", ...result };
  }

  yield {
    type: "batch-completed",
    orderedResults: completed.sort((left, right) => left.sequence - right.sequence),
  };
}

async function* executeConcurrentReadOnly(
  calls: readonly PreparedCall[],
  options: {
    readonly access: ToolAccess;
    readonly workspace: WorkspaceBoundary;
    readonly signal: AbortSignal;
  },
): AsyncIterable<Extract<ToolScheduleEvent, { type: "started" | "result" }>> {
  const pending = new Map<number, Promise<ToolCallResult>>();
  for (const call of calls) {
    if (options.signal.aborted) break;
    const execution = safeExecute(call, options).then((result) =>
      toCallResult(call, result),
    );
    pending.set(call.sequence, execution);
    yield { type: "started", call: call.call, sequence: call.sequence };
  }

  while (pending.size > 0) {
    const result = await Promise.race(pending.values());
    pending.delete(result.sequence);
    yield { type: "result", ...result };
  }
}

function prepareCall(
  call: ModelToolCall,
  sequence: number,
  access: ToolAccess,
): PreparedCall {
  const decision = access.classify(call.name);
  if (decision.kind !== "allowed") {
    return {
      call,
      sequence,
      decision,
      arguments: { ok: true, value: undefined },
    };
  }
  try {
    return {
      call,
      sequence,
      decision,
      arguments: { ok: true, value: JSON.parse(call.argumentsJson) as unknown },
    };
  } catch {
    return {
      call,
      sequence,
      decision,
      arguments: {
        ok: false,
        result: toolFailure("invalid-arguments", "工具参数不是有效 JSON。", {
          retryable: true,
        }),
      },
    };
  }
}

function isRunnableReadOnly(call: PreparedCall): boolean {
  return (
    call.arguments.ok &&
    call.decision.kind === "allowed" &&
    call.decision.mutability === "read-only"
  );
}

async function safeExecute(
  call: PreparedCall,
  options: {
    readonly access: ToolAccess;
    readonly workspace: WorkspaceBoundary;
    readonly signal: AbortSignal;
  },
): Promise<ToolExecutionResult> {
  if (call.arguments.ok === false || call.decision.kind !== "allowed") {
    throw new Error("调度器尝试执行未准备完成的工具调用。");
  }
  try {
    return await options.access.execute(
      call.call.name,
      call.arguments.value,
      executionContext(options, call.decision.mutability),
    );
  } catch {
    return toolFailure("execution-failed", "工具执行发生未知错误。", {
      sideEffect: call.decision.mutability === "read-only" ? "none" : "possible",
    });
  }
}

function executionContext(
  options: {
    readonly workspace: WorkspaceBoundary;
    readonly signal: AbortSignal;
  },
  mutability: ToolMutability,
) {
  return {
    workspace: options.workspace,
    signal: options.signal,
    deadlineMs:
      Date.now() +
      (mutability === "command" ? COMMAND_TOOL_TIMEOUT_MS : FILE_TOOL_TIMEOUT_MS),
  };
}

function toCallResult(
  call: PreparedCall,
  result: ToolExecutionResult,
): ToolCallResult {
  return {
    call: call.call,
    sequence: call.sequence,
    result,
  };
}
