import type {
  AgentEvent,
  AgentIterationLimit,
  AgentMode,
  AgentStopReason,
  TokenUsage,
} from "@/core/agent-events";
import { ContextManagementError } from "@/core/context/context-errors";
import type { ContextManager } from "@/core/context/context-manager";
import {
  AgentConfigurationError,
  ConversationStateError,
} from "@/core/errors";
import { CompletionTracker } from "@/core/completion-tracker";
import { scheduleToolCalls, type ToolCallResult } from "@/core/tool-scheduler";
import { ToolFailureBudget } from "@/core/tool-failure-budget";
import {
  ProviderError,
  type AssistantMessage,
  type ChatProvider,
  type ConversationMessage,
  type ModelStreamEvent,
  type ModelTokenUsage,
  type ModelToolCall,
  type PlainConversationMessage,
  type PromptCacheUsage,
} from "@/models/provider";
import { buildSystemPromptMessages } from "@/core/system-prompt/assemble";
import type {
  OptionalPromptContext,
  PromptEnvironment,
  PromptSystemMessage,
} from "@/core/system-prompt/types";
import type { ToolAccess } from "@/tools/mode-policy";
import { mcpResultForModel } from "@/tools/mcp-result";
import type { PermissionGateway } from "@/tools/permission-gateway";
import {
  toolFailure,
  type SideEffectState,
  type WorkspaceBoundary,
} from "@/tools/types";

export const DEFAULT_MAX_AGENT_ITERATIONS = 8;
export const MAX_AGENT_ITERATIONS = 32;
export const DEFAULT_MAX_AGENT_RUNTIME_MS = 60 * 60 * 1_000;
export const MAX_AGENT_RUNTIME_MS = 24 * 60 * 60 * 1_000;
const UNKNOWN_TOOL_ITERATION_LIMIT = 2;
const COMPLETION_REPORT_FAILURE_LIMIT = 2;
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
  private readonly maxIterations: AgentIterationLimit;
  private readonly maxRuntimeMs: number;
  private readonly promptEnvironment: PromptEnvironment;
  private readonly optionalPromptContext?: OptionalPromptContext;
  private readonly promptContext?: (signal: AbortSignal) => Promise<OptionalPromptContext>;
  private readonly permissionGatewayForMode?: (
    mode: AgentMode,
  ) => PermissionGateway;
  private readonly now: () => number;
  private readonly completionTracker: CompletionTracker;

  constructor(
    private readonly provider: ChatProvider,
    private readonly toolAccessForMode: (mode: AgentMode) => ToolAccess,
    private readonly workspace: WorkspaceBoundary,
    options: {
      readonly maxIterations: AgentIterationLimit;
      readonly maxRuntimeMs?: number;
      readonly promptEnvironment: PromptEnvironment;
      readonly optionalPromptContext?: OptionalPromptContext;
      readonly promptContext?: (signal: AbortSignal) => Promise<OptionalPromptContext>;
      readonly permissionGatewayForMode?: (
        mode: AgentMode,
      ) => PermissionGateway;
      readonly contextManager?: ContextManager;
      readonly completionTracker?: CompletionTracker;
      readonly now?: () => number;
    },
    initialHistory: readonly PlainConversationMessage[] = [],
  ) {
    assertMaxAgentIterations(options.maxIterations);
    assertMaxAgentRuntime(options.maxRuntimeMs ?? DEFAULT_MAX_AGENT_RUNTIME_MS);
    this.maxIterations = options.maxIterations;
    this.maxRuntimeMs = options.maxRuntimeMs ?? DEFAULT_MAX_AGENT_RUNTIME_MS;
    this.promptEnvironment = options.promptEnvironment;
    this.optionalPromptContext = options.optionalPromptContext;
    this.promptContext = options.promptContext;
    this.permissionGatewayForMode = options.permissionGatewayForMode;
    this.contextManager = options.contextManager;
    this.now = options.now ?? Date.now;
    this.completionTracker = options.completionTracker ?? new CompletionTracker();
    this.history = initialHistory.map((message) => ({ ...message }));
  }

  private readonly contextManager?: ContextManager;

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

    const baseSystemMessages = buildSystemPromptMessages({
      environment: this.promptEnvironment,
      optional: this.optionalPromptContext,
      session: { mode: options.mode, modeTurn: options.modeTurn },
    });
    const languageReminder: readonly PromptSystemMessage[] = /\p{Script=Han}/u.test(options.input)
      ? [{ role: "system", content: "本轮用户使用中文。所有面向用户的过程说明和最终回复都使用中文；工具调用前如需说明动作，也先用中文，不要以英文开场。工具名、代码和原始返回保持原样。" }]
      : [];
    let systemMessages = [...baseSystemMessages, ...languageReminder];
    const startedAt = this.now();
    const durationMs = (): number =>
      Math.max(0, Math.round(this.now() - startedAt));
    const runtimeSignal = AbortSignal.timeout(this.maxRuntimeMs);
    const signal = AbortSignal.any([options.signal, runtimeSignal]);
    const runtimeExceeded = (): boolean =>
      runtimeSignal.aborted && !options.signal.aborted;
    const runtimeDetail = `Agent 已达到最大运行时间 ${formatRuntimeLimit(this.maxRuntimeMs)}。`;
    this.state = "running";
    this.completionTracker.beginRun();
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
    const toolFailureBudget = new ToolFailureBudget();
    let sideEffect: SideEffectState = "none";
    let cumulativeUsage: TokenUsage | undefined;
    let contextTurnActive = false;
    let partialAssistantContent = "";
    let hasLocalToolResult = false;
    let completionReportFailures = 0;
    let interruption:
      | {
          readonly reason: Exclude<AgentStopReason, "final-response">;
          readonly detail: string;
        }
      | undefined;
    const interrupt = (
      reason: Exclude<AgentStopReason, "final-response">,
      detail: string,
    ): Extract<AgentEvent, { type: "stopped" }> => {
      interruption = { reason, detail };
      return stopped(
        reason,
        completedIterations,
        durationMs(),
        sideEffect,
        detail,
        this.completionTracker.assessment(),
      );
    };

    try {
      this.contextManager?.beginTurn(options.input);
      contextTurnActive = this.contextManager !== undefined;
      for (
        let iteration = 1;
        this.maxIterations === "unlimited" || iteration <= this.maxIterations;
        iteration += 1
      ) {
        if (signal.aborted) {
          if (runtimeExceeded()) {
            yield interrupt("max-runtime", runtimeDetail);
            return;
          }
          yield interrupt("cancelled", "Agent 轮次已取消。");
          return;
        }
        yield {
          type: "progress",
          iteration,
          maxIterations: this.maxIterations,
          phase: "model",
        };

        if (this.promptContext) {
          const optional = await this.promptContext(signal);
          const fresh = [...buildSystemPromptMessages({ environment: this.promptEnvironment, optional, session: { mode: options.mode, modeTurn: options.modeTurn } }), ...languageReminder];
          const firstHistory = transcript.findIndex(message => message.role !== "system");
          transcript.splice(0, firstHistory < 0 ? transcript.length : firstHistory, ...fresh);
          systemMessages = fresh;
        }
        const availableTools = access.definitions();
        const finalOnly = completionReportFailures >= COMPLETION_REPORT_FAILURE_LIMIT;
        const toolDefinitions = finalOnly ? [] : hasLocalToolResult
          ? availableTools
          : availableTools.filter((tool) => tool.function.name !== "report_completion");
        const finalizationMessages: readonly PromptSystemMessage[] = finalOnly
          ? [{ role: "system", content: "完成报告首次提交及一次修正均未通过。本轮仅生成最终答复：根据已有结果交代已完成内容、失败和未验证项，不再请求任何工具，不重做已执行的操作，不宣称任务已完整验收。" }]
          : [];
        const promptEnvelope = { systemMessages: [...systemMessages, ...finalizationMessages], tools: toolDefinitions } as const;
        const modelMessages = this.contextManager
          ? (await this.contextManager.prepareForModel(
              promptEnvelope,
              signal,
            )).messages
          : [...transcript, ...finalizationMessages];
        const response = this.collectModelResponse(
          modelMessages,
          toolDefinitions,
          signal,
          iteration,
        );
        let content = "";
        let reasoningContent = "";
        const calls: ModelToolCall[] = [];
        let finishReason: "stop" | "tool-call" | undefined;
        let usage: ModelTokenUsage | undefined;
        let finalizationProtocolFailure = false;
        try {
          for await (const event of response) {
            if (event.type === "model-progress") {
              yield {
                type: "progress",
                iteration,
                maxIterations: this.maxIterations,
                phase: "model",
                model: {
                  stage: event.progress.stage,
                  elapsedMs: event.progress.elapsedMs,
                  attempt: event.progress.attempt,
                  ...(event.progress.traceId === undefined
                    ? {}
                    : { traceId: event.progress.traceId }),
                  ...(event.progress.toolName === undefined
                    ? {}
                    : { toolName: event.progress.toolName }),
                  ...(event.progress.toolArgumentsChars === undefined
                    ? {}
                    : { toolArgumentsChars: event.progress.toolArgumentsChars }),
                },
              };
            } else if (event.type === "agent-text") {
              content += event.text;
              partialAssistantContent = content;
              yield { type: "text-delta", iteration, text: event.text };
            } else if (event.type === "model-reasoning") {
              reasoningContent += event.text;
            } else if (event.type === "model-tool-call") {
              calls.push(event.call);
            } else if (event.type === "model-usage") {
              usage = event.usage;
            } else {
              finishReason = event.finishReason;
            }
          }
        } catch (error) {
          if (!finalOnly || !(error instanceof ProviderError) || error.kind !== "protocol") throw error;
          finalizationProtocolFailure = true;
        }
        completedIterations = iteration;
        if (usage !== undefined) {
          this.contextManager?.recordAgentUsage(usage.promptTokens, promptEnvelope);
        }

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

        if (finalOnly && (finalizationProtocolFailure || finishReason !== "stop" || calls.length > 0 || content.trim().length === 0)) {
          // 隐藏工具不能阻止模型伪造调用；收尾阶段也必须在执行入口阻断副作用。
          const fallback = `${content.length > 0 ? "\n\n" : ""}完成报告未通过校验，本轮已结束。已有操作和检查记录已保留，任务尚未完成验收；请查看未验证项后决定是否继续。`;
          content += fallback;
          yield { type: "text-delta", iteration, text: fallback };
          calls.length = 0;
          finishReason = "stop";
        }
        if (finishReason === "stop") {
          if (calls.length > 0 || content.trim().length === 0) {
            throw new ProviderError("protocol", "模型没有返回有效的最终文本。");
          }
          const finalMessage: AssistantMessage = {
            role: "assistant",
            content,
          };
          if (this.contextManager) {
            this.contextManager.appendFinal(content);
            await this.contextManager.commitTurn();
            contextTurnActive = false;
            partialAssistantContent = "";
            this.history = [...this.contextManager.getPlainHistory()];
          } else {
            this.history = [...this.history, userMessage, finalMessage];
          }
          yield {
            type: "stopped",
            reason: "final-response",
            iterations: completedIterations,
            durationMs: durationMs(),
            sideEffect,
            finalMessage: { ...finalMessage },
            verification: this.completionTracker.assessment(),
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
        if (this.maxIterations !== "unlimited" && iteration === this.maxIterations) {
          const unexecutedResults = cancelledToolResults(
            calls,
            [],
            "达到最大迭代次数，工具未执行。",
          );
          for (const item of unexecutedResults) {
            yield {
              type: "tool-result",
              iteration,
              callId: item.call.id,
              name: item.call.name,
              sequence: item.sequence,
              result: item.result,
            };
          }
          if (this.contextManager) {
            this.contextManager.appendToolExchange(
              content.length > 0 ? content : null,
              calls,
              unexecutedResults.map((item) => toContextToolResult(item)),
              reasoningContent.length > 0 ? reasoningContent : undefined,
            );
            partialAssistantContent = "";
          }
          yield interrupt(
            "max-iterations",
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
          signal,
          permissionGateway,
          deadlineMs: Date.now() + Math.max(1, this.maxRuntimeMs - durationMs()),
        })) {
          if (event.type === "skill-run") { yield { ...event, iteration }; }
          else if (event.type === "started") {
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
            const decision = access.classify(event.call.name);
            if (event.call.name !== "report_completion" && event.call.name !== "read_context" && event.call.name !== "load_skill" && decision.kind === "allowed" && decision.mutability !== "external") hasLocalToolResult = true;
            if (event.call.name !== "load_skill") this.completionTracker.record({
              call: event.call,
              result: event.result,
              iteration,
              sequence: event.sequence,
              mutability: decision.kind === "allowed"
                ? decision.mutability
                : "read-only",
            });
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

        if (signal.aborted) {
          const detail = runtimeExceeded()
            ? runtimeDetail
            : "Agent 轮次已取消。";
          if (this.contextManager) {
            this.contextManager.appendToolExchange(
              content.length > 0 ? content : null,
              calls,
              cancelledToolResults(
                calls,
                orderedResults,
                `${detail} 工具未执行。`,
              ).map((item) => toContextToolResult(
                item,
                undefined,
                this.completionTracker.evidenceId(item.call.id),
              )),
              reasoningContent.length > 0 ? reasoningContent : undefined,
            );
            partialAssistantContent = "";
          }
          yield interrupt(runtimeExceeded() ? "max-runtime" : "cancelled", detail);
          return;
        }
        if (orderedResults.length !== calls.length) {
          throw new Error("工具调度未返回完整结果。");
        }

        const budgetGuidance = new Map<string, string>();
        let budgetStopDetail: string | undefined;
        for (const item of orderedResults) {
          if (item.call.name === "report_completion" && !item.result.ok && item.result.error.kind === "invalid-arguments") {
            this.completionTracker.markReportFailure();
            completionReportFailures += 1;
            budgetGuidance.set(item.call.id, completionReportFailures >= COMPLETION_REPORT_FAILURE_LIMIT
              ? "完成报告修正预算已耗尽。仅生成最终答复，交代已有结果和未验证项，不再调用工具。"
              : "完成报告允许修正一次；按 error.issues 修正检查和证据，汇总状态由运行时计算。无法验证的需求保留为 not-run，不重做已成功的操作。");
            continue;
          }
          const decision = toolFailureBudget.observe(item.call, item.result);
          if (decision.action === "switch") {
            budgetGuidance.set(item.call.id, decision.guidance);
          } else if (decision.action === "stop") {
            budgetStopDetail ??= decision.detail;
          }
        }

        if (this.contextManager) {
          this.contextManager.appendToolExchange(
            content.length > 0 ? content : null,
            calls,
            orderedResults.map((item) =>
              toContextToolResult(
                item,
                budgetGuidance.get(item.call.id),
                this.completionTracker.evidenceId(item.call.id),
              )
            ),
            reasoningContent.length > 0 ? reasoningContent : undefined,
          );
          partialAssistantContent = "";
        } else {
          transcript.push({
            role: "assistant",
            content: content.length > 0 ? content : null,
            ...(reasoningContent.length > 0 ? { reasoningContent } : {}),
            toolCalls: calls.map(safeToolCallForDisplay),
          });
          for (const item of orderedResults) {
            transcript.push({
              role: "tool",
              toolCallId: item.call.id,
              content: serializeToolResult(
                item.result,
                budgetGuidance.get(item.call.id),
                this.completionTracker.evidenceId(item.call.id),
                item.call.name,
              ),
            });
          }
        }
        if (budgetStopDetail !== undefined) {
          yield interrupt("repeated-tool-failure", budgetStopDetail);
          return;
        }
        if (
          allUnknown &&
          consecutiveUnknownIterations >= UNKNOWN_TOOL_ITERATION_LIMIT
        ) {
          yield interrupt(
            "repeated-unknown-tool",
            "模型连续请求未知工具，Agent 已安全停止。",
          );
          return;
        }
      }
      throw new Error("Agent 循环越过了最大迭代边界。");
    } catch (error) {
      if (runtimeExceeded()) {
        yield interrupt("max-runtime", runtimeDetail);
        return;
      }
      if (
        options.signal.aborted ||
        (error instanceof ProviderError && error.kind === "cancelled")
      ) {
        yield interrupt("cancelled", "Agent 轮次已取消。");
        return;
      }
      if (error instanceof ContextManagementError) {
        const circuitOpen =
          this.contextManager?.snapshot().consecutiveSummaryFailures === 3;
        const reason = circuitOpen
          ? "context-circuit-open"
          : error.kind === "capacity"
            ? "context-capacity"
            : "context-error";
        yield interrupt(reason, error.message);
        return;
      }
      if (error instanceof ProviderError) {
        yield interrupt("model-error", error.message);
        return;
      }
      yield interrupt("agent-error", "Agent 执行发生未知错误，请重试。");
    } finally {
      if (this.contextManager && contextTurnActive) {
        const terminal = interruption ?? {
          reason: runtimeExceeded()
            ? "max-runtime" as const
            : options.signal.aborted
              ? "cancelled" as const
              : "agent-error" as const,
          detail: runtimeExceeded()
            ? runtimeDetail
            : options.signal.aborted
            ? "Agent 轮次已取消。"
            : "Agent 轮次在完成前中断。",
        };
        await this.contextManager.commitInterruptedTurn({
          ...terminal,
          partialAssistantContent,
          sideEffect,
        });
        this.history = [...this.contextManager.getPlainHistory()];
      }
      this.state = "idle";
    }
  }

  private async *collectModelResponse(
    messages: readonly ConversationMessage[],
    tools: readonly ReturnType<ToolAccess["definitions"]>[number][],
    signal: AbortSignal,
    iteration: number,
  ): AsyncIterable<
    | {
        readonly type: "model-progress";
        readonly progress: Extract<ModelStreamEvent, { type: "request-progress" }>;
      }
    | { readonly type: "agent-text"; readonly text: string }
    | { readonly type: "model-reasoning"; readonly text: string }
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
      tools,
      toolChoice: tools.length > 0 ? "auto" : "none",
    })) {
      if (signal.aborted) {
        throw new ProviderError("cancelled", "模型请求已取消。");
      }
      if (completed && event.type !== "usage") {
        throw new ProviderError("protocol", "模型在完成事件后仍返回了数据。");
      }
      if (event.type === "request-progress") {
        yield { type: "model-progress", progress: event };
      } else if (event.type === "reasoning-delta") {
        yield { type: "model-reasoning", text: event.text };
      } else if (event.type === "text-delta") {
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

export function assertMaxAgentIterations(value: AgentIterationLimit): void {
  if (
    value !== "unlimited" &&
    (!Number.isInteger(value) || value < 1 || value > MAX_AGENT_ITERATIONS)
  ) {
    throw new AgentConfigurationError(
      `Agent 最大迭代次数必须是 1 到 ${MAX_AGENT_ITERATIONS} 之间的整数。`,
    );
  }
}

export function assertMaxAgentRuntime(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_AGENT_RUNTIME_MS) {
    throw new AgentConfigurationError(
      `Agent 最大运行时间必须是 1 到 ${MAX_AGENT_RUNTIME_MS} 毫秒之间的整数。`,
    );
  }
}

function formatRuntimeLimit(runtimeMs: number): string {
  if (runtimeMs % (60 * 60 * 1_000) === 0) {
    return `${runtimeMs / (60 * 60 * 1_000)} 小时`;
  }
  if (runtimeMs % (60 * 1_000) === 0) return `${runtimeMs / (60 * 1_000)} 分钟`;
  if (runtimeMs % 1_000 === 0) return `${runtimeMs / 1_000} 秒`;
  return `${runtimeMs} 毫秒`;
}

function stopped(
  reason: AgentStopReason,
  iterations: number,
  durationMs: number,
  sideEffect: SideEffectState,
  detail: string,
  verification: ReturnType<CompletionTracker["assessment"]>,
): Extract<AgentEvent, { type: "stopped" }> {
  return {
    type: "stopped",
    reason,
    iterations,
    durationMs,
    sideEffect,
    detail,
    verification,
  };
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

function cancelledToolResults(
  calls: readonly ModelToolCall[],
  completed: readonly ToolCallResult[],
  message: string,
): readonly ToolCallResult[] {
  const completedById = new Map(
    completed.map((item) => [item.call.id, item] as const),
  );
  return calls.map((call, sequence) => completedById.get(call.id) ?? {
    call,
    sequence,
    result: toolFailure("cancelled", message, { retryable: true }),
  });
}

function toContextToolResult(
  item: ToolCallResult,
  guidance?: string,
  evidenceId?: string,
): {
  readonly toolCallId: string;
  readonly content: string;
} {
  return {
    toolCallId: item.call.id,
    content: serializeToolResult(item.result, guidance, evidenceId, item.call.name),
  };
}

function serializeToolResult(
  result: ToolCallResult["result"],
  guidance?: string,
  evidenceId?: string,
  toolName?: string,
): string {
  const modelResult = toolName?.startsWith("mcp__") ? mcpResultForModel(result) : result;
  return JSON.stringify({
    ...modelResult,
    ...(evidenceId === undefined ? {} : { evidence_call_id: evidenceId }),
    ...(guidance === undefined
      ? {}
      : { failureBudget: { action: "switch-strategy", guidance } }),
  });
}
