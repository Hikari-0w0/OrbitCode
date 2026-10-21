import type { ModelToolDefinition } from "@/tools/types";

export const MAX_MODEL_OUTPUT_TOKENS = 1_048_576;

export type ProviderFinishReason = "length" | "content_filter" | "insufficient_system_resource" | "aborted" | "unsupported";

export type ModelThinkingConfig = {
  readonly enabled: boolean;
  readonly budgetTokens?: number;
  readonly apiStyle?: "siliconflow" | "deepseek";
};

export type ModelRequestStage =
  | "waiting-first-byte"
  | "streaming-text"
  | "streaming-tool-arguments"
  | "waiting-done";

export type ProviderTimeoutPhase = "first-byte" | "idle" | "total";

export type ProviderTransportPolicy = {
  readonly firstByteTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly maxRetries: number;
};

export type PlainConversationMessage =
  | { readonly role: "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string };

export type SystemMessage = {
  readonly role: "system";
  readonly content: string;
};

export type ModelToolCall = {
  readonly id: string;
  readonly name: string;
  readonly argumentsJson: string;
};

export type ConversationMessage =
  | SystemMessage
  | PlainConversationMessage
  | {
      readonly role: "assistant";
      readonly content: string | null;
      readonly reasoningContent?: string;
      readonly toolCalls: readonly ModelToolCall[];
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly content: string;
    };

export type AssistantMessage = Extract<
  PlainConversationMessage,
  { readonly role: "assistant" }
>;

export type PromptCacheUsage =
  | { readonly availability: "tokens"; readonly cachedTokens: number }
  | { readonly availability: "status"; readonly hit: boolean }
  | { readonly availability: "unavailable" };

export type ModelTokenUsage = {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly promptCache: PromptCacheUsage;
};

export type ModelStreamEvent =
  | {
      readonly type: "request-progress";
      readonly stage: ModelRequestStage;
      readonly elapsedMs: number;
      readonly attempt: number;
      readonly traceId?: string;
      readonly toolName?: string;
      readonly toolArgumentsChars?: number;
    }
  | { readonly type: "reasoning-delta"; readonly text: string }
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "tool-call"; readonly call: ModelToolCall }
  | { readonly type: "usage"; readonly usage: ModelTokenUsage }
  | {
      readonly type: "done";
      readonly finishReason: "stop" | "tool-call";
    };

export type ProviderFailureKind =
  | "network"
  | "http"
  | "protocol"
  | "stream"
  | "timeout"
  | "budget"
  | "cancelled";

export type ProviderErrorOptions = {
  readonly status?: number;
  readonly traceId?: string;
  readonly timeoutPhase?: ProviderTimeoutPhase;
  readonly retryable?: boolean;
  readonly finishReason?: ProviderFinishReason;
  readonly cause?: unknown;
};

export class ProviderError extends Error {
  readonly kind: ProviderFailureKind;
  readonly status?: number;
  readonly traceId?: string;
  readonly timeoutPhase?: ProviderTimeoutPhase;
  readonly retryable: boolean;
  readonly finishReason?: ProviderFinishReason;

  constructor(
    kind: ProviderFailureKind,
    message: string,
    options: ProviderErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ProviderError";
    this.kind = kind;
    this.status = options.status;
    this.traceId = options.traceId;
    this.timeoutPhase = options.timeoutPhase;
    this.finishReason = options.finishReason;
    this.retryable =
      options.retryable ??
      (kind === "network" || kind === "stream" || kind === "timeout");
  }
}

export interface ChatProvider {
  readonly supportsRequestTokenLimit?: boolean;
  stream(
    messages: readonly ConversationMessage[],
    options: {
      readonly signal: AbortSignal;
      readonly tools?: readonly ModelToolDefinition[];
      readonly toolChoice: "auto" | "none";
      readonly beforeRequest?: (attempt: number) => void;
      readonly maxOutputTokens?: number;
    },
  ): AsyncIterable<ModelStreamEvent>;
}
