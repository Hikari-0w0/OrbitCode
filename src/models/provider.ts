export type ConversationMessage =
  | { readonly role: "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string };

export type AssistantMessage = Extract<
  ConversationMessage,
  { readonly role: "assistant" }
>;

export type ModelStreamEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "done" };

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
    options: { readonly signal: AbortSignal },
  ): AsyncIterable<ModelStreamEvent>;
}
