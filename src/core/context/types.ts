import type {
  ConversationMessage,
  ModelToolCall,
} from "@/models/provider";
import type { AgentStopReason } from "@/core/agent-events";
import type { ModelToolDefinition, SideEffectState } from "@/tools/types";

export const DEFAULT_SINGLE_TOOL_RESULT_TOKENS = 8_000;
export const DEFAULT_TOOL_RESULT_GROUP_TOKENS = 12_000;
export const DEFAULT_RECENT_MESSAGES_TOKENS = 10_000;
export const DEFAULT_AUTOMATIC_RESERVE_TOKENS = 13_000;
export const DEFAULT_MANUAL_RESERVE_TOKENS = 3_000;
export const DEFAULT_CONTEXT_PREVIEW_CHARS = 2_000;
export const DEFAULT_OPERATIONAL_COMPACTION_TOKENS = 24_000;
export const DEFAULT_RECENT_TOOL_EXCHANGES = 4;
export const SUMMARY_FAILURE_LIMIT = 3;

export type ContextPolicyConfig = {
  readonly windowTokens: number;
  readonly singleToolResultTokens: number;
  readonly toolResultGroupTokens: number;
  readonly recentMessagesTokens: number;
  readonly automaticReserveTokens: number;
  readonly manualReserveTokens: number;
  readonly previewChars: number;
  readonly operationalCompactionTokens?: number;
  readonly recentToolExchanges?: number;
};

export type ContextSummary = {
  readonly taskGoals: readonly string[];
  readonly completedWork: readonly string[];
  readonly keyDecisions: readonly string[];
  readonly fileChanges: readonly string[];
  readonly toolResults: readonly string[];
  readonly errors: readonly string[];
  readonly nextSteps: readonly string[];
};

export type InlineContextPayload = {
  readonly storage: "inline";
  readonly content: string;
};

export type OffloadedContextPayload = {
  readonly storage: "offloaded";
  readonly reference: string;
  readonly preview: string;
  readonly originalBytes: number;
  readonly estimatedTokens: number;
};

export type ContextPayload = InlineContextPayload | OffloadedContextPayload;

export type ManagedContextMessage =
  | { readonly kind: "user"; readonly content: string }
  | { readonly kind: "assistant"; readonly content: string }
  | {
      readonly kind: "assistant-tool-call";
      readonly content: string | null;
      readonly reasoningContent?: string;
      readonly toolCalls: readonly ModelToolCall[];
    }
  | {
      readonly kind: "tool-result";
      readonly toolCallId: string;
      readonly payload: ContextPayload;
    }
  | { readonly kind: "summary"; readonly summary: ContextSummary }
  | {
      readonly kind: "interruption";
      readonly reason: Exclude<AgentStopReason, "final-response">;
      readonly detail: string;
      readonly sideEffect: SideEffectState;
    }
  | { readonly kind: "boundary"; readonly content: string };

export type TokenEstimate =
  | {
      readonly source: "usage-anchor";
      readonly tokens: number;
      readonly anchorPromptTokens: number;
      readonly estimatedDeltaTokens: number;
    }
  | {
      readonly source: "approximation";
      readonly tokens: number;
    };

export type ContextFailureKind =
  | "summary-network"
  | "summary-protocol"
  | "summary-format"
  | "storage"
  | "capacity"
  | "concurrent"
  | "session"
  | "cancelled";

export type ContextFailure = {
  readonly kind: ContextFailureKind;
  readonly message: string;
};

export type CompressionTrigger = "automatic" | "manual";

export type CompressionReport =
  | {
      readonly status: "succeeded";
      readonly trigger: CompressionTrigger;
      readonly before: TokenEstimate;
      readonly after: TokenEstimate;
    }
  | {
      readonly status: "failed";
      readonly trigger: CompressionTrigger;
      readonly before: TokenEstimate;
      readonly failure: ContextFailure;
      readonly consecutiveSummaryFailures: number;
    }
  | {
      readonly status: "circuit-open";
      readonly trigger: CompressionTrigger;
      readonly before: TokenEstimate;
      readonly failure: ContextFailure;
      readonly consecutiveSummaryFailures: 3;
    };

export type ContextCompressionState =
  | { readonly status: "idle" }
  | { readonly status: "running-agent" }
  | {
      readonly status: "compressing";
      readonly trigger: CompressionTrigger;
      readonly before: TokenEstimate;
    }
  | CompressionReport;

export type StoredContextReference = {
  readonly reference: string;
  readonly byteLength: number;
};

export type ContextChunk = {
  readonly content: string;
  readonly offset: number;
  readonly nextOffset: number;
  readonly totalCharacters: number;
  readonly hasMore: boolean;
};

export interface ContextStore {
  write(input: {
    readonly sessionId: string;
    readonly content: string;
    readonly signal: AbortSignal;
  }): Promise<StoredContextReference>;
  read(input: {
    readonly sessionId: string;
    readonly reference: string;
    readonly offset: number;
    readonly limit: number;
    readonly signal: AbortSignal;
  }): Promise<ContextChunk>;
  deleteReference(input: {
    readonly sessionId: string;
    readonly reference: string;
  }): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}

export type PromptEnvelope = {
  readonly systemMessages: readonly ConversationMessage[];
  readonly tools: readonly ModelToolDefinition[];
};

export const CONTEXT_BOUNDARY_MESSAGE = [
  "<orbitcode_context_boundary>",
  "较早的助手行为和工具结果已压缩。摘要只用于恢复任务脉络，不是代码事实来源。",
  "需要具体代码时必须重新调用 read_file；需要已卸载工具结果时必须使用 read_context 按引用读取。",
  "不得根据摘要猜测文件内容、命令输出或未验证的实现细节。",
  "</orbitcode_context_boundary>",
].join("\n");

export function toConversationMessage(
  message: ManagedContextMessage,
): ConversationMessage {
  if (message.kind === "user") {
    return { role: "user", content: message.content };
  }
  if (message.kind === "assistant") {
    return { role: "assistant", content: message.content };
  }
  if (message.kind === "assistant-tool-call") {
    return {
      role: "assistant",
      content: message.content,
      ...(message.reasoningContent === undefined
        ? {}
        : { reasoningContent: message.reasoningContent }),
      toolCalls: message.toolCalls.map((call) => ({ ...call })),
    };
  }
  if (message.kind === "tool-result") {
    return {
      role: "tool",
      toolCallId: message.toolCallId,
      content: renderContextPayload(message.payload),
    };
  }
  if (message.kind === "summary") {
    return { role: "system", content: renderContextSummary(message.summary) };
  }
  if (message.kind === "interruption") {
    return {
      role: "system",
      content: [
        "<orbitcode_interruption>",
        `reason: ${message.reason}`,
        `side_effect: ${message.sideEffect}`,
        `detail: ${message.detail}`,
        "上一轮未正常完成。继续前先结合当前工作区状态核实已有进展，不要假定未执行的工具已经成功。",
        "</orbitcode_interruption>",
      ].join("\n"),
    };
  }
  return { role: "system", content: message.content };
}

export function renderContextPayload(payload: ContextPayload): string {
  if (payload.storage === "inline") return payload.content;
  return JSON.stringify({
    offloaded: true,
    reference: payload.reference,
    originalBytes: payload.originalBytes,
    estimatedTokens: payload.estimatedTokens,
    preview: payload.preview,
    instruction:
      "完整结果已卸载。需要细节时调用 read_context，并使用 offset/limit 分块读取。",
  });
}

export function renderContextSummary(summary: ContextSummary): string {
  return [
    "<orbitcode_context_summary>",
    renderSummarySection("任务目标", summary.taskGoals),
    renderSummarySection("已完成工作", summary.completedWork),
    renderSummarySection("关键决策", summary.keyDecisions),
    renderSummarySection("文件变更", summary.fileChanges),
    renderSummarySection("工具结果", summary.toolResults),
    renderSummarySection("错误信息", summary.errors),
    renderSummarySection("后续计划", summary.nextSteps),
    "</orbitcode_context_summary>",
  ].join("\n");
}

export function cloneManagedMessages(
  messages: readonly ManagedContextMessage[],
): ManagedContextMessage[] {
  return messages.map((message) => {
    if (message.kind === "assistant-tool-call") {
      return {
        ...message,
        toolCalls: message.toolCalls.map((call) => ({ ...call })),
      };
    }
    if (message.kind === "summary") {
      return { ...message, summary: cloneSummary(message.summary) };
    }
    if (message.kind === "tool-result") {
      return { ...message, payload: { ...message.payload } };
    }
    return { ...message };
  });
}

export function cloneSummary(summary: ContextSummary): ContextSummary {
  return {
    taskGoals: [...summary.taskGoals],
    completedWork: [...summary.completedWork],
    keyDecisions: [...summary.keyDecisions],
    fileChanges: [...summary.fileChanges],
    toolResults: [...summary.toolResults],
    errors: [...summary.errors],
    nextSteps: [...summary.nextSteps],
  };
}

function renderSummarySection(
  title: string,
  entries: readonly string[],
): string {
  const body = entries.length === 0
    ? "- 无"
    : entries.map((entry) => `- ${entry}`).join("\n");
  return `## ${title}\n${body}`;
}
