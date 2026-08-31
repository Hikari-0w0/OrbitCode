import {
  CONVERSATION_SCHEMA_VERSION,
  ConversationRepositoryError,
  MAX_CONVERSATION_ID_LENGTH,
  MAX_CONVERSATION_TITLE_LENGTH,
  type ConversationCheckpoint,
  type ConversationSummary,
} from "@/core/conversations/types";
import { isCompletionAssessment } from "@/core/completion-tracker";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STOP_REASONS = new Set([
  "final-response", "max-iterations", "max-runtime", "cancelled", "repeated-unknown-tool", "repeated-tool-failure",
  "context-error", "context-capacity", "context-circuit-open", "model-error", "agent-error",
]);

export function validateConversationId(value: string): string {
  if (
    value.length === 0 ||
    value.length > MAX_CONVERSATION_ID_LENGTH ||
    !SAFE_ID.test(value)
  ) {
    throw new ConversationRepositoryError("invalid-data", "会话 ID 无效。");
  }
  return value;
}

export function validateConversationTitle(value: string): string {
  const title = value.trim();
  if (title.length === 0 || title.length > MAX_CONVERSATION_TITLE_LENGTH) {
    throw new ConversationRepositoryError(
      "invalid-data",
      `会话标题必须为 1 到 ${MAX_CONVERSATION_TITLE_LENGTH} 个字符。`,
    );
  }
  return title;
}

export function parseConversationSummary(value: unknown): ConversationSummary {
  if (
    !isRecord(value) ||
    !hasExactFields(value, value.lastStopReason === undefined
      ? ["schemaVersion", "id", "title", "revision", "createdAt", "updatedAt", "workspaceId", "providerId"]
      : ["schemaVersion", "id", "title", "revision", "createdAt", "updatedAt", "workspaceId", "providerId", "lastStopReason"]) ||
    value.schemaVersion !== CONVERSATION_SCHEMA_VERSION ||
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    !isNonNegativeInteger(value.revision) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.providerId !== "string"
  ) {
    throw invalidStoredConversation();
  }
  validateConversationId(value.id);
  validateConversationTitle(value.title);
  validateDate(value.createdAt);
  validateDate(value.updatedAt);
  if (value.workspaceId.length === 0 || value.providerId.length === 0) {
    throw invalidStoredConversation();
  }
  if (value.lastStopReason !== undefined && !STOP_REASONS.has(String(value.lastStopReason))) {
    throw invalidStoredConversation();
  }
  return value as ConversationSummary;
}

export function parseConversationCheckpoint(value: unknown): ConversationCheckpoint {
  if (
    !isRecord(value) ||
    !hasExactFields(value, ["schemaVersion", "summary", "mode", "modeTurn", "displayMessages", "context"]) ||
    value.schemaVersion !== CONVERSATION_SCHEMA_VERSION ||
    !Array.isArray(value.displayMessages) ||
    !isRecord(value.context) ||
    !Array.isArray(value.context.messages) ||
    !hasExactFields(value.context, ["messages", "consecutiveSummaryFailures"]) ||
    !isNonNegativeInteger(value.context.consecutiveSummaryFailures) ||
    (value.mode !== "plan" && value.mode !== "do") ||
    !isNonNegativeInteger(value.modeTurn) ||
    !isRecord(value.summary)
  ) {
    throw invalidStoredConversation();
  }
  const summary = parseConversationSummary(value.summary);
  for (const message of value.displayMessages) validateDisplayMessage(message);
  for (const message of value.context.messages) validateManagedMessage(message);
  validateToolTranscript(value.context.messages);
  return { ...value, summary } as ConversationCheckpoint;
}

function validateToolTranscript(messages: readonly unknown[]): void {
  const pending = new Set<string>();
  const seen = new Set<string>();
  for (const message of messages) {
    if (!isRecord(message)) throw invalidStoredConversation();
    if (message.kind === "assistant-tool-call") {
      if (pending.size > 0 || !Array.isArray(message.toolCalls) || message.toolCalls.length === 0) {
        throw invalidStoredConversation();
      }
      for (const call of message.toolCalls) {
        if (!isRecord(call) || typeof call.id !== "string" || seen.has(call.id)) {
          throw invalidStoredConversation();
        }
        pending.add(call.id);
        seen.add(call.id);
      }
      continue;
    }
    if (message.kind === "tool-result") {
      if (typeof message.toolCallId !== "string" || !pending.delete(message.toolCallId)) {
        throw invalidStoredConversation();
      }
      continue;
    }
    if (pending.size > 0) throw invalidStoredConversation();
  }
  if (pending.size > 0) throw invalidStoredConversation();
}

function validateDisplayMessage(value: unknown): void {
  const optional = ["detail", "parts", "toolExecutions", "usage", "cumulativeUsage", "stopReason", "durationMs", "verification"];
  if (
    !isRecord(value) ||
    !hasAllowedFields(value, ["id", "role", "content", "state"], optional) ||
    typeof value.id !== "string" ||
    (value.role !== "user" && value.role !== "assistant") ||
    typeof value.content !== "string" ||
    !["complete", "cancelled", "failed"].includes(String(value.state))
  ) throw invalidStoredConversation();
  if (value.role === "user" && value.state !== "complete") throw invalidStoredConversation();
  if (value.detail !== undefined && typeof value.detail !== "string") throw invalidStoredConversation();
  if (value.stopReason !== undefined && !STOP_REASONS.has(String(value.stopReason))) throw invalidStoredConversation();
  if (value.durationMs !== undefined && !isNonNegativeInteger(value.durationMs)) throw invalidStoredConversation();
  if (value.verification !== undefined && !isCompletionAssessment(value.verification)) {
    throw invalidStoredConversation();
  }
  if (value.parts !== undefined && !Array.isArray(value.parts)) {
    throw invalidStoredConversation();
  }
  for (const part of value.parts ?? []) {
    if (!isRecord(part) || !isNonNegativeInteger(part.iteration)) throw invalidStoredConversation();
    if (part.type === "text") {
      if (!hasExactFields(part, ["type", "iteration", "content"]) || typeof part.content !== "string") throw invalidStoredConversation();
    } else if (part.type === "tool") {
      if (!hasExactFields(part, ["type", "iteration", "callId"]) || typeof part.callId !== "string") throw invalidStoredConversation();
    } else throw invalidStoredConversation();
  }
  if (value.toolExecutions !== undefined && !Array.isArray(value.toolExecutions)) {
    throw invalidStoredConversation();
  }
  for (const tool of value.toolExecutions ?? []) validateToolExecution(tool);
  if (value.usage !== undefined) validateUsage(value.usage);
  if (value.cumulativeUsage !== undefined) validateUsage(value.cumulativeUsage);
}

function validateManagedMessage(value: unknown): void {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw invalidStoredConversation();
  }
  if (value.kind === "user" || value.kind === "assistant" || value.kind === "boundary") {
    if (!hasExactFields(value, ["kind", "content"]) || typeof value.content !== "string") throw invalidStoredConversation();
    return;
  }
  if (value.kind === "assistant-tool-call") {
    const fields = value.reasoningContent === undefined
      ? ["kind", "content", "toolCalls"]
      : ["kind", "content", "reasoningContent", "toolCalls"];
    if (!hasExactFields(value, fields) || (value.content !== null && typeof value.content !== "string") || !Array.isArray(value.toolCalls) || (value.reasoningContent !== undefined && typeof value.reasoningContent !== "string")) throw invalidStoredConversation();
    for (const call of value.toolCalls) {
      if (!isRecord(call) || !hasExactFields(call, ["id", "name", "argumentsJson"]) || typeof call.id !== "string" || typeof call.name !== "string" || typeof call.argumentsJson !== "string") throw invalidStoredConversation();
    }
    return;
  }
  if (value.kind === "tool-result") {
    if (!hasExactFields(value, ["kind", "toolCallId", "payload"]) || typeof value.toolCallId !== "string" || !isRecord(value.payload)) throw invalidStoredConversation();
    if (value.payload.storage === "inline") {
      if (!hasExactFields(value.payload, ["storage", "content"]) || typeof value.payload.content !== "string") throw invalidStoredConversation();
    } else if (value.payload.storage === "offloaded") {
      if (!hasExactFields(value.payload, ["storage", "reference", "preview", "originalBytes", "estimatedTokens"]) || typeof value.payload.reference !== "string" || !/^context:\/\/v1\/[0-9a-f-]{36}$/.test(value.payload.reference) || typeof value.payload.preview !== "string" || !isNonNegativeInteger(value.payload.originalBytes) || !isNonNegativeInteger(value.payload.estimatedTokens)) throw invalidStoredConversation();
    } else throw invalidStoredConversation();
    return;
  }
  if (value.kind === "interruption") {
    if (!hasExactFields(value, ["kind", "reason", "detail", "sideEffect"]) || value.reason === "final-response" || !STOP_REASONS.has(String(value.reason)) || typeof value.detail !== "string" || !["none", "possible", "applied"].includes(String(value.sideEffect))) throw invalidStoredConversation();
    return;
  }
  if (value.kind === "summary") {
    if (!hasExactFields(value, ["kind", "summary"]) || !isRecord(value.summary)) throw invalidStoredConversation();
    const summary = value.summary;
    const fields = ["taskGoals", "completedWork", "keyDecisions", "fileChanges", "toolResults", "errors", "nextSteps"];
    if (!hasExactFields(summary, fields) || fields.some((field) => !isStringArray(summary[field]))) throw invalidStoredConversation();
    return;
  }
  throw invalidStoredConversation();
}

function validateToolExecution(value: unknown): void {
  if (!isRecord(value) || !hasExactFields(value, ["iteration", "sequence", "callId", "name", "argumentsJson", "state", "result"]) || !isNonNegativeInteger(value.iteration) || !isNonNegativeInteger(value.sequence) || typeof value.callId !== "string" || typeof value.name !== "string" || typeof value.argumentsJson !== "string" || !["succeeded", "failed", "timed-out", "cancelled", "skipped"].includes(String(value.state)) || !isRecord(value.result)) throw invalidStoredConversation();
  const resultFields = value.result.ok === true
    ? ["ok", "output", "sideEffect", "meta"]
    : value.result.output === undefined
      ? ["ok", "error", "sideEffect", "meta"]
      : ["ok", "error", "output", "sideEffect", "meta"];
  if (!hasExactFields(value.result, resultFields) || (value.result.ok !== true && value.result.ok !== false) || !["none", "possible", "applied"].includes(String(value.result.sideEffect)) || !isRecord(value.result.meta)) throw invalidStoredConversation();
}

function validateUsage(value: unknown): void {
  if (!isRecord(value)) throw invalidStoredConversation();
  if (value.availability === "unavailable" && hasExactFields(value, ["availability"])) return;
  if (value.availability !== "reported" || !hasExactFields(value, ["availability", "promptTokens", "completionTokens", "totalTokens", "promptCache"]) || !isNonNegativeInteger(value.promptTokens) || !isNonNegativeInteger(value.completionTokens) || !isNonNegativeInteger(value.totalTokens) || !isRecord(value.promptCache)) throw invalidStoredConversation();
}

function validateDate(value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw invalidStoredConversation();
}

function invalidStoredConversation(): ConversationRepositoryError {
  return new ConversationRepositoryError("invalid-data", "本地会话数据损坏或版本不受支持。");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasExactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const expected = new Set(fields);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
}

function hasAllowedFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((field) => field in value) && Object.keys(value).every((field) => allowed.has(field));
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
