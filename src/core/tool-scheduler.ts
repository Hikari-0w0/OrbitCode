import type { PermissionPrompt } from "@/core/permissions/approval";
import type { ModelToolCall } from "@/models/provider";
import type {
  PermissionAuthorization,
  PermissionExecutable,
  PermissionGateway,
} from "@/tools/permission-gateway";
import type { ToolAccess } from "@/tools/mode-policy";
import type {
  PreparedToolCall,
  ToolPreparationResult,
} from "@/tools/registry";
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

export type PermissionResolutionStatus =
  | "allowed"
  | "denied"
  | "expired"
  | "cancelled"
  | "invalid";

export type ToolScheduleEvent =
  | {
      readonly type: "permission-requested";
      readonly call: ModelToolCall;
      readonly sequence: number;
      readonly prompt: PermissionPrompt;
    }
  | {
      readonly type: "permission-resolved";
      readonly call: ModelToolCall;
      readonly sequence: number;
      readonly requestId: string;
      readonly status: PermissionResolutionStatus;
      readonly scope?: "once" | "session" | "permanent";
    }
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
  readonly preparation: ToolPreparationResult;
};

type AuthorizedCall = {
  readonly call: ModelToolCall;
  readonly sequence: number;
  readonly prepared: PreparedToolCall;
  readonly permission?: PermissionExecutable;
};

type SchedulerOptions = {
  readonly calls: readonly ModelToolCall[];
  readonly access: ToolAccess;
  readonly workspace: WorkspaceBoundary;
  readonly signal: AbortSignal;
  readonly permissionGateway?: PermissionGateway;
  readonly readOnlyConcurrency?: number;
};

export async function* scheduleToolCalls(
  options: SchedulerOptions,
): AsyncIterable<ToolScheduleEvent> {
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
  const readBatch: AuthorizedCall[] = [];

  for (const current of prepared) {
    if (options.signal.aborted) break;
    if (
      current.preparation.kind === "failure" ||
      current.preparation.call.mutability !== "read-only"
    ) {
      yield* flushReadBatch(readBatch, completed, options, concurrency);
    }

    if (current.preparation.kind === "failure") {
      const result = toCallResult(current, current.preparation.result);
      completed.push(result);
      yield { type: "result", ...result };
      continue;
    }

    let authorization: PermissionAuthorization | undefined;
    if (
      options.permissionGateway &&
      current.preparation.call.permissionTarget.kind !== "context"
    ) {
      authorization = await options.permissionGateway.authorize(
        current.preparation.call,
        current.call.id,
        options.signal,
      );
    }
    if (authorization?.kind === "awaiting") {
      yield* flushReadBatch(readBatch, completed, options, concurrency);
      yield {
        type: "permission-requested",
        call: current.call,
        sequence: current.sequence,
        prompt: authorization.prompt,
      };
      const requestId = authorization.prompt.requestId;
      const resolvedAuthorization = await authorization.resolve();
      if (resolvedAuthorization.kind === "awaiting") {
        throw new Error("授权代理返回了嵌套等待项。");
      }
      authorization = resolvedAuthorization;
      yield {
        type: "permission-resolved",
        call: current.call,
        sequence: current.sequence,
        requestId,
        status: resolutionStatus(authorization),
        scope: authorization.kind === "allowed"
          ? authorization.approvalScope
          : undefined,
      };
    }
    if (authorization?.kind === "denied") {
      yield* flushReadBatch(readBatch, completed, options, concurrency);
      const result = toCallResult(current, authorization.result);
      completed.push(result);
      yield { type: "result", ...result };
      continue;
    }

    const authorized: AuthorizedCall = {
      call: current.call,
      sequence: current.sequence,
      prepared: current.preparation.call,
      permission: authorization?.kind === "allowed" ? authorization : undefined,
    };
    if (authorized.prepared.mutability === "read-only") {
      readBatch.push(authorized);
      if (readBatch.length >= concurrency) {
        yield* flushReadBatch(readBatch, completed, options, concurrency);
      }
    } else {
      yield* executeAuthorizedBatch([authorized], completed, options);
    }
  }

  if (!options.signal.aborted) {
    yield* flushReadBatch(readBatch, completed, options, concurrency);
  } else {
    readBatch.length = 0;
  }
  yield {
    type: "batch-completed",
    orderedResults: completed.sort((left, right) => left.sequence - right.sequence),
  };
}

async function* flushReadBatch(
  batch: AuthorizedCall[],
  completed: ToolCallResult[],
  options: SchedulerOptions,
  concurrency: number,
): AsyncIterable<ToolScheduleEvent> {
  while (batch.length > 0 && !options.signal.aborted) {
    const group = batch.splice(0, concurrency);
    yield* executeAuthorizedBatch(group, completed, options);
  }
}

async function* executeAuthorizedBatch(
  calls: readonly AuthorizedCall[],
  completed: ToolCallResult[],
  options: SchedulerOptions,
): AsyncIterable<ToolScheduleEvent> {
  const pending = new Map<number, Promise<ToolCallResult>>();
  for (const call of calls) {
    if (options.signal.aborted) break;
    const revalidationFailure = await call.permission?.revalidate(options.signal);
    if (revalidationFailure) {
      const result = toCallResult(call, revalidationFailure);
      completed.push(result);
      yield { type: "result", ...result };
      continue;
    }
    const execution = safeExecute(call, options).then((result) =>
      toCallResult(call, result),
    );
    pending.set(call.sequence, execution);
    yield { type: "started", call: call.call, sequence: call.sequence };
  }

  while (pending.size > 0) {
    const result = await Promise.race(pending.values());
    pending.delete(result.sequence);
    completed.push(result);
    yield { type: "result", ...result };
  }
}

function prepareCall(
  call: ModelToolCall,
  sequence: number,
  access: ToolAccess,
): PreparedCall {
  const accessDecision = access.classify(call.name);
  if (accessDecision.kind !== "allowed") {
    return {
      call,
      sequence,
      preparation: access.prepare(call.name, undefined),
    };
  }
  let rawArguments: unknown;
  try {
    rawArguments = JSON.parse(call.argumentsJson) as unknown;
  } catch {
    return {
      call,
      sequence,
      preparation: {
        kind: "failure",
        result: toolFailure("invalid-arguments", "工具参数不是有效 JSON。", {
          retryable: true,
        }),
      },
    };
  }
  return {
    call,
    sequence,
    preparation: access.prepare(call.name, rawArguments),
  };
}

async function safeExecute(
  call: AuthorizedCall,
  options: SchedulerOptions,
): Promise<ToolExecutionResult> {
  try {
    return await options.access.executePrepared(
      call.prepared,
      executionContext(options, call.prepared.mutability),
    );
  } catch {
    return toolFailure("execution-failed", "工具执行发生未知错误。", {
      sideEffect: call.prepared.mutability === "read-only" ? "none" : "possible",
    });
  }
}

function executionContext(
  options: Pick<SchedulerOptions, "workspace" | "signal">,
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
  call: Pick<PreparedCall, "call" | "sequence">,
  result: ToolExecutionResult,
): ToolCallResult {
  return {
    call: call.call,
    sequence: call.sequence,
    result,
  };
}

function resolutionStatus(
  authorization: Exclude<PermissionAuthorization, { readonly kind: "awaiting" }>,
): PermissionResolutionStatus {
  if (authorization.kind === "allowed") return "allowed";
  return authorization.approvalStatus ?? "invalid";
}
