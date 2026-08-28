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
} from "@/tools/types";

export type RegisteredTool = {
  readonly name: ToolName;
  readonly description: string;
  readonly inputSchema: ToolInputSchema<unknown>;
  readonly mutability: ToolMutability;
  executeUnknown(
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
};

export type ToolDescriptor = {
  readonly name: ToolName;
  readonly mutability: ToolMutability;
  readonly definition: ModelToolDefinition;
};

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

  descriptor(name: string): ToolDescriptor | undefined {
    const tool = this.tools.get(name);
    if (!tool) return undefined;
    return {
      name: tool.name,
      mutability: tool.mutability,
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
    const startedAt = Date.now();
    const tool = this.tools.get(name);
    if (!tool) {
      return toolFailure("unknown-tool", `未知工具：${safeName(name)}`, {
        retryable: true,
        durationMs: Date.now() - startedAt,
      });
    }

    const parsed = tool.inputSchema.parse(rawArguments);
    if (!parsed.ok) {
      return toolFailure("invalid-arguments", "工具参数无效。", {
        retryable: true,
        durationMs: Date.now() - startedAt,
        issues: parsed.issues.slice(0, 20),
      });
    }
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
      .then(() =>
        tool.executeUnknown(parsed.value, {
          ...context,
          signal: executionController.signal,
        }),
      )
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
}

export function defineTool<TInput, TOutput extends JsonValue>(
  tool: Tool<TInput, TOutput>,
): Tool<TInput, TOutput> & RegisteredTool {
  return {
    ...tool,
    inputSchema: tool.inputSchema,
    async executeUnknown(input, context) {
      const parsed = tool.inputSchema.parse(input);
      if (!parsed.ok) {
        return toolFailure("invalid-arguments", "工具参数无效。", {
          retryable: true,
          issues: parsed.issues,
        });
      }
      return tool.execute(parsed.value, context);
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
