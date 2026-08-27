import { ProviderError } from "@/models/provider";

export type RecoverableChatError =
  | { readonly kind: "network"; readonly message: string }
  | {
      readonly kind: "http";
      readonly status: number;
      readonly requestId?: string;
      readonly message: string;
    }
  | { readonly kind: "protocol"; readonly message: string }
  | { readonly kind: "stream"; readonly message: string };

export type RecoverableAgentError =
  | RecoverableChatError
  | { readonly kind: "agent"; readonly message: string };

export class ConversationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationStateError";
  }
}

export function toRecoverableChatError(error: unknown): RecoverableChatError {
  if (!(error instanceof ProviderError)) {
    return {
      kind: "stream",
      message: "模型响应发生未知错误，请重试。",
    };
  }

  if (error.kind === "http") {
    return {
      kind: "http",
      status: error.status ?? 0,
      requestId: error.requestId,
      message: error.message,
    };
  }

  if (error.kind === "cancelled") {
    return {
      kind: "stream",
      message: "模型请求已取消。",
    };
  }

  return {
    kind: error.kind,
    message: error.message,
  };
}

export function toRecoverableAgentError(error: unknown): RecoverableAgentError {
  if (error instanceof ProviderError) return toRecoverableChatError(error);
  if (error instanceof ConversationStateError) {
    return { kind: "agent", message: error.message };
  }
  return { kind: "agent", message: "Agent 执行发生未知错误，请重试。" };
}
