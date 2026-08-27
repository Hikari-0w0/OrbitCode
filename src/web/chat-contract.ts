import type { ConversationMessage } from "@/models/provider";
import { parseServerSentEvents, SseError } from "@/models/sse";

export const MAX_WEB_CHAT_BODY_BYTES = 256 * 1024;
export const MAX_WEB_CHAT_MESSAGES = 50;
export const MAX_WEB_CHAT_MESSAGE_LENGTH = 20_000;

export type WebChatRequest = {
  readonly provider: string;
  readonly messages: readonly ConversationMessage[];
};

export type WebChatEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "completed" }
  | { readonly type: "failed"; readonly message: string };

export type ProviderSummary = {
  readonly name: string;
  readonly model: string;
  readonly available: boolean;
};

export type ProviderCatalogResponse = {
  readonly providers: readonly ProviderSummary[];
};

export type WebApiError = {
  readonly error: string;
};

export class WebChatContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebChatContractError";
  }
}

export function parseWebChatRequest(value: unknown): WebChatRequest {
  if (!isRecord(value) || !hasExactFields(value, ["provider", "messages"])) {
    throw new WebChatContractError("对话请求格式无效。");
  }
  if (typeof value.provider !== "string" || value.provider.trim().length === 0) {
    throw new WebChatContractError("必须选择模型配置。");
  }
  if (value.provider.length > 128) {
    throw new WebChatContractError("模型配置名称过长。");
  }
  if (
    !Array.isArray(value.messages) ||
    value.messages.length === 0 ||
    value.messages.length > MAX_WEB_CHAT_MESSAGES
  ) {
    throw new WebChatContractError(
      `对话消息数量必须在 1 到 ${MAX_WEB_CHAT_MESSAGES} 之间。`,
    );
  }

  const messages = value.messages.map((message, index) =>
    parseMessage(message, index),
  );
  for (const [index, message] of messages.entries()) {
    const expectedRole = index % 2 === 0 ? "user" : "assistant";
    if (message.role !== expectedRole) {
      throw new WebChatContractError("对话消息角色顺序无效。");
    }
  }
  if (messages.at(-1)?.role !== "user") {
    throw new WebChatContractError("对话请求必须以用户消息结束。");
  }

  return { provider: value.provider.trim(), messages };
}

export function encodeWebChatEvent(event: WebChatEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export function parseProviderCatalogResponse(
  value: unknown,
): ProviderCatalogResponse {
  if (!isRecord(value) || !hasExactFields(value, ["providers"])) {
    throw new WebChatContractError("服务端返回了无效的模型配置列表。");
  }
  if (!Array.isArray(value.providers)) {
    throw new WebChatContractError("服务端返回了无效的模型配置列表。");
  }
  const providers = value.providers.map((provider) => {
    if (
      !isRecord(provider) ||
      !hasExactFields(provider, ["name", "model", "available"]) ||
      typeof provider.name !== "string" ||
      typeof provider.model !== "string" ||
      typeof provider.available !== "boolean"
    ) {
      throw new WebChatContractError("服务端返回了无效的模型配置列表。");
    }
    return {
      name: provider.name,
      model: provider.model,
      available: provider.available,
    };
  });
  return { providers };
}

export function parseWebApiError(value: unknown): WebApiError | undefined {
  if (
    isRecord(value) &&
    hasExactFields(value, ["error"]) &&
    typeof value.error === "string" &&
    value.error.length > 0
  ) {
    return { error: value.error };
  }
  return undefined;
}

export async function* parseWebChatEvents(
  chunks: AsyncIterable<Uint8Array>,
): AsyncIterable<WebChatEvent> {
  try {
    for await (const data of parseServerSentEvents(chunks)) {
      let value: unknown;
      try {
        value = JSON.parse(data);
      } catch {
        throw new WebChatContractError("服务端返回了无效的流式事件。");
      }
      yield parseWebChatEvent(value);
    }
  } catch (error) {
    if (error instanceof WebChatContractError) {
      throw error;
    }
    if (error instanceof SseError) {
      throw new WebChatContractError(error.message);
    }
    throw new WebChatContractError("无法读取服务端流式响应。");
  }
}

export async function* readWebStream(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) return;
      yield result.value;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseMessage(value: unknown, index: number): ConversationMessage {
  if (!isRecord(value) || !hasExactFields(value, ["role", "content"])) {
    throw new WebChatContractError(`messages[${index}] 格式无效。`);
  }
  if (value.role !== "user" && value.role !== "assistant") {
    throw new WebChatContractError(`messages[${index}].role 无效。`);
  }
  if (
    typeof value.content !== "string" ||
    (value.role === "user" && value.content.trim().length === 0)
  ) {
    throw new WebChatContractError(`messages[${index}].content 不能为空。`);
  }
  if (value.content.length > MAX_WEB_CHAT_MESSAGE_LENGTH) {
    throw new WebChatContractError(
      `messages[${index}].content 超过 ${MAX_WEB_CHAT_MESSAGE_LENGTH} 个字符。`,
    );
  }
  return { role: value.role, content: value.content };
}

function parseWebChatEvent(value: unknown): WebChatEvent {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new WebChatContractError("服务端返回了无效的流式事件。");
  }
  if (value.type === "completed" && hasExactFields(value, ["type"])) {
    return { type: "completed" };
  }
  if (
    value.type === "text-delta" &&
    hasExactFields(value, ["type", "text"]) &&
    typeof value.text === "string"
  ) {
    return { type: "text-delta", text: value.text };
  }
  if (
    value.type === "failed" &&
    hasExactFields(value, ["type", "message"]) &&
    typeof value.message === "string" &&
    value.message.length > 0
  ) {
    return { type: "failed", message: value.message };
  }
  throw new WebChatContractError("服务端返回了无效的流式事件。");
}

function hasExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => field in value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
