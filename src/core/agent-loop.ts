import type {
  AgentEvent,
  AgentMode,
  AgentStopReason,
  TokenUsage,
} from "@/core/agent-events";
import {
  AgentConfigurationError,
  ConversationStateError,
} from "@/core/errors";
import { scheduleToolCalls, type ToolCallResult } from "@/core/tool-scheduler";
import {
  ProviderError,
  type AssistantMessage,
  type ChatProvider,
  type ConversationMessage,
  type ModelTokenUsage,
  type ModelToolCall,
  type PlainConversationMessage,
  type PromptCacheUsage,
} from "@/models/provider";
import { buildSystemPromptMessages } from "@/core/system-prompt/assemble";
import type {
  OptionalPromptContext,
  PromptEnvironment,
} from "@/core/system-prompt/types";
import type { ToolAccess } from "@/tools/mode-policy";
import type { PermissionGateway } from "@/tools/permission-gateway";
import type {
  SideEffectState,
  WorkspaceBoundary,
} from "@/tools/types";

export const DEFAULT_MAX_AGENT_ITERATIONS = 8;
export const MAX_AGENT_ITERATIONS = 32;
const UNKNOWN_TOOL_ITERATION_LIMIT = 2;
export interface AgentSession {
  getHistory(): readonly PlainConversationMessage[];
  streamTurn(options: {
    readonly input: string;
    readonly mode: AgentMode;
    readonly modeTurn: number;
    readonly signal: AbortSignal;
  }): AsyncIterable<AgentEvent>;
}

export class AgentLoop implements AgentSession {
  private history: PlainConversationMessage[];
  private state: "idle" | "running" = "idle";
  private readonly maxIterations: number;
  private readonly promptEnvironment: PromptEnvironment;
  private readonly optionalPromptContext?: OptionalPromptContext;
  private readonly permissionGatewayForMode?: (
    mode: AgentMode,
  ) => PermissionGateway;

  constructor(
    private readonly provider: ChatProvider,
    private readonly toolAccessForMode: (mode: AgentMode) => ToolAccess,
    private readonly workspace: WorkspaceBoundary,
    options: {
      readonly maxIterations: number;
      readonly promptEnvironment: PromptEnvironment;
      readonly optionalPromptContext?: OptionalPromptContext;
      readonly permissionGatewayForMode?: (
        mode: AgentMode,
      ) => PermissionGateway;
    },
    initialHistory: readonly PlainConversationMessage[] = [],
  ) {
    assertMaxAgentIterations(options.maxIterations);
    this.maxIterations = options.maxIterations;
    this.promptEnvironment = options.promptEnvironment;
    this.optionalPromptContext = options.optionalPromptContext;
    this.permissionGatewayForMode = options.permissionGatewayForMode;
    this.history = initialHistory.map((message) => ({ ...message }));
  }

  getHistory(): readonly PlainConversationMessage[] {
    return this.history.map((message) => ({ ...message }));
  }

  async *streamTurn(options: {
    readonly input: string;
    readonly mode: AgentMode;
    readonly modeTurn: number;
    readonly signal: AbortSignal;
  }): AsyncIterable<AgentEvent> {
    if (this.state !== "idle") {
      throw new ConversationStateError("当前已有进行中的 Agent 轮次。");
    }
    if (options.input.trim().length === 0) {
      throw new ConversationStateError("对话输入不能为空。");
    }
    if (options.mode !== "plan" && options.mode !== "do") {
      throw new ConversationStateError("Agent 模式无效。");
    }

    const systemMessages = buildSystemPromptMessages({
      environment: this.promptEnvironment,
      optional: this.optionalPromptContext,
      session: { mode: options.mode, modeTurn: options.modeTurn },
    });
    this.state = "running";
    const userMessage = { role: "user", content: options.input } as const;
    const transcript: ConversationMessage[] = [
      ...systemMessages,
      ...this.history,
      userMessage,
    ];
    const access = this.toolAccessForMode(options.mode);
    const permissionGateway = this.permissionGatewayForMode?.(options.mode);
    let completedIterations = 0;
    let consecutiveUnknownIterations = 0;
    let sideEffect: SideEffectState = "none";
    let cumulativeUsage: TokenUsage | undefined;

    try {
      for (let iteration = 1; iteration <= this.maxIterations; iteration += 1) {
        if (options.signal.aborted) {
          yield stopped("cancelled", completedIterations, sideEffect, "Agent 轮次已取消。");
          return;
        }
        yield {
          type: "progress",
          iteration,
          maxIterations: this.maxIterations,
          phase: "model",
        };

        const response = this.collectModelResponse(
          transcript,
          access,
          options.signal,
          iteration,
        );
        let content = "";
        const calls: ModelToolCall[] = [];
        let finishReason: "stop" | "tool-call" | undefined;
        let usage: ModelTokenUsage | undefined;
        for await (const event of response) {
          if (event.type === "agent-text") {
            content += event.text;
            yield { type: "text-delta", iteration, text: event.text };
          } else if (event.type === "model-tool-call") {
            calls.push(event.call);
          } else if (event.type === "model-usage") {
            usage = event.usage;
          } else {
            finishReason = event.finishReason;
          }
        }
        completedIterations = iteration;

        const iterationUsage = usage === undefined
          ? ({ availability: "unavailable" } as const)
          : reportedUsage(
              usage.promptTokens,
              usage.completionTokens,
              usage.totalTokens,
              usage.promptCache,
            );
        const nextCumulativeUsage = cumulativeUsage === undefined
          ? iterationUsage
          : addUsage(cumulativeUsage, iterationUsage);
        cumulativeUsage = nextCumulativeUsage;
        yield {
          type: "token-usage",
          iteration,
          usage: iterationUsage,
          cumulative: nextCumulativeUsage,
        };

        if (finishReason === "stop") {
          if (calls.length > 0 || content.trim().length === 0) {
            throw new ProviderError("protocol", "模型没有返回有效的最终文本。");
          }
          const finalMessage: AssistantMessage = {
            role: "assistant",
            content,
          };
          this.history = [...this.history, userMessage, finalMessage];
          yield {
            type: "stopped",
            reason: "final-response",
            iterations: completedIterations,
            sideEffect,
            finalMessage: { ...finalMessage },
          };
          return;
        }
        if (finishReason !== "tool-call" || calls.length === 0) {
          throw new ProviderError("protocol", "模型没有返回有效的工具完成响应。");
        }

        for (const [sequence, call] of calls.entries()) {
          yield {
            type: "tool-call",
            iteration,
            call: safeToolCallForDisplay(call),
            sequence,
          };
        }
        if (iteration === this.maxIterations) {
          yield stopped(
            "max-iterations",
            completedIterations,
            sideEffect,
            `Agent 已达到最大迭代次数 ${this.maxIterations}。`,
          );
          return;
        }

        const allUnknown = calls.every(
          (call) => access.classify(call.name).kind === "unknown",
        );
        if (allUnknown) consecutiveUnknownIterations += 1;
        else consecutiveUnknownIterations = 0;

        yield {
          type: "progress",
          iteration,
          maxIterations: this.maxIterations,
          phase: "tools",
          completedTools: 0,
          totalTools: calls.length,
        };
        let completedTools = 0;
        let orderedResults: readonly ToolCallResult[] = [];
        for await (const event of scheduleToolCalls({
          calls,
          access,
          workspace: this.workspace,
          signal: options.signal,
          permissionGateway,
        })) {
          if (event.type === "started") {
            yield {
              type: "tool-started",
              iteration,
              callId: event.call.id,
              name: event.call.name,
              sequence: event.sequence,
            };
          } else if (event.type === "permission-requested") {
            yield {
              type: "permission-requested",
              iteration,
              callId: event.call.id,
              name: event.call.name,
              sequence: event.sequence,
              prompt: event.prompt,
            };
          } else if (event.type === "permission-resolved") {
            yield {
              type: "permission-resolved",
              iteration,
              callId: event.call.id,
              name: event.call.name,
              sequence: event.sequence,
              requestId: event.requestId,
              status: event.status,
              scope: event.scope,
            };
          } else if (event.type === "result") {
            sideEffect = higherSideEffect(sideEffect, event.result.sideEffect);
            completedTools += 1;
            yield {
              type: "tool-result",
              iteration,
              callId: event.call.id,
              name: event.call.name,
              sequence: event.sequence,
              result: event.result,
            };
            yield {
              type: "progress",
              iteration,
              maxIterations: this.maxIterations,
              phase: "tools",
              completedTools,
              totalTools: calls.length,
            };
          } else if (event.type === "batch-completed") {
            orderedResults = event.orderedResults;
          }
        }

        if (options.signal.aborted) {
          yield stopped("cancelled", completedIterations, sideEffect, "Agent 轮次已取消。");
          return;
        }
        if (
          allUnknown &&
          consecutiveUnknownIterations >= UNKNOWN_TOOL_ITERATION_LIMIT
        ) {
          yield stopped(
            "repeated-unknown-tool",
            completedIterations,
            sideEffect,
            "模型连续请求未知工具，Agent 已安全停止。",
          );
          return;
        }
        if (orderedResults.length !== calls.length) {
          throw new Error("工具调度未返回完整结果。");
        }

        transcript.push({
          role: "assistant",
          content: content.length > 0 ? content : null,
          toolCalls: calls.map(safeToolCallForDisplay),
        });
        for (const item of orderedResults) {
          transcript.push({
            role: "tool",
            toolCallId: item.call.id,
            content: JSON.stringify(item.result),
          });
        }
      }
      throw new Error("Agent 循环越过了最大迭代边界。");
    } catch (error) {
      if (
        options.signal.aborted ||
        (error instanceof ProviderError && error.kind === "cancelled")
      ) {
        yield stopped("cancelled", completedIterations, sideEffect, "Agent 轮次已取消。");
        return;
      }
      if (error instanceof ProviderError) {
        yield stopped("model-error", completedIterations, sideEffect, error.message);
        return;
      }
      yield stopped(
        "agent-error",
        completedIterations,
        sideEffect,
        "Agent 执行发生未知错误，请重试。",
      );
    } finally {
      this.state = "idle";
    }
  }

  private async *collectModelResponse(
    messages: readonly ConversationMessage[],
    access: ToolAccess,
    signal: AbortSignal,
    iteration: number,
  ): AsyncIterable<
    | { readonly type: "agent-text"; readonly text: string }
    | { readonly type: "model-tool-call"; readonly call: ModelToolCall }
    | { readonly type: "model-usage"; readonly usage: ModelTokenUsage }
    | {
        readonly type: "model-done";
        readonly finishReason: "stop" | "tool-call";
      }
  > {
    let completed = false;
    let usageReceived = false;
    for await (const event of this.provider.stream(messages, {
      signal,
      tools: access.definitions(),
      toolChoice: "auto",
    })) {
      if (signal.aborted) {
        throw new ProviderError("cancelled", "模型请求已取消。");
      }
      if (completed && event.type !== "usage") {
        throw new ProviderError("protocol", "模型在完成事件后仍返回了数据。");
      }
      if (event.type === "text-delta") {
        yield { type: "agent-text", text: event.text };
      } else if (event.type === "tool-call") {
        yield { type: "model-tool-call", call: event.call };
      } else if (event.type === "usage") {
        if (usageReceived) {
          throw new ProviderError("protocol", "模型重复返回 Token 用量。");
        }
        usageReceived = true;
        yield { type: "model-usage", usage: event.usage };
      } else {
        if (completed) {
          throw new ProviderError("protocol", "模型重复返回完成事件。");
        }
        completed = true;
        yield {
          type: "model-done",
          finishReason: event.finishReason,
        };
      }
    }
    if (!completed) {
      throw new ProviderError(
        "stream",
        `模型第 ${iteration} 次响应在完成事件前中断。`,
      );
    }
  }
}

function safeToolCallForDisplay(call: ModelToolCall): ModelToolCall {
  return {
    id: call.id,
    name: call.name,
    // 完整参数仅留在服务端准备调用中，避免写入正文或命令凭据进入 DOM/SSE。
    argumentsJson: "{}",
  };
}

export function assertMaxAgentIterations(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_AGENT_ITERATIONS) {
    throw new AgentConfigurationError(
      `Agent 最大迭代次数必须是 1 到 ${MAX_AGENT_ITERATIONS} 之间的整数。`,
    );
  }
}

function stopped(
  reason: AgentStopReason,
  iterations: number,
  sideEffect: SideEffectState,
  detail: string,
): Extract<AgentEvent, { type: "stopped" }> {
  return { type: "stopped", reason, iterations, sideEffect, detail };
}

function reportedUsage(
  promptTokens: number,
  completionTokens: number,
  totalTokens: number,
  promptCache: PromptCacheUsage,
): TokenUsage {
  return {
    availability: "reported",
    promptTokens,
    completionTokens,
    totalTokens,
    promptCache,
  };
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  if (left.availability === "unavailable" || right.availability === "unavailable") {
    return { availability: "unavailable" };
  }
  return reportedUsage(
    left.promptTokens + right.promptTokens,
    left.completionTokens + right.completionTokens,
    left.totalTokens + right.totalTokens,
    addPromptCacheUsage(left.promptCache, right.promptCache),
  );
}

function addPromptCacheUsage(
  left: PromptCacheUsage,
  right: PromptCacheUsage,
): PromptCacheUsage {
  if (
    left.availability === "unavailable" ||
    right.availability === "unavailable"
  ) {
    return { availability: "unavailable" };
  }
  if (left.availability === "tokens" && right.availability === "tokens") {
    return {
      availability: "tokens",
      cachedTokens: left.cachedTokens + right.cachedTokens,
    };
  }
  return {
    availability: "status",
    hit: cacheUsageIsHit(left) || cacheUsageIsHit(right),
  };
}

function cacheUsageIsHit(
  usage: Exclude<PromptCacheUsage, { readonly availability: "unavailable" }>,
): boolean {
  return usage.availability === "tokens" ? usage.cachedTokens > 0 : usage.hit;
}

function higherSideEffect(
  left: SideEffectState,
  right: SideEffectState,
): SideEffectState {
  const rank: Readonly<Record<SideEffectState, number>> = {
    none: 0,
    possible: 1,
    applied: 2,
  };
  return rank[right] > rank[left] ? right : left;
}
