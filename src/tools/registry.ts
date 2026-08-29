import { createHash } from "node:crypto";

import {
  emptyResultMeta,
  toolFailure,
  type JsonValue,
  type ModelToolDefinition,
  type Tool,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolInputSchema,
  type ToolMutability,
  type ToolName,
  type ToolPermissionTarget,
} from "@/tools/types";

export type RegisteredTool = {
  readonly name: ToolName;
  readonly description: string;
  readonly inputSchema: ToolInputSchema<unknown>;
  readonly mutability: ToolMutability;
  readonly permissionTargetKind: ToolPermissionTarget["kind"];
  prepareUnknown(input: unknown): ToolPreparationResult;
};

export type ToolDescriptor = {
  readonly name: ToolName;
  readonly mutability: ToolMutability;
  readonly permissionTargetKind: ToolPermissionTarget["kind"];
  readonly definition: ModelToolDefinition;
};

export type PreparedToolCall = {
  readonly name: ToolName;
  readonly mutability: ToolMutability;
  readonly permissionTarget: ToolPermissionTarget;
  readonly fingerprint: string;
  execute(context: ToolExecutionContext): Promise<ToolExecutionResult>;
};

export type ToolPreparationResult =
  | { readonly kind: "ready"; readonly call: PreparedToolCall }
  | { readonly kind: "failure"; readonly result: ToolExecutionResult };

export class ToolRegistry {
  private readonly tools: ReadonlyMap<string, RegisteredTool>;

  constructor(tools: readonly RegisteredTool[]) {
    const entries = new Map<string, RegisteredTool>();
    for (const tool of tools) {
      if (entries.has(tool.name)) {
        throw new Error(`工具名称重复：${tool.name}`);
      }
      entries.set(tool.name, tool);
    }
    this.tools = entries;
  }

  definitions(): readonly ModelToolDefinition[] {
    return this.descriptors().map((descriptor) => descriptor.definition);
  }

  descriptors(): readonly ToolDescriptor[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      mutability: tool.mutability,
      permissionTargetKind: tool.permissionTargetKind,
      definition: {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema.jsonSchema,
        },
      },
    }));
  }

  permissionTargets(): ReadonlyMap<string, ToolPermissionTarget["kind"]> {
    return new Map(
      [...this.tools.values()].map((tool) => [
        tool.name,
        tool.permissionTargetKind,
      ]),
    );
  }

  descriptor(name: string): ToolDescriptor | undefined {
    const tool = this.tools.get(name);
    if (!tool) return undefined;
    return {
      name: tool.name,
      mutability: tool.mutability,
      permissionTargetKind: tool.permissionTargetKind,
      definition: {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema.jsonSchema,
        },
      },
    };
  }

  has(name: string): name is ToolName {
    return this.tools.has(name);
  }

  async execute(
    name: string,
    rawArguments: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const prepared = this.prepare(name, rawArguments);
    return prepared.kind === "failure"
      ? prepared.result
      : prepared.call.execute(context);
  }

  prepare(name: string, rawArguments: unknown): ToolPreparationResult {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        kind: "failure",
        result: toolFailure("unknown-tool", `未知工具：${safeName(name)}`, {
          retryable: true,
        }),
      };
    }
    return tool.prepareUnknown(rawArguments);
  }
}

async function executePrepared(
  tool: Pick<RegisteredTool, "mutability">,
  execute: (context: ToolExecutionContext) => Promise<ToolExecutionResult>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const startedAt = Date.now();
  if (context.signal.aborted) {
    return toolFailure("cancelled", "工具执行已取消。", {
      durationMs: Date.now() - startedAt,
    });
  }

  const executionController = new AbortController();
  const abortExecution = (): void => executionController.abort();
  context.signal.addEventListener("abort", abortExecution, { once: true });
  const remainingMs = Math.max(0, context.deadlineMs - Date.now());
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutResult = new Promise<ToolExecutionResult>((resolve) => {
    timeout = setTimeout(() => {
      timedOut = true;
      executionController.abort();
      resolve(
        toolFailure("timeout", "工具执行超时。", {
          retryable: true,
          durationMs: Date.now() - startedAt,
          sideEffect: tool.mutability === "read-only" ? "none" : "possible",
        }),
      );
    }, remainingMs);
  });

  const execution = Promise.resolve()
    .then(() => execute({ ...context, signal: executionController.signal }))
    .then<ToolExecutionResult>((result) => ({
      ...result,
      meta: { ...result.meta, durationMs: Date.now() - startedAt },
    }))
    .catch<ToolExecutionResult>(() =>
      toolFailure("execution-failed", "工具执行发生未知错误。", {
        durationMs: Date.now() - startedAt,
        sideEffect: tool.mutability === "read-only" ? "none" : "possible",
      }),
    );

  try {
    const result = await Promise.race([execution, timeoutResult]);
    if (context.signal.aborted && !timedOut) {
      return toolFailure("cancelled", "工具执行已取消。", {
        durationMs: Date.now() - startedAt,
        sideEffect: tool.mutability === "read-only" ? "none" : "possible",
      });
    }
    return result;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    context.signal.removeEventListener("abort", abortExecution);
  }
}

export function defineTool<TInput, TOutput extends JsonValue>(
  tool: Tool<TInput, TOutput>,
): Tool<TInput, TOutput> & RegisteredTool {
  return {
    ...tool,
    inputSchema: tool.inputSchema,
    permissionTargetKind: tool.permission.targetKind,
    prepareUnknown(input) {
      const parsed = tool.inputSchema.parse(input);
      if (!parsed.ok) {
        return {
          kind: "failure" as const,
          result: toolFailure("invalid-arguments", "工具参数无效。", {
            retryable: true,
            issues: parsed.issues,
          }),
        };
      }
      const permissionTarget = Object.freeze(tool.permission.resolve(parsed.value));
      if (permissionTarget.kind !== tool.permission.targetKind) {
        return {
          kind: "failure" as const,
          result: toolFailure("execution-failed", "工具权限目标定义无效。"),
        };
      }
      return {
        kind: "ready" as const,
        call: Object.freeze({
          name: tool.name,
          mutability: tool.mutability,
          permissionTarget,
          fingerprint: fingerprint(parsed.value),
          execute(context: ToolExecutionContext) {
            return executePrepared(
              tool,
              (executionContext) => tool.execute(parsed.value, executionContext),
              context,
            );
          },
        }),
      };
    },
  };
}

export function successfulToolResult<TOutput extends JsonValue>(
  output: TOutput,
  sideEffect: "none" | "possible" | "applied" = "none",
  meta = emptyResultMeta(),
): ToolExecutionResult<TOutput> {
  return { ok: true, output, sideEffect, meta };
}

function safeName(name: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(name) ? name : "<invalid>";
}

function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}
