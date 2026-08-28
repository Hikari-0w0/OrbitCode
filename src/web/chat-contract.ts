import type {
  AgentEvent,
  AgentMode,
  AgentStopReason,
  TokenUsage,
} from "@/core/agent-events";
import type {
  ModelToolCall,
  PlainConversationMessage,
} from "@/models/provider";
import { parseServerSentEvents, SseError } from "@/models/sse";
import type {
  JsonValue,
  SchemaIssue,
  SideEffectState,
  ToolErrorKind,
  ToolExecutionError,
  ToolExecutionResult,
  ToolResultMeta,
} from "@/tools/types";

export const MAX_WEB_CHAT_BODY_BYTES = 256 * 1024;
export const MAX_WEB_CHAT_MESSAGES = 50;
export const MAX_WEB_CHAT_MESSAGE_LENGTH = 20_000;

export type WebChatRequest = {
  readonly provider: string;
  readonly mode: AgentMode;
  readonly messages: readonly PlainConversationMessage[];
};

export type WebChatEvent = AgentEvent;

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
  if (!isRecord(value) || !hasExactFields(value, ["provider", "mode", "messages"])) {
    throw new WebChatContractError("对话请求格式无效。");
  }
  if (typeof value.provider !== "string" || value.provider.trim().length === 0) {
    throw new WebChatContractError("必须选择模型配置。");
  }
  if (value.provider.length > 128) {
    throw new WebChatContractError("模型配置名称过长。");
  }
  if (!isAgentMode(value.mode)) {
    throw new WebChatContractError("Agent 模式无效。");
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

  return { provider: value.provider.trim(), mode: value.mode, messages };
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
    if (error instanceof WebChatContractError) throw error;
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
    throw invalidEvent();
  }
  if (value.type === "progress") return parseProgressEvent(value);
  if (value.type === "text-delta") return parseTextEvent(value);
  if (value.type === "tool-call") return parseToolCallEvent(value);
  if (value.type === "tool-started") return parseToolStartedEvent(value);
  if (value.type === "tool-result") return parseToolResultEvent(value);
  if (value.type === "token-usage") return parseTokenUsageEvent(value);
  if (value.type === "stopped") return parseStoppedEvent(value);
  throw invalidEvent();
}

function parseProgressEvent(value: Record<string, unknown>): WebChatEvent {
  if (
    !isPositiveInteger(value.iteration, 32) ||
    !isPositiveInteger(value.maxIterations, 32) ||
    value.iteration > value.maxIterations
  ) {
    throw invalidEvent();
  }
  if (
    value.phase === "model" &&
    hasExactFields(value, ["type", "iteration", "maxIterations", "phase"])
  ) {
    return {
      type: "progress",
      iteration: value.iteration,
      maxIterations: value.maxIterations,
      phase: "model",
    };
  }
  if (
    value.phase === "tools" &&
    hasExactFields(value, [
      "type",
      "iteration",
      "maxIterations",
      "phase",
      "completedTools",
      "totalTools",
    ]) &&
    isNonNegativeInteger(value.completedTools, 16) &&
    isPositiveInteger(value.totalTools, 16) &&
    value.completedTools <= value.totalTools
  ) {
    return {
      type: "progress",
      iteration: value.iteration,
      maxIterations: value.maxIterations,
      phase: "tools",
      completedTools: value.completedTools,
      totalTools: value.totalTools,
    };
  }
  throw invalidEvent();
}

function parseTextEvent(value: Record<string, unknown>): WebChatEvent {
  if (
    !hasExactFields(value, ["type", "iteration", "text"]) ||
    !isPositiveInteger(value.iteration, 32) ||
    typeof value.text !== "string" ||
    value.text.length === 0
  ) {
    throw invalidEvent();
  }
  return { type: "text-delta", iteration: value.iteration, text: value.text };
}

function parseToolCallEvent(value: Record<string, unknown>): WebChatEvent {
  if (
    !hasExactFields(value, ["type", "iteration", "call", "sequence"]) ||
    !isPositiveInteger(value.iteration, 32) ||
    !isNonNegativeInteger(value.sequence, 15)
  ) {
    throw invalidEvent();
  }
  return {
    type: "tool-call",
    iteration: value.iteration,
    call: parseModelToolCall(value.call),
    sequence: value.sequence,
  };
}

function parseToolStartedEvent(value: Record<string, unknown>): WebChatEvent {
  if (
    !hasExactFields(value, ["type", "iteration", "callId", "name", "sequence"]) ||
    !isPositiveInteger(value.iteration, 32) ||
    !isSafeCallId(value.callId) ||
    !isSafeToolName(value.name) ||
    !isNonNegativeInteger(value.sequence, 15)
  ) {
    throw invalidEvent();
  }
  return {
    type: "tool-started",
    iteration: value.iteration,
    callId: value.callId,
    name: value.name,
    sequence: value.sequence,
  };
}

function parseToolResultEvent(value: Record<string, unknown>): WebChatEvent {
  if (
    !hasExactFields(value, [
      "type",
      "iteration",
      "callId",
      "name",
      "sequence",
      "result",
    ]) ||
    !isPositiveInteger(value.iteration, 32) ||
    !isSafeCallId(value.callId) ||
    !isSafeToolName(value.name) ||
    !isNonNegativeInteger(value.sequence, 15)
  ) {
    throw invalidEvent();
  }
  return {
    type: "tool-result",
    iteration: value.iteration,
    callId: value.callId,
    name: value.name,
    sequence: value.sequence,
    result: parseToolResult(value.result),
  };
}

function parseTokenUsageEvent(value: Record<string, unknown>): WebChatEvent {
  if (
    !hasExactFields(value, ["type", "iteration", "usage", "cumulative"]) ||
    !isPositiveInteger(value.iteration, 32)
  ) {
    throw invalidEvent();
  }
  return {
    type: "token-usage",
    iteration: value.iteration,
    usage: parseTokenUsage(value.usage),
    cumulative: parseTokenUsage(value.cumulative),
  };
}

function parseStoppedEvent(value: Record<string, unknown>): WebChatEvent {
  if (
    !isAgentStopReason(value.reason) ||
    !isNonNegativeInteger(value.iterations, 32) ||
    !isSideEffectState(value.sideEffect)
  ) {
    throw invalidEvent();
  }
  if (value.reason === "final-response") {
    if (
      !hasExactFields(value, [
        "type",
        "reason",
        "iterations",
        "sideEffect",
        "finalMessage",
      ]) ||
      !isAssistantMessage(value.finalMessage)
    ) {
      throw invalidEvent();
    }
    return {
      type: "stopped",
      reason: "final-response",
      iterations: value.iterations,
      sideEffect: value.sideEffect,
      finalMessage: value.finalMessage,
    };
  }
  if (
    !hasExactFields(value, [
      "type",
      "reason",
      "iterations",
      "sideEffect",
      "detail",
    ]) ||
    typeof value.detail !== "string" ||
    value.detail.length === 0 ||
    value.detail.length > 1_000
  ) {
    throw invalidEvent();
  }
  return {
    type: "stopped",
    reason: value.reason,
    iterations: value.iterations,
    sideEffect: value.sideEffect,
    detail: value.detail,
  };
}

function parseModelToolCall(value: unknown): ModelToolCall {
  if (
    !isRecord(value) ||
    !hasExactFields(value, ["id", "name", "argumentsJson"]) ||
    !isSafeCallId(value.id) ||
    !isSafeToolName(value.name) ||
    typeof value.argumentsJson !== "string" ||
    value.argumentsJson.length > 64 * 1024
  ) {
    throw invalidEvent();
  }
  return { id: value.id, name: value.name, argumentsJson: value.argumentsJson };
}

function parseTokenUsage(value: unknown): TokenUsage {
  if (!isRecord(value) || typeof value.availability !== "string") {
    throw invalidEvent();
  }
  if (
    value.availability === "unavailable" &&
    hasExactFields(value, ["availability"])
  ) {
    return { availability: "unavailable" };
  }
  if (
    value.availability === "reported" &&
    hasExactFields(value, [
      "availability",
      "promptTokens",
      "completionTokens",
      "totalTokens",
    ]) &&
    isNonNegativeInteger(value.promptTokens) &&
    isNonNegativeInteger(value.completionTokens) &&
    isNonNegativeInteger(value.totalTokens) &&
    value.promptTokens + value.completionTokens === value.totalTokens
  ) {
    return {
      availability: "reported",
      promptTokens: value.promptTokens,
      completionTokens: value.completionTokens,
      totalTokens: value.totalTokens,
    };
  }
  throw invalidEvent();
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
    if (
      !hasExactFields(value, ["ok", "output", "sideEffect", "meta"]) ||
      !isJsonValue(value.output)
    ) {
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
  return {
    kind: value.kind,
    message: value.message,
    retryable: value.retryable,
    issues,
  };
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 20) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry, depth + 1));
  }
  return (
    isRecord(value) &&
    Object.keys(value).length <= 2_000 &&
    Object.values(value).every((entry) => isJsonValue(entry, depth + 1))
  );
}

function isAssistantMessage(
  value: unknown,
): value is { readonly role: "assistant"; readonly content: string } {
  return (
    isRecord(value) &&
    hasExactFields(value, ["role", "content"]) &&
    value.role === "assistant" &&
    typeof value.content === "string" &&
    value.content.trim().length > 0
  );
}

function isSafeCallId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function isSafeToolName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function isAgentMode(value: unknown): value is AgentMode {
  return value === "plan" || value === "do";
}

const STOP_REASONS = new Set<AgentStopReason>([
  "final-response",
  "max-iterations",
  "cancelled",
  "repeated-unknown-tool",
  "model-error",
  "agent-error",
]);

function isAgentStopReason(value: unknown): value is AgentStopReason {
  return typeof value === "string" && STOP_REASONS.has(value as AgentStopReason);
}

function isSideEffectState(value: unknown): value is SideEffectState {
  return value === "none" || value === "possible" || value === "applied";
}

const TOOL_ERROR_KINDS = new Set<ToolErrorKind>([
  "invalid-arguments",
  "unknown-tool",
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

function isPositiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= maximum;
}

function isNonNegativeInteger(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function hasExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => field in value);
}

function invalidEvent(): WebChatContractError {
  return new WebChatContractError("服务端返回了无效的流式事件。");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
