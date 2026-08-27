import type { PlainConversationMessage } from "@/models/provider";
import { parseServerSentEvents, SseError } from "@/models/sse";
import type {
  JsonValue,
  SchemaIssue,
  SideEffectState,
  ToolErrorKind,
  ToolExecutionError,
  ToolExecutionResult,
  ToolName,
  ToolResultMeta,
} from "@/tools/types";

export const MAX_WEB_CHAT_BODY_BYTES = 256 * 1024;
export const MAX_WEB_CHAT_MESSAGES = 50;
export const MAX_WEB_CHAT_MESSAGE_LENGTH = 20_000;

export type WebChatRequest = {
  readonly provider: string;
  readonly messages: readonly PlainConversationMessage[];
};

export type WebChatEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | {
      readonly type: "tool-started";
      readonly callId: string;
      readonly name: ToolName;
    }
  | {
      readonly type: "tool-completed";
      readonly callId: string;
      readonly name: ToolName;
      readonly result: ToolExecutionResult;
    }
  | { readonly type: "completed"; readonly content: string }
  | {
      readonly type: "failed";
      readonly message: string;
      readonly sideEffect: SideEffectState;
    };

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

function parseMessage(value: unknown, index: number): PlainConversationMessage {
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
  if (
    value.type === "completed" &&
    hasExactFields(value, ["type", "content"]) &&
    typeof value.content === "string"
  ) {
    return { type: "completed", content: value.content };
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
    hasExactFields(value, ["type", "message", "sideEffect"]) &&
    typeof value.message === "string" &&
    value.message.length > 0 &&
    isSideEffectState(value.sideEffect)
  ) {
    return {
      type: "failed",
      message: value.message,
      sideEffect: value.sideEffect,
    };
  }
  if (
    value.type === "tool-started" &&
    hasExactFields(value, ["type", "callId", "name"]) &&
    isSafeCallId(value.callId) &&
    isToolName(value.name)
  ) {
    return { type: "tool-started", callId: value.callId, name: value.name };
  }
  if (
    value.type === "tool-completed" &&
    hasExactFields(value, ["type", "callId", "name", "result"]) &&
    isSafeCallId(value.callId) &&
    isToolName(value.name)
  ) {
    return {
      type: "tool-completed",
      callId: value.callId,
      name: value.name,
      result: parseToolResult(value.result),
    };
  }
  throw new WebChatContractError("服务端返回了无效的流式事件。");
}

function parseToolResult(value: unknown): ToolExecutionResult {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new WebChatContractError("服务端返回了无效的工具结果。");
  }
  const sideEffect = value.sideEffect;
  if (!isSideEffectState(sideEffect)) {
    throw new WebChatContractError("服务端返回了无效的工具结果。");
  }
  const meta = parseToolMeta(value.meta);
  if (value.ok) {
    if (!hasExactFields(value, ["ok", "output", "sideEffect", "meta"]) || !isJsonValue(value.output)) {
      throw new WebChatContractError("服务端返回了无效的工具结果。");
    }
    return { ok: true, output: value.output, sideEffect, meta };
  }
  const allowed = value.output === undefined
    ? ["ok", "error", "sideEffect", "meta"]
    : ["ok", "error", "output", "sideEffect", "meta"];
  if (!hasExactFields(value, allowed)) {
    throw new WebChatContractError("服务端返回了无效的工具结果。");
  }
  const error = parseToolError(value.error);
  if (value.output !== undefined && !isJsonValue(value.output)) {
    throw new WebChatContractError("服务端返回了无效的工具结果。");
  }
  return value.output === undefined
    ? { ok: false, error, sideEffect, meta }
    : { ok: false, error, output: value.output, sideEffect, meta };
}

function parseToolMeta(value: unknown): ToolResultMeta {
  if (
    !isRecord(value) ||
    !hasExactFields(value, ["durationMs", "truncated", "truncatedFields"]) ||
    typeof value.durationMs !== "number" ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0 ||
    typeof value.truncated !== "boolean" ||
    !Array.isArray(value.truncatedFields) ||
    !value.truncatedFields.every((entry) => typeof entry === "string")
  ) {
    throw new WebChatContractError("服务端返回了无效的工具结果元数据。");
  }
  return {
    durationMs: value.durationMs,
    truncated: value.truncated,
    truncatedFields: value.truncatedFields,
  };
}

function parseToolError(value: unknown): ToolExecutionError {
  if (!isRecord(value)) {
    throw new WebChatContractError("服务端返回了无效的工具错误。");
  }
  const allowed = value.issues === undefined
    ? ["kind", "message", "retryable"]
    : ["kind", "message", "retryable", "issues"];
  if (
    !hasExactFields(value, allowed) ||
    !isToolErrorKind(value.kind) ||
    typeof value.message !== "string" ||
    value.message.length === 0 ||
    typeof value.retryable !== "boolean"
  ) {
    throw new WebChatContractError("服务端返回了无效的工具错误。");
  }
  let issues: readonly SchemaIssue[] | undefined;
  if (value.issues !== undefined) {
    if (!Array.isArray(value.issues) || value.issues.length > 20) {
      throw new WebChatContractError("服务端返回了无效的工具错误。");
    }
    issues = value.issues.map((entry) => {
      if (
        !isRecord(entry) ||
        !hasExactFields(entry, ["path", "message"]) ||
        typeof entry.path !== "string" ||
        typeof entry.message !== "string"
      ) {
        throw new WebChatContractError("服务端返回了无效的工具错误。");
      }
      return { path: entry.path, message: entry.message };
    });
  }
  return { kind: value.kind, message: value.message, retryable: value.retryable, issues };
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 20) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, depth + 1));
  return (
    isRecord(value) &&
    Object.keys(value).length <= 2_000 &&
    Object.values(value).every((entry) => isJsonValue(entry, depth + 1))
  );
}

function isSafeCallId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function isSideEffectState(value: unknown): value is SideEffectState {
  return value === "none" || value === "possible" || value === "applied";
}

const TOOL_NAMES = new Set<ToolName>([
  "read_file",
  "write_file",
  "edit_file",
  "run_command",
  "find_files",
  "search_code",
]);

function isToolName(value: unknown): value is ToolName {
  return typeof value === "string" && TOOL_NAMES.has(value as ToolName);
}

const TOOL_ERROR_KINDS = new Set<ToolErrorKind>([
  "invalid-arguments",
  "not-found",
  "permission-denied",
  "protected-path",
  "conflict",
  "unsupported-content",
  "limit-exceeded",
  "sandbox-unavailable",
  "command-failed",
  "timeout",
  "cancelled",
  "execution-failed",
]);

function isToolErrorKind(value: unknown): value is ToolErrorKind {
  return typeof value === "string" && TOOL_ERROR_KINDS.has(value as ToolErrorKind);
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
