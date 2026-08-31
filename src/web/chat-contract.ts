import type {
  AgentEvent,
  AgentIterationLimit,
  AgentMode,
  AgentStopReason,
  TokenUsage,
} from "@/core/agent-events";
import type {
  PermissionPrompt,
  PermissionUserDecision,
} from "@/core/permissions/approval";
import type { PermissionMode } from "@/core/permissions/types";
import { MAX_MODE_TURN } from "@/core/system-prompt/session-instructions";
import type {
  CompressionReport,
  ContextFailure,
  TokenEstimate,
} from "@/core/context/types";
import type {
  ModelToolCall,
  PromptCacheUsage,
} from "@/models/provider";
import type {
  ConversationCheckpoint,
  ConversationSummary,
} from "@/core/conversations/types";
import { isCompletionAssessment } from "@/core/completion-tracker";
import { parseConversationCheckpoint } from "@/core/conversations/validation";
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
import { MAX_TOOL_ARGUMENTS_JSON_CHARS } from "@/tools/types";

export const MAX_WEB_CHAT_BODY_BYTES = 256 * 1024;
export const MAX_WEB_CHAT_INPUT_LENGTH = 20_000;
export const MAX_WEB_WORKSPACES = 32;
export const MAX_WEB_WORKSPACE_ID_LENGTH = 64;
export const MAX_WEB_WORKSPACE_NAME_LENGTH = 80;
export const MAX_PERMISSION_SESSION_ID_LENGTH = 128;
export const MAX_PERMISSION_REQUEST_ID_LENGTH = 128;
export const MAX_CONTEXT_SESSION_ID_LENGTH = 128;
const MAX_WEB_AGENT_ITERATION = Number.MAX_SAFE_INTEGER;

export type WebChatRequest = {
  readonly conversationId: string;
  readonly revision: number;
  readonly permissionSessionId: string;
  readonly mode: AgentMode;
  readonly modeTurn: number;
  readonly input: string;
};

export type ConversationCatalogResponse = {
  readonly conversations: readonly ConversationSummary[];
};

export type ConversationActivity =
  | { readonly status: "idle" }
  | { readonly status: "active" }
  | { readonly status: "interrupted"; readonly expectedRevision: number };

export type ConversationDetailResponse = Omit<ConversationCheckpoint, "context"> & {
  readonly availability: "ready" | "read-only";
  readonly unavailableReason?: string;
  readonly activity: ConversationActivity;
};

export type ConversationCreateRequest = {
  readonly providerId: string;
  readonly workspaceId: string;
  readonly title?: string;
};

export type ConversationMutationRequest = {
  readonly expectedRevision: number;
};

export type ConversationRenameRequest = ConversationMutationRequest & {
  readonly title: string;
};

export type ContextCompressionResponse = CompressionReport;

export type PermissionSessionResponse = {
  readonly sessionId: string;
  readonly mode: PermissionMode;
};

export type PermissionSessionUpdateRequest = {
  readonly mode: PermissionMode;
};

export type PermissionDecisionRequest = {
  readonly requestId: string;
  readonly decision: PermissionUserDecision;
};

export type PermissionDecisionResponse = {
  readonly accepted: true;
};

export type WebPersistenceState =
  | { readonly status: "saved"; readonly revision: number }
  | { readonly status: "failed"; readonly detail: string };

export type WebChatEvent =
  | Exclude<AgentEvent, { type: "stopped" }>
  | (Extract<AgentEvent, { type: "stopped" }> & {
      readonly persistence?: WebPersistenceState;
    });

export type ProviderSummary = {
  readonly name: string;
  readonly model: string;
  readonly available: boolean;
};

export type ProviderCatalogResponse = {
  readonly providers: readonly ProviderSummary[];
};

export type WorkspaceSummary = {
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
  readonly isDefault: boolean;
};

export type WorkspaceCatalogResponse = {
  readonly workspaces: readonly WorkspaceSummary[];
  readonly defaultWorkspaceId: string;
};

export type WebApiError = {
  readonly error: string;
  readonly code?:
    | "workspace-config"
    | "workspace-unknown"
    | "workspace-unavailable"
    | "permission-session"
    | "permission-request"
    | "context-session"
    | "context-compression"
    | "conversation-not-found"
    | "conversation-conflict"
    | "conversation-busy"
    | "conversation-storage"
    | "invalid-request"
    | "forbidden";
};

export class WebChatContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebChatContractError";
  }
}

export function parseWebChatRequest(value: unknown): WebChatRequest {
  if (
    !isRecord(value) ||
    !hasExactFields(value, [
      "conversationId",
      "revision",
      "permissionSessionId",
      "mode",
      "modeTurn",
      "input",
    ])
  ) {
    throw new WebChatContractError("对话请求格式无效。");
  }
  if (!isSafePermissionId(value.conversationId, MAX_CONTEXT_SESSION_ID_LENGTH)) {
    throw new WebChatContractError("会话 ID 无效。");
  }
  if (!isNonNegativeInteger(value.revision, Number.MAX_SAFE_INTEGER)) {
    throw new WebChatContractError("会话修订号无效。");
  }
  if (!isSafePermissionId(value.permissionSessionId, MAX_PERMISSION_SESSION_ID_LENGTH)) {
    throw new WebChatContractError("权限会话 ID 无效。");
  }
  if (!isAgentMode(value.mode)) {
    throw new WebChatContractError("Agent 模式无效。");
  }
  if (!isPositiveInteger(value.modeTurn, MAX_MODE_TURN)) {
    throw new WebChatContractError("模式连续轮次无效。");
  }
  if (
    typeof value.input !== "string" ||
    value.input.trim().length === 0 ||
    value.input.length > MAX_WEB_CHAT_INPUT_LENGTH
  ) {
    throw new WebChatContractError(
      `用户输入必须是长度不超过 ${MAX_WEB_CHAT_INPUT_LENGTH} 的非空字符串。`,
    );
  }

  return {
    conversationId: value.conversationId,
    revision: value.revision,
    permissionSessionId: value.permissionSessionId,
    mode: value.mode,
    modeTurn: value.modeTurn,
    input: value.input,
  };
}

export function parseConversationCreateRequest(
  value: unknown,
): ConversationCreateRequest {
  const fields = isRecord(value) && value.title !== undefined
    ? ["providerId", "workspaceId", "title"]
    : ["providerId", "workspaceId"];
  if (
    !isRecord(value) ||
    !hasExactFields(value, fields) ||
    typeof value.providerId !== "string" ||
    value.providerId.trim().length === 0 ||
    value.providerId.length > 128 ||
    typeof value.workspaceId !== "string" ||
    value.workspaceId.length === 0 ||
    value.workspaceId.length > MAX_WEB_WORKSPACE_ID_LENGTH ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.workspaceId) ||
    (value.title !== undefined &&
      (typeof value.title !== "string" || value.title.trim().length === 0 || value.title.length > 120))
  ) {
    throw new WebChatContractError("会话创建请求无效。");
  }
  return {
    providerId: value.providerId.trim(),
    workspaceId: value.workspaceId,
    ...(value.title === undefined ? {} : { title: value.title.trim() }),
  };
}

export function parseConversationMutationRequest(
  value: unknown,
): ConversationMutationRequest {
  if (
    !isRecord(value) ||
    !hasExactFields(value, ["expectedRevision"]) ||
    !isNonNegativeInteger(value.expectedRevision, Number.MAX_SAFE_INTEGER)
  ) throw new WebChatContractError("会话修改请求无效。");
  return { expectedRevision: value.expectedRevision };
}

export function parseConversationRenameRequest(
  value: unknown,
): ConversationRenameRequest {
  if (
    !isRecord(value) ||
    !hasExactFields(value, ["expectedRevision", "title"]) ||
    !isNonNegativeInteger(value.expectedRevision, Number.MAX_SAFE_INTEGER) ||
    typeof value.title !== "string" ||
    value.title.trim().length === 0 ||
    value.title.length > 120
  ) throw new WebChatContractError("会话重命名请求无效。");
  return { expectedRevision: value.expectedRevision, title: value.title.trim() };
}

export function parseConversationCatalogResponse(
  value: unknown,
): ConversationCatalogResponse {
  if (!isRecord(value) || !hasExactFields(value, ["conversations"]) || !Array.isArray(value.conversations)) {
    throw new WebChatContractError("服务端返回了无效的会话列表。");
  }
  const conversations = value.conversations.map((item) =>
    parseConversationCheckpoint({
      schemaVersion: 1,
      summary: item,
      mode: "do",
      modeTurn: 0,
      displayMessages: [],
      context: { messages: [], consecutiveSummaryFailures: 0 },
    }).summary
  );
  return { conversations };
}

export function parseConversationDetailResponse(
  value: unknown,
): ConversationDetailResponse {
  const fields = isRecord(value) && value.unavailableReason !== undefined
    ? ["schemaVersion", "summary", "mode", "modeTurn", "displayMessages", "availability", "unavailableReason", "activity"]
    : ["schemaVersion", "summary", "mode", "modeTurn", "displayMessages", "availability", "activity"];
  if (
    !isRecord(value) ||
    !hasExactFields(value, fields) ||
    (value.availability !== "ready" && value.availability !== "read-only") ||
    !isConversationActivity(value.activity)
  ) {
    throw new WebChatContractError("服务端返回了无效的会话详情。");
  }
  const { availability, unavailableReason, activity, ...displayValue } = value;
  if (unavailableReason !== undefined && typeof unavailableReason !== "string") {
    throw new WebChatContractError("服务端返回了无效的会话详情。");
  }
  try {
    const checkpoint = parseConversationCheckpoint({
      ...displayValue,
      context: { messages: [], consecutiveSummaryFailures: 0 },
    });
    return {
      schemaVersion: checkpoint.schemaVersion,
      summary: checkpoint.summary,
      mode: checkpoint.mode,
      modeTurn: checkpoint.modeTurn,
      displayMessages: checkpoint.displayMessages,
      availability,
      activity,
      ...(unavailableReason === undefined ? {} : { unavailableReason }),
    };
  } catch {
    throw new WebChatContractError("服务端返回了无效的会话详情。");
  }
}

function isConversationActivity(value: unknown): value is ConversationActivity {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  if (
    (value.status === "idle" || value.status === "active") &&
    hasExactFields(value, ["status"])
  ) return true;
  return value.status === "interrupted" &&
    hasExactFields(value, ["status", "expectedRevision"]) &&
    isNonNegativeInteger(value.expectedRevision, Number.MAX_SAFE_INTEGER);
}

export function parseContextCompressionResponse(
  value: unknown,
): ContextCompressionResponse {
  if (!isRecord(value) || value.trigger !== "manual") {
    throw new WebChatContractError("服务端返回了无效的上下文压缩结果。");
  }
  const before = parseTokenEstimate(value.before);
  if (
    value.status === "succeeded" &&
    hasExactFields(value, ["status", "trigger", "before", "after"])
  ) {
    return {
      status: "succeeded",
      trigger: "manual",
      before,
      after: parseTokenEstimate(value.after),
    };
  }
  if (
    value.status === "failed" &&
    hasExactFields(value, [
      "status",
      "trigger",
      "before",
      "failure",
      "consecutiveSummaryFailures",
    ]) &&
    isNonNegativeInteger(value.consecutiveSummaryFailures, 2)
  ) {
    return {
      status: "failed",
      trigger: "manual",
      before,
      failure: parseContextFailure(value.failure),
      consecutiveSummaryFailures: value.consecutiveSummaryFailures,
    };
  }
  if (
    value.status === "circuit-open" &&
    hasExactFields(value, [
      "status",
      "trigger",
      "before",
      "failure",
      "consecutiveSummaryFailures",
    ]) &&
    value.consecutiveSummaryFailures === 3
  ) {
    return {
      status: "circuit-open",
      trigger: "manual",
      before,
      failure: parseContextFailure(value.failure),
      consecutiveSummaryFailures: 3,
    };
  }
  throw new WebChatContractError("服务端返回了无效的上下文压缩结果。");
}

export function parsePermissionSessionResponse(
  value: unknown,
): PermissionSessionResponse {
  if (
    !isRecord(value) ||
    !hasExactFields(value, ["sessionId", "mode"]) ||
    !isSafePermissionId(value.sessionId, MAX_PERMISSION_SESSION_ID_LENGTH) ||
    !isPermissionMode(value.mode)
  ) {
    throw new WebChatContractError("服务端返回了无效的权限会话。");
  }
  return { sessionId: value.sessionId, mode: value.mode };
}

export function parsePermissionSessionUpdateRequest(
  value: unknown,
): PermissionSessionUpdateRequest {
  if (
    !isRecord(value) ||
    !hasExactFields(value, ["mode"]) ||
    !isPermissionMode(value.mode)
  ) {
    throw new WebChatContractError("权限模式更新请求无效。");
  }
  return { mode: value.mode };
}

export function parsePermissionDecisionRequest(
  value: unknown,
): PermissionDecisionRequest {
  if (
    !isRecord(value) ||
    !hasExactFields(value, ["requestId", "decision"]) ||
    !isSafePermissionId(value.requestId, MAX_PERMISSION_REQUEST_ID_LENGTH) ||
    !isPermissionUserDecision(value.decision)
  ) {
    throw new WebChatContractError("授权决定请求无效。");
  }
  return { requestId: value.requestId, decision: value.decision };
}

export function parsePermissionDecisionResponse(
  value: unknown,
): PermissionDecisionResponse {
  if (
    !isRecord(value) ||
    !hasExactFields(value, ["accepted"]) ||
    value.accepted !== true
  ) {
    throw new WebChatContractError("服务端返回了无效的授权决定结果。");
  }
  return { accepted: true };
}

export function encodeWebChatEvent(event: WebChatEvent): Uint8Array {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  if (event.type !== "permission-requested") {
    return new TextEncoder().encode(data);
  }
  // 授权事件后服务端会立即停下等待人工决定，用 SSE 注释撑过常见的小分块缓冲阈值。
  return new TextEncoder().encode(`${data}: ${" ".repeat(2_048)}\n\n`);
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

export function parseWorkspaceCatalogResponse(
  value: unknown,
): WorkspaceCatalogResponse {
  if (
    !isRecord(value) ||
    !hasExactFields(value, ["workspaces", "defaultWorkspaceId"]) ||
    !Array.isArray(value.workspaces) ||
    value.workspaces.length === 0 ||
    value.workspaces.length > MAX_WEB_WORKSPACES ||
    typeof value.defaultWorkspaceId !== "string"
  ) {
    throw new WebChatContractError("服务端返回了无效的 Workspace 列表。");
  }
  const workspaces = value.workspaces.map((workspace) => {
    if (
      !isRecord(workspace) ||
      !hasExactFields(workspace, ["id", "name", "available", "isDefault"]) ||
      typeof workspace.id !== "string" ||
      workspace.id.length === 0 ||
      workspace.id.length > MAX_WEB_WORKSPACE_ID_LENGTH ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workspace.id) ||
      typeof workspace.name !== "string" ||
      workspace.name.trim().length === 0 ||
      workspace.name.length > MAX_WEB_WORKSPACE_NAME_LENGTH ||
      typeof workspace.available !== "boolean" ||
      typeof workspace.isDefault !== "boolean"
    ) {
      throw new WebChatContractError("服务端返回了无效的 Workspace 列表。");
    }
    return {
      id: workspace.id,
      name: workspace.name,
      available: workspace.available,
      isDefault: workspace.isDefault,
    };
  });
  const ids = new Set(workspaces.map((workspace) => workspace.id));
  const defaultMatches = workspaces.filter(
    (workspace) => workspace.id === value.defaultWorkspaceId && workspace.isDefault,
  );
  if (
    ids.size !== workspaces.length ||
    defaultMatches.length !== 1 ||
    !defaultMatches[0].available ||
    workspaces.filter((workspace) => workspace.isDefault).length !== 1
  ) {
    throw new WebChatContractError("服务端返回了无效的 Workspace 列表。");
  }
  return { workspaces, defaultWorkspaceId: value.defaultWorkspaceId };
}

export function parseWebApiError(value: unknown): WebApiError | undefined {
  if (
    isRecord(value) &&
    (hasExactFields(value, ["error"]) || hasExactFields(value, ["error", "code"])) &&
    typeof value.error === "string" &&
    value.error.length > 0 &&
    (value.code === undefined ||
      value.code === "workspace-config" ||
      value.code === "workspace-unknown" ||
      value.code === "workspace-unavailable" ||
      value.code === "permission-session" ||
      value.code === "permission-request" ||
      value.code === "context-session" ||
      value.code === "context-compression" ||
      value.code === "invalid-request" ||
      value.code === "forbidden")
  ) {
    return value.code === undefined
      ? { error: value.error }
      : { error: value.error, code: value.code };
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

function parseWebChatEvent(value: unknown): WebChatEvent {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw invalidEvent();
  }
  if (value.type === "progress") return parseProgressEvent(value);
  if (value.type === "text-delta") return parseTextEvent(value);
  if (value.type === "tool-call") return parseToolCallEvent(value);
  if (value.type === "permission-requested") return parsePermissionRequestedEvent(value);
  if (value.type === "permission-resolved") return parsePermissionResolvedEvent(value);
  if (value.type === "tool-started") return parseToolStartedEvent(value);
  if (value.type === "tool-result") return parseToolResultEvent(value);
  if (value.type === "token-usage") return parseTokenUsageEvent(value);
  if (value.type === "stopped") return parseStoppedEvent(value);
  throw invalidEvent();
}

function parsePermissionRequestedEvent(
  value: Record<string, unknown>,
): WebChatEvent {
  if (
    !hasExactFields(value, [
      "type",
      "iteration",
      "callId",
      "name",
      "sequence",
      "prompt",
    ]) ||
    !isPositiveInteger(value.iteration, MAX_WEB_AGENT_ITERATION) ||
    !isSafeCallId(value.callId) ||
    !isSafeToolName(value.name) ||
    !isNonNegativeInteger(value.sequence, 15)
  ) {
    throw invalidEvent();
  }
  const prompt = parsePermissionPrompt(value.prompt);
  if (prompt.toolCallId !== value.callId || prompt.toolName !== value.name) {
    throw invalidEvent();
  }
  return {
    type: "permission-requested",
    iteration: value.iteration,
    callId: value.callId,
    name: value.name,
    sequence: value.sequence,
    prompt,
  };
}

function parsePermissionResolvedEvent(
  value: Record<string, unknown>,
): WebChatEvent {
  const allowedFields = value.scope === undefined
    ? ["type", "iteration", "callId", "name", "sequence", "requestId", "status"]
    : ["type", "iteration", "callId", "name", "sequence", "requestId", "status", "scope"];
  if (
    !hasExactFields(value, allowedFields) ||
    !isPositiveInteger(value.iteration, MAX_WEB_AGENT_ITERATION) ||
    !isSafeCallId(value.callId) ||
    !isSafeToolName(value.name) ||
    !isNonNegativeInteger(value.sequence, 15) ||
    !isSafePermissionId(value.requestId, MAX_PERMISSION_REQUEST_ID_LENGTH) ||
    !isPermissionResolutionStatus(value.status) ||
    (value.scope !== undefined && !isPermissionScope(value.scope)) ||
    (value.status !== "allowed" && value.scope !== undefined)
  ) {
    throw invalidEvent();
  }
  return {
    type: "permission-resolved",
    iteration: value.iteration,
    callId: value.callId,
    name: value.name,
    sequence: value.sequence,
    requestId: value.requestId,
    status: value.status,
    scope: value.scope,
  };
}

function parsePermissionPrompt(value: unknown): PermissionPrompt {
  if (
    !isRecord(value) ||
    !hasExactFields(value, [
      "requestId",
      "toolCallId",
      "toolName",
      "workspace",
      "summary",
      "risk",
      "source",
      "persistentLayer",
      "expiresAt",
    ]) ||
    !isSafePermissionId(value.requestId, MAX_PERMISSION_REQUEST_ID_LENGTH) ||
    !isSafeCallId(value.toolCallId) ||
    !isSafeToolName(value.toolName) ||
    !isSafeWorkspaceSummary(value.workspace) ||
    !isPermissionPromptSummary(value.summary) ||
    !isPermissionRisk(value.risk) ||
    (value.source !== "rules" && value.source !== "mode") ||
    value.persistentLayer !== "local" ||
    typeof value.expiresAt !== "string" ||
    value.expiresAt.length > 64 ||
    !Number.isFinite(Date.parse(value.expiresAt))
  ) {
    throw invalidEvent();
  }
  return {
    requestId: value.requestId,
    toolCallId: value.toolCallId,
    toolName: value.toolName,
    workspace: value.workspace,
    summary: value.summary,
    risk: value.risk,
    source: value.source,
    persistentLayer: "local",
    expiresAt: value.expiresAt,
  };
}

function parseProgressEvent(value: Record<string, unknown>): WebChatEvent {
  if (
    !isPositiveInteger(value.iteration, MAX_WEB_AGENT_ITERATION) ||
    !isIterationLimit(value.maxIterations) ||
    (typeof value.maxIterations === "number" && value.iteration > value.maxIterations)
  ) {
    throw invalidEvent();
  }
  if (value.phase === "model") {
    const hasModel = value.model !== undefined;
    if (!hasExactFields(
      value,
      hasModel
        ? ["type", "iteration", "maxIterations", "phase", "model"]
        : ["type", "iteration", "maxIterations", "phase"],
    )) throw invalidEvent();
    const model = hasModel ? parseModelProgress(value.model) : undefined;
    return {
      type: "progress",
      iteration: value.iteration,
      maxIterations: value.maxIterations,
      phase: "model",
      ...(model === undefined ? {} : { model }),
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

function parseModelProgress(
  value: unknown,
): NonNullable<Extract<WebChatEvent, { type: "progress" }>["model"]> {
  if (!isRecord(value)) throw invalidEvent();
  const fields = [
    "stage",
    "elapsedMs",
    "attempt",
    ...(value.traceId === undefined ? [] : ["traceId"]),
    ...(value.toolName === undefined ? [] : ["toolName"]),
    ...(value.toolArgumentsChars === undefined ? [] : ["toolArgumentsChars"]),
  ];
  if (
    !hasExactFields(value, fields) ||
    ![
      "waiting-first-byte",
      "streaming-text",
      "streaming-tool-arguments",
      "waiting-done",
    ].includes(String(value.stage)) ||
    !isNonNegativeInteger(value.elapsedMs, 30 * 60 * 1_000) ||
    !isPositiveInteger(value.attempt, 4) ||
    (value.traceId !== undefined &&
      (typeof value.traceId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value.traceId))) ||
    (value.toolName !== undefined && !isSafeToolName(value.toolName)) ||
    (value.toolArgumentsChars !== undefined &&
      !isNonNegativeInteger(value.toolArgumentsChars, MAX_TOOL_ARGUMENTS_JSON_CHARS))
  ) throw invalidEvent();
  return value as NonNullable<Extract<WebChatEvent, { type: "progress" }>["model"]>;
}

function parseTextEvent(value: Record<string, unknown>): WebChatEvent {
  if (
    !hasExactFields(value, ["type", "iteration", "text"]) ||
    !isPositiveInteger(value.iteration, MAX_WEB_AGENT_ITERATION) ||
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
    !isPositiveInteger(value.iteration, MAX_WEB_AGENT_ITERATION) ||
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
    !isPositiveInteger(value.iteration, MAX_WEB_AGENT_ITERATION) ||
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
    !isPositiveInteger(value.iteration, MAX_WEB_AGENT_ITERATION) ||
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
    !isPositiveInteger(value.iteration, MAX_WEB_AGENT_ITERATION)
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
    !isNonNegativeInteger(value.iterations, MAX_WEB_AGENT_ITERATION) ||
    !isNonNegativeInteger(value.durationMs, Number.MAX_SAFE_INTEGER) ||
    !isSideEffectState(value.sideEffect)
  ) {
    throw invalidEvent();
  }
  if (value.reason === "final-response") {
    const fields = [
      "type", "reason", "iterations", "durationMs", "sideEffect", "finalMessage",
      ...(value.verification === undefined ? [] : ["verification"]),
      ...(value.persistence === undefined ? [] : ["persistence"]),
    ];
    if (
      !hasExactFields(value, fields) ||
      !isAssistantMessage(value.finalMessage) ||
      (value.verification !== undefined && !isCompletionAssessment(value.verification))
    ) {
      throw invalidEvent();
    }
    return {
      type: "stopped",
      reason: "final-response",
      iterations: value.iterations,
      durationMs: value.durationMs,
      sideEffect: value.sideEffect,
      finalMessage: value.finalMessage,
      ...(value.verification === undefined ? {} : { verification: value.verification }),
      ...(value.persistence === undefined
        ? {}
        : { persistence: parsePersistenceState(value.persistence) }),
    };
  }
  const fields = [
    "type", "reason", "iterations", "durationMs", "sideEffect", "detail",
    ...(value.verification === undefined ? [] : ["verification"]),
    ...(value.persistence === undefined ? [] : ["persistence"]),
  ];
  if (
    !hasExactFields(value, fields) ||
    typeof value.detail !== "string" ||
    value.detail.length === 0 ||
    value.detail.length > 1_000 ||
    (value.verification !== undefined && !isCompletionAssessment(value.verification))
  ) {
    throw invalidEvent();
  }
  return {
    type: "stopped",
    reason: value.reason,
    iterations: value.iterations,
    durationMs: value.durationMs,
    sideEffect: value.sideEffect,
    detail: value.detail,
    ...(value.verification === undefined ? {} : { verification: value.verification }),
    ...(value.persistence === undefined
      ? {}
      : { persistence: parsePersistenceState(value.persistence) }),
  };
}

function parsePersistenceState(value: unknown): WebPersistenceState {
  if (
    isRecord(value) &&
    value.status === "saved" &&
    hasExactFields(value, ["status", "revision"]) &&
    isNonNegativeInteger(value.revision, Number.MAX_SAFE_INTEGER)
  ) return { status: "saved", revision: value.revision };
  if (
    isRecord(value) &&
    value.status === "failed" &&
    hasExactFields(value, ["status", "detail"]) &&
    typeof value.detail === "string" &&
    value.detail.length > 0 &&
    value.detail.length <= 1_000
  ) return { status: "failed", detail: value.detail };
  throw invalidEvent();
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

function parseTokenEstimate(value: unknown): TokenEstimate {
  if (
    !isRecord(value) ||
    typeof value.tokens !== "number" ||
    !Number.isSafeInteger(value.tokens) ||
    value.tokens < 0
  ) {
    throw new WebChatContractError("服务端返回了无效的 Token 估算。");
  }
  if (
    value.source === "approximation" &&
    hasExactFields(value, ["source", "tokens"])
  ) {
    return { source: "approximation", tokens: value.tokens };
  }
  if (
    value.source === "usage-anchor" &&
    hasExactFields(value, [
      "source",
      "tokens",
      "anchorPromptTokens",
      "estimatedDeltaTokens",
    ]) &&
    isNonNegativeInteger(value.anchorPromptTokens) &&
    typeof value.estimatedDeltaTokens === "number" &&
    Number.isSafeInteger(value.estimatedDeltaTokens)
  ) {
    return {
      source: "usage-anchor",
      tokens: value.tokens,
      anchorPromptTokens: value.anchorPromptTokens,
      estimatedDeltaTokens: value.estimatedDeltaTokens,
    };
  }
  throw new WebChatContractError("服务端返回了无效的 Token 估算。");
}

function parseContextFailure(value: unknown): ContextFailure {
  if (
    !isRecord(value) ||
    !hasExactFields(value, ["kind", "message"]) ||
    !isContextFailureKind(value.kind) ||
    typeof value.message !== "string" ||
    value.message.length === 0 ||
    value.message.length > 1_000
  ) {
    throw new WebChatContractError("服务端返回了无效的上下文失败信息。");
  }
  return {
    kind: value.kind,
    message: value.message,
  };
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
      "promptCache",
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
      promptCache: parsePromptCacheUsage(value.promptCache),
    };
  }
  throw invalidEvent();
}

function parsePromptCacheUsage(value: unknown): PromptCacheUsage {
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
    value.availability === "tokens" &&
    hasExactFields(value, ["availability", "cachedTokens"]) &&
    isNonNegativeInteger(value.cachedTokens)
  ) {
    return { availability: "tokens", cachedTokens: value.cachedTokens };
  }
  if (
    value.availability === "status" &&
    hasExactFields(value, ["availability", "hit"]) &&
    typeof value.hit === "boolean"
  ) {
    return { availability: "status", hit: value.hit };
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

function isIterationLimit(value: unknown): value is AgentIterationLimit {
  return value === "unlimited" || isPositiveInteger(value, 32);
}

const STOP_REASONS = new Set<AgentStopReason>([
  "final-response",
  "max-iterations",
  "max-runtime",
  "cancelled",
  "repeated-unknown-tool",
  "repeated-tool-failure",
  "context-error",
  "context-capacity",
  "context-circuit-open",
  "model-error",
  "agent-error",
]);

const CONTEXT_FAILURE_KINDS: ReadonlySet<string> = new Set([
  "summary-network",
  "summary-protocol",
  "summary-format",
  "storage",
  "capacity",
  "concurrent",
  "session",
  "cancelled",
]);

function isContextFailureKind(value: unknown): value is ContextFailure["kind"] {
  return typeof value === "string" &&
    CONTEXT_FAILURE_KINDS.has(value);
}

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
  "dangerous-operation",
  "workspace-boundary",
  "permission-config",
  "user-denied",
  "approval-invalid",
  "context-reference",
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

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "strict" || value === "default" || value === "permissive";
}

function isPermissionUserDecision(
  value: unknown,
): value is PermissionUserDecision {
  return (
    value === "allow-once" ||
    value === "allow-session" ||
    value === "allow-permanent" ||
    value === "deny"
  );
}

function isPermissionResolutionStatus(
  value: unknown,
): value is "allowed" | "denied" | "expired" | "cancelled" | "invalid" {
  return (
    value === "allowed" ||
    value === "denied" ||
    value === "expired" ||
    value === "cancelled" ||
    value === "invalid"
  );
}

function isPermissionScope(
  value: unknown,
): value is "once" | "session" | "permanent" {
  return value === "once" || value === "session" || value === "permanent";
}

function isSafePermissionId(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length <= maximum &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

function isSafeWorkspaceSummary(
  value: unknown,
): value is { readonly id: string; readonly name: string } {
  return (
    isRecord(value) &&
    hasExactFields(value, ["id", "name"]) &&
    typeof value.id === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.id) &&
    typeof value.name === "string" &&
    value.name.trim().length > 0 &&
    value.name.length <= MAX_WEB_WORKSPACE_NAME_LENGTH
  );
}

function isPermissionPromptSummary(
  value: unknown,
): value is Readonly<Record<string, string | number | boolean | null>> {
  return (
    isRecord(value) &&
    Object.keys(value).length <= 16 &&
    Object.entries(value).every(
      ([key, item]) =>
        /^[A-Za-z0-9_-]{1,64}$/.test(key) &&
        (item === null ||
          typeof item === "boolean" ||
          (typeof item === "number" && Number.isFinite(item)) ||
          (typeof item === "string" && item.length <= 1_024)),
    )
  );
}

function isPermissionRisk(
  value: unknown,
): value is PermissionPrompt["risk"] {
  return (
    isRecord(value) &&
    hasExactFields(value, ["level", "message"]) &&
    (value.level === "low" || value.level === "medium" || value.level === "high") &&
    typeof value.message === "string" &&
    value.message.length > 0 &&
    value.message.length <= 1_000
  );
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
