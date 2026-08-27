import type { ModelToolDefinition } from "@/tools/types";

export type PlainConversationMessage =
  | { readonly role: "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string };

export type ModelToolCall = {
  readonly id: string;
  readonly name: string;
  readonly argumentsJson: string;
};

export type ConversationMessage =
  | PlainConversationMessage
  | {
      readonly role: "assistant";
      readonly content: null;
      readonly toolCalls: readonly [ModelToolCall];
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

export type ModelStreamEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "tool-call"; readonly call: ModelToolCall }
  | {
      readonly type: "done";
      readonly finishReason: "stop" | "tool-call";
    };

export type ProviderFailureKind =
  | "network"
  | "http"
  | "protocol"
  | "stream"
  | "cancelled";

export type ProviderErrorOptions = {
  readonly status?: number;
  readonly requestId?: string;
  readonly cause?: unknown;
};

export class ProviderError extends Error {
  readonly kind: ProviderFailureKind;
  readonly status?: number;
  readonly requestId?: string;

  constructor(
    kind: ProviderFailureKind,
    message: string,
    options: ProviderErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ProviderError";
    this.kind = kind;
    this.status = options.status;
    this.requestId = options.requestId;
  }
}

export interface ChatProvider {
  stream(
    messages: readonly ConversationMessage[],
    options: {
      readonly signal: AbortSignal;
      readonly tools?: readonly ModelToolDefinition[];
      readonly toolChoice: "auto" | "none";
    },
  ): AsyncIterable<ModelStreamEvent>;
}
