import { SkillEventQueue } from "@/core/skills/event-queue";
import type { SkillRunEvent } from "@/core/skills/types";
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
  | SkillRunEvent
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
  readonly permissions: readonly PermissionExecutable[];
};

type SchedulerOptions = {
  readonly deadlineMs?: number;
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


  const completed: ToolCallResult[] = [];
  const readBatch: AuthorizedCall[] = [];

  for (const [sequence, call] of options.calls.entries()) {
    if (call.name === "load_skill") yield* flushReadBatch(readBatch, completed, options, concurrency);
    const current = prepareCall(call, sequence, options.access);
    if (options.signal.aborted) break;
    if (
      current.preparation.kind === "failure" ||
      (current.preparation.call.mutability !== "read-only" || current.preparation.call.scheduling === "barrier")
    ) {
      yield* flushReadBatch(readBatch, completed, options, concurrency);
    }

    if (current.preparation.kind === "failure") {
      const result = toCallResult(current, current.preparation.result);
      completed.push(result);
      yield { type: "result", ...result };
      continue;
    }

    const permissions: PermissionExecutable[] = [];
    let authorizationDenied = false;
    if (
      options.permissionGateway &&
      current.preparation.call.permissionTarget.kind !== "context"
    ) {
      const targets = current.preparation.call.permissionTargets ?? [
        current.preparation.call.permissionTarget,
      ];
      for (const target of targets) {
        let authorization: PermissionAuthorization =
          await options.permissionGateway.authorize(
            current.preparation.call,
            current.call.id,
            options.signal,
            target,
          );
        if (authorization.kind === "awaiting") {
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
        if (authorization.kind === "denied") {
          yield* flushReadBatch(readBatch, completed, options, concurrency);
          const result = toCallResult(current, authorization.result);
          completed.push(result);
          yield { type: "result", ...result };
          authorizationDenied = true;
          break;
        }
        permissions.push(authorization);
      }
    }
    if (authorizationDenied) continue;

    const authorized: AuthorizedCall = {
      call: current.call,
      sequence: current.sequence,
      prepared: current.preparation.call,
      permissions,
    };
    if (authorized.prepared.mutability === "read-only" && authorized.prepared.scheduling !== "barrier") {
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
  const queue = new SkillEventQueue<SkillRunEvent | ({ type: "result" } & ToolCallResult)>();
  const executions: Promise<void>[] = [];
  const controller = new AbortController();
  const executionOptions = { ...options, signal: AbortSignal.any([options.signal, controller.signal]) };
  let remaining = 0;
  try {
    for (const call of calls) {
      if (options.signal.aborted) break;
      const decision = options.access.classify(call.prepared.name);
      let revalidationFailure: ToolExecutionResult | undefined = decision.kind !== "allowed" ? toolFailure("permission-denied", "当前策略不允许执行该工具。", { retryable: true }) : undefined;
      for (const permission of call.permissions) {
        if (revalidationFailure) break;
        revalidationFailure = await permission.revalidate(options.signal);
      }
      if (revalidationFailure) {
        const result = toCallResult(call, revalidationFailure); completed.push(result); yield { type: "result", ...result }; continue;
      }
      remaining++;
      executions.push(safeExecute(call, executionOptions, event => executionOptions.signal.aborted ? Promise.resolve() : queue.push(event)).then(async result => { await queue.push({ type: "result", ...toCallResult(call, result) }); }));
      yield { type: "started", call: call.call, sequence: call.sequence };
    }
    while (remaining > 0) {
      const event = await queue.next();
      if (!event) break;
      if (event.type === "result") { remaining--; completed.push(event); }
      yield event;
    }
  } finally {
    controller.abort();
    queue.close();
    await Promise.all(executions);
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
  emitSkillEvent: (event: SkillRunEvent) => Promise<void>,
): Promise<ToolExecutionResult> {
  try {
    return await options.access.executePrepared(
      call.prepared,
      { ...executionContext(options, call.prepared.mutability), callId: call.call.id, deadlineMs: call.prepared.budget === "parent-run" ? (options.deadlineMs ?? Date.now() + 300_000) : Math.min(options.deadlineMs ?? Infinity, executionContext(options, call.prepared.mutability).deadlineMs), emitSkillEvent },
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
      (mutability === "external" ? 60_000 : mutability === "command" ? COMMAND_TOOL_TIMEOUT_MS : FILE_TOOL_TIMEOUT_MS),
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
