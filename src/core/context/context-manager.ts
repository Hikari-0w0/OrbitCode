import { ContextManagementError, contextFailure } from "@/core/context/context-errors";
import {
  compactOlderHistory,
  providerMessages,
} from "@/core/context/heavy-compaction";
import { compactToolResults } from "@/core/context/lightweight-compaction";
import {
  TokenEstimator,
  type TokenEstimatorState,
} from "@/core/context/token-estimator";
import { ToolFreeSummaryGenerator } from "@/core/context/tool-free-summary-generator";
import {
  SUMMARY_FAILURE_LIMIT,
  cloneManagedMessages,
  toConversationMessage,
  type CompressionReport,
  type ContextCompressionState,
  type ContextPolicyConfig,
  type ContextStore,
  type ManagedContextMessage,
  type PromptEnvelope,
  type TokenEstimate,
} from "@/core/context/types";
import type {
  ChatProvider,
  ConversationMessage,
  ModelToolCall,
  PlainConversationMessage,
} from "@/models/provider";
import type { AgentStopReason } from "@/core/agent-events";
import type { SideEffectState } from "@/tools/types";

type ActiveTurn = {
  messages: ManagedContextMessage[];
  readonly originalEstimatorState: TokenEstimatorState;
  readonly createdReferences: string[];
  readonly retiredReferences: string[];
  lastEnvelope?: PromptEnvelope;
};

export type PreparedContext = {
  readonly messages: readonly ConversationMessage[];
  readonly estimate: TokenEstimate;
};

export type ContextManagerSnapshot = {
  readonly messages: readonly ManagedContextMessage[];
  readonly compression: ContextCompressionState;
  readonly consecutiveSummaryFailures: number;
};

export class ContextManager {
  private committed: ManagedContextMessage[];
  private readonly estimator = new TokenEstimator();
  private readonly generator: ToolFreeSummaryGenerator;
  private activeTurn?: ActiveTurn;
  private lastEnvelope?: PromptEnvelope;
  private lastCompression: ContextCompressionState = { status: "idle" };
  private consecutiveSummaryFailures = 0;

  constructor(
    private readonly options: {
      readonly sessionId: string;
      readonly config: ContextPolicyConfig;
      readonly store: ContextStore;
      readonly provider: ChatProvider;
      readonly initialHistory?: readonly PlainConversationMessage[];
    },
  ) {
    this.generator = new ToolFreeSummaryGenerator(options.provider);
    this.committed = (options.initialHistory ?? []).map((message) => ({
      kind: message.role,
      content: message.content,
    }));
  }

  beginTurn(userContent: string): void {
    if (this.activeTurn) {
      throw new ContextManagementError("concurrent", "当前上下文会话已有进行中的 Agent 轮次。");
    }
    this.activeTurn = {
      messages: [
        ...cloneManagedMessages(this.committed),
        { kind: "user", content: userContent },
      ],
      originalEstimatorState: this.estimator.snapshot(),
      createdReferences: [],
      retiredReferences: [],
      lastEnvelope: this.lastEnvelope,
    };
    this.lastCompression = { status: "running-agent" };
  }

  async prepareForModel(
    envelope: PromptEnvelope,
    signal: AbortSignal,
  ): Promise<PreparedContext> {
    const turn = this.requireTurn();
    turn.lastEnvelope = cloneEnvelope(envelope);
    const light = await compactToolResults({
      messages: turn.messages,
      sessionId: this.options.sessionId,
      config: this.options.config,
      store: this.options.store,
      signal,
    });
    turn.messages = cloneManagedMessages(light.messages);
    turn.createdReferences.push(...light.createdReferences);

    let messages = providerMessages(turn.messages, envelope);
    let estimate = this.estimator.estimate(messages, envelope.tools);
    if (
      estimate.tokens >=
      this.options.config.windowTokens - this.options.config.automaticReserveTokens
    ) {
      if (this.consecutiveSummaryFailures >= SUMMARY_FAILURE_LIMIT) {
        const failure = {
          kind: "capacity" as const,
          message: "上下文摘要已连续失败三次，自动压缩熔断已打开。",
        };
        this.lastCompression = {
          status: "circuit-open",
          trigger: "automatic",
          before: estimate,
          failure,
          consecutiveSummaryFailures: 3,
        };
        throw new ContextManagementError(failure.kind, failure.message);
      }
      const report = await this.compressTurn("automatic", envelope, signal, estimate);
      if (report.status !== "succeeded") {
        throw new ContextManagementError(report.failure.kind, report.failure.message, {
          summaryFailure:
            report.failure.kind === "summary-network" ||
            report.failure.kind === "summary-protocol" ||
            report.failure.kind === "summary-format",
        });
      }
      messages = providerMessages(turn.messages, envelope);
      estimate = report.after;
    }
    return { messages, estimate };
  }

  recordAgentUsage(promptTokens: number, envelope: PromptEnvelope): void {
    const turn = this.requireTurn();
    this.estimator.recordUsage(
      promptTokens,
      providerMessages(turn.messages, envelope),
      envelope.tools,
    );
  }

  appendToolExchange(
    content: string | null,
    calls: readonly ModelToolCall[],
    results: readonly { readonly toolCallId: string; readonly content: string }[],
    reasoningContent?: string,
  ): void {
    const turn = this.requireTurn();
    turn.messages.push({
      kind: "assistant-tool-call",
      content,
      ...(reasoningContent === undefined ? {} : { reasoningContent }),
      toolCalls: calls.map((call) => ({ ...call })),
    });
    for (const result of results) {
      turn.messages.push({
        kind: "tool-result",
        toolCallId: result.toolCallId,
        payload: { storage: "inline", content: result.content },
      });
    }
  }

  appendFinal(content: string): void {
    this.requireTurn().messages.push({ kind: "assistant", content });
  }

  async commitTurn(): Promise<void> {
    await this.commitActiveTurn();
  }

  async commitInterruptedTurn(input: {
    readonly reason: Exclude<AgentStopReason, "final-response">;
    readonly detail: string;
    readonly sideEffect: SideEffectState;
    readonly partialAssistantContent: string;
  }): Promise<void> {
    const turn = this.requireTurn();
    if (input.partialAssistantContent.length > 0) {
      turn.messages.push({
        kind: "assistant",
        content: input.partialAssistantContent,
      });
    }
    turn.messages.push({
      kind: "interruption",
      reason: input.reason,
      detail: input.detail,
      sideEffect: input.sideEffect,
    });
    await this.commitActiveTurn();
  }

  private async commitActiveTurn(): Promise<void> {
    const turn = this.requireTurn();
    this.committed = cloneManagedMessages(turn.messages);
    this.lastEnvelope = turn.lastEnvelope === undefined
      ? this.lastEnvelope
      : cloneEnvelope(turn.lastEnvelope);
    this.activeTurn = undefined;
    this.lastCompression = { status: "idle" };
    await this.deleteReferences(turn.retiredReferences);
  }

  async rollbackTurn(): Promise<void> {
    const turn = this.activeTurn;
    if (!turn) return;
    this.estimator.restore(turn.originalEstimatorState);
    this.activeTurn = undefined;
    this.lastCompression = this.consecutiveSummaryFailures >= SUMMARY_FAILURE_LIMIT
      ? {
          status: "circuit-open",
          trigger: "automatic",
          before: this.estimateCommitted(),
          failure: {
            kind: "capacity",
            message: "上下文摘要已连续失败三次，自动压缩熔断已打开。",
          },
          consecutiveSummaryFailures: 3,
        }
      : { status: "idle" };
    await this.deleteReferences(turn.createdReferences);
  }

  async compressManually(signal: AbortSignal): Promise<CompressionReport> {
    if (this.activeTurn) {
      const before = this.estimateCommitted();
      return {
        status: "failed",
        trigger: "manual",
        before,
        failure: { kind: "concurrent", message: "Agent 运行时不能手动压缩上下文。" },
        consecutiveSummaryFailures: this.consecutiveSummaryFailures,
      };
    }
    const envelope = this.lastEnvelope ?? { systemMessages: [], tools: [] };
    const before = this.estimator.estimate(
      providerMessages(this.committed, envelope),
      envelope.tools,
    );
    this.lastCompression = { status: "compressing", trigger: "manual", before };
    try {
      const compacted = await compactOlderHistory({
        messages: this.committed,
        envelope,
        config: this.options.config,
        estimator: this.estimator,
        generator: this.generator,
        trigger: "manual",
        signal,
      });
      this.committed = cloneManagedMessages(compacted.messages);
      this.consecutiveSummaryFailures = 0;
      const report: CompressionReport = {
        status: "succeeded",
        trigger: "manual",
        before: compacted.before,
        after: compacted.after,
      };
      this.lastCompression = report;
      await this.deleteReferences(compacted.retiredReferences);
      return report;
    } catch (error) {
      return this.recordCompressionFailure("manual", before, error);
    }
  }

  getModelHistory(): readonly ConversationMessage[] {
    return this.committed.map(toConversationMessage);
  }

  getPlainHistory(): readonly PlainConversationMessage[] {
    return this.committed.flatMap((message): readonly PlainConversationMessage[] => {
      if (message.kind === "user" || message.kind === "assistant") {
        return [{ role: message.kind, content: message.content }];
      }
      return [];
    });
  }

  snapshot(): ContextManagerSnapshot {
    return {
      messages: cloneManagedMessages(this.committed),
      compression: cloneCompressionState(this.lastCompression),
      consecutiveSummaryFailures: this.consecutiveSummaryFailures,
    };
  }

  private async compressTurn(
    trigger: "automatic",
    envelope: PromptEnvelope,
    signal: AbortSignal,
    before: TokenEstimate,
  ): Promise<CompressionReport> {
    const turn = this.requireTurn();
    this.lastCompression = { status: "compressing", trigger, before };
    try {
      const compacted = await compactOlderHistory({
        messages: turn.messages,
        envelope,
        config: this.options.config,
        estimator: this.estimator,
        generator: this.generator,
        trigger,
        signal,
      });
      turn.messages = cloneManagedMessages(compacted.messages);
      turn.retiredReferences.push(...compacted.retiredReferences);
      this.consecutiveSummaryFailures = 0;
      const report: CompressionReport = {
        status: "succeeded",
        trigger,
        before: compacted.before,
        after: compacted.after,
      };
      this.lastCompression = report;
      return report;
    } catch (error) {
      return this.recordCompressionFailure(trigger, before, error);
    }
  }

  private recordCompressionFailure(
    trigger: "automatic" | "manual",
    before: TokenEstimate,
    error: unknown,
  ): CompressionReport {
    if (error instanceof ContextManagementError && error.summaryFailure) {
      this.consecutiveSummaryFailures = Math.min(
        SUMMARY_FAILURE_LIMIT,
        this.consecutiveSummaryFailures + 1,
      );
    }
    const failure = contextFailure(error);
    if (this.consecutiveSummaryFailures >= SUMMARY_FAILURE_LIMIT) {
      const report: CompressionReport = {
        status: "circuit-open",
        trigger,
        before,
        failure,
        consecutiveSummaryFailures: 3,
      };
      this.lastCompression = report;
      return report;
    }
    const report: CompressionReport = {
      status: "failed",
      trigger,
      before,
      failure,
      consecutiveSummaryFailures: this.consecutiveSummaryFailures,
    };
    this.lastCompression = report;
    return report;
  }

  private estimateCommitted(): TokenEstimate {
    const envelope = this.lastEnvelope ?? { systemMessages: [], tools: [] };
    return this.estimator.estimate(
      providerMessages(this.committed, envelope),
      envelope.tools,
    );
  }

  private requireTurn(): ActiveTurn {
    if (!this.activeTurn) {
      throw new ContextManagementError("session", "当前上下文会话没有进行中的 Agent 轮次。");
    }
    return this.activeTurn;
  }

  private async deleteReferences(references: readonly string[]): Promise<void> {
    await Promise.all(
      [...new Set(references)].map((reference) =>
        this.options.store.deleteReference({
          sessionId: this.options.sessionId,
          reference,
        }).catch(() => undefined),
      ),
    );
  }
}

function cloneEnvelope(envelope: PromptEnvelope): PromptEnvelope {
  return {
    systemMessages: envelope.systemMessages.map((message) => ({ ...message })),
    tools: envelope.tools.map((tool) => ({
      ...tool,
      function: {
        ...tool.function,
        parameters: { ...tool.function.parameters },
      },
    })),
  };
}

function cloneCompressionState(
  state: ContextCompressionState,
): ContextCompressionState {
  if (state.status === "idle" || state.status === "running-agent") return { ...state };
  if (state.status === "compressing" || state.status === "succeeded") {
    return { ...state, before: { ...state.before }, ...(state.status === "succeeded" ? { after: { ...state.after } } : {}) };
  }
  return {
    ...state,
    before: { ...state.before },
    failure: { ...state.failure },
  };
}
