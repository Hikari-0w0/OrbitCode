"use client";

import { useEffect, useReducer, useRef, useState } from "react";

import { ChatComposer } from "@/components/chat-composer";
import { waitForCancelledTurnCheckpoint } from "@/components/cancelled-turn-recovery";
import { ConversationList } from "@/components/conversation-list";
import {
  ContextCompressionControl,
  type ContextCompressionUiState,
} from "@/components/context-compression-control";
import {
  chatSessionReducer,
  INITIAL_CHAT_SESSION_STATE,
} from "@/components/chat-session-state";
import { MessageList } from "@/components/message-list";
import { PermissionModeControl } from "@/components/permission-mode-control";
import { WorkspaceSelector } from "@/components/workspace-selector";
import type { AgentMode } from "@/core/agent-events";
import type {
  ConversationSummary,
} from "@/core/conversations/types";
import type { PermissionUserDecision } from "@/core/permissions/approval";
import type { PermissionMode } from "@/core/permissions/types";
import type { PlainConversationMessage } from "@/models/provider";
import {
  parseProviderCatalogResponse,
  parseConversationCatalogResponse,
  parseConversationDetailResponse,
  parseContextCompressionResponse,
  parsePermissionDecisionResponse,
  parsePermissionSessionResponse,
  parseWebApiError,
  parseWebChatEvents,
  parseWorkspaceCatalogResponse,
  readWebStream,
  type ProviderSummary,
  type ConversationDetailResponse,
  type WebApiError,
  type WebChatRequest,
  type WorkspaceSummary,
} from "@/web/chat-contract";

const PLAN_EXECUTION_PROMPT = "请按照上述计划开始执行。";
const PROGRESS_RENDER_INTERVAL_MS = 100;

type CatalogState = "loading" | "ready" | "config-error";
type UiStatus = "loading" | "ready" | "streaming" | "stopping" | "config-error";
type PermissionSessionUi =
  | { readonly status: "loading"; readonly mode: PermissionMode }
  | { readonly status: "ready"; readonly id: string; readonly mode: PermissionMode }
  | { readonly status: "error"; readonly mode: PermissionMode; readonly error: string };
type ConversationUiState = "loading" | "ready" | "error";

export function ChatWorkspace() {
  const [session, dispatch] = useReducer(
    chatSessionReducer,
    INITIAL_CHAT_SESSION_STATE,
  );
  const [providers, setProviders] = useState<readonly ProviderSummary[]>([]);
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceSummary[]>([]);
  const [catalogState, setCatalogState] = useState<CatalogState>("loading");
  const [catalogError, setCatalogError] = useState<string>();
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [permissionRevision, setPermissionRevision] = useState(0);
  const [conversationRevision, setConversationRevision] = useState(0);
  const [conversations, setConversations] = useState<readonly ConversationSummary[]>([]);
  const [conversationState, setConversationState] = useState<ConversationUiState>("loading");
  const [conversationError, setConversationError] = useState<string>();
  const [permissionSession, setPermissionSession] = useState<PermissionSessionUi>({
    status: "loading",
    mode: "default",
  });
  const [permissionModeUpdating, setPermissionModeUpdating] = useState(false);
  const [compressionState, setCompressionState] =
    useState<ContextCompressionUiState>({ status: "idle" });
  const [conversationExporting, setConversationExporting] = useState(false);
  const activeRequestRef = useRef<AbortController | undefined>(undefined);
  const manualStopRequestRef = useRef<AbortController | undefined>(undefined);
  const runStartedAtRef = useRef<number | undefined>(undefined);
  const sessionRef = useRef(session);
  const permissionSessionRef = useRef(permissionSession);
  sessionRef.current = session;
  permissionSessionRef.current = permissionSession;

  useEffect(() => {
    const controller = new AbortController();
    async function createSession(): Promise<void> {
      try {
        const response = await fetch("/api/permission-sessions", {
          method: "POST",
          cache: "no-store",
          signal: controller.signal,
        });
        const value: unknown = await response.json();
        if (!response.ok) {
          throw new Error(parseWebApiError(value)?.error ?? "无法创建权限会话。");
        }
        const created = parsePermissionSessionResponse(value);
        setPermissionSession({
          status: "ready",
          id: created.sessionId,
          mode: created.mode,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        setPermissionSession({
          status: "error",
          mode: "default",
          error: safeErrorMessage(error, "无法创建权限会话。"),
        });
      }
    }
    void createSession();
    return () => controller.abort();
  }, [permissionRevision]);

  useEffect(() => {
    const controller = new AbortController();
    async function loadCatalogs(): Promise<void> {
      setCatalogState("loading");
      setCatalogError(undefined);
      try {
        const [providerResponse, workspaceResponse] = await Promise.all([
          fetch("/api/providers", { cache: "no-store", signal: controller.signal }),
          fetch("/api/workspaces", { cache: "no-store", signal: controller.signal }),
        ]);
        const [providerValue, workspaceValue]: readonly unknown[] = await Promise.all([
          providerResponse.json(),
          workspaceResponse.json(),
        ]);
        if (!providerResponse.ok) {
          throw new Error(
            parseWebApiError(providerValue)?.error ?? "无法加载模型配置。",
          );
        }
        if (!workspaceResponse.ok) {
          throw new Error(
            parseWebApiError(workspaceValue)?.error ?? "无法加载 Workspace 列表。",
          );
        }

        const providerCatalog = parseProviderCatalogResponse(providerValue);
        const workspaceCatalog = parseWorkspaceCatalogResponse(workspaceValue);
        const availableProvider = providerCatalog.providers.find(
          (provider) => provider.available,
        );
        const defaultWorkspace = workspaceCatalog.workspaces.find(
          (workspace) =>
            workspace.id === workspaceCatalog.defaultWorkspaceId && workspace.available,
        );
        setProviders(providerCatalog.providers);
        setWorkspaces(workspaceCatalog.workspaces);

        const fallbackProvider = availableProvider ?? providerCatalog.providers[0];
        const fallbackWorkspace = defaultWorkspace ?? workspaceCatalog.workspaces[0];
        if (!fallbackProvider || !fallbackWorkspace) {
          throw new Error("没有可用于恢复会话绑定的 Provider 或 Workspace 配置。");
        }

        const current = sessionRef.current;
        const selectedProvider = providerCatalog.providers.some(
          (provider) =>
            provider.name === current.selectedProvider && provider.available,
        )
          ? current.selectedProvider
          : fallbackProvider.name;
        const selectedWorkspaceId = workspaceCatalog.workspaces.some(
          (workspace) =>
            workspace.id === current.selectedWorkspaceId && workspace.available,
        )
          ? current.selectedWorkspaceId
          : fallbackWorkspace.id;

        if (
          current.selectedWorkspaceId &&
          current.selectedWorkspaceId !== selectedWorkspaceId
        ) {
          dispatch({ type: "workspace-selected", workspaceId: selectedWorkspaceId });
        }
        if (
          current.selectedProvider &&
          current.selectedProvider !== selectedProvider
        ) {
          dispatch({ type: "provider-selected", provider: selectedProvider });
        }
        dispatch({
          type: "catalogs-ready",
          workspaceId: selectedWorkspaceId,
          provider: selectedProvider,
        });
        dispatch({
          type: "notice-set",
          notice: availableProvider && defaultWorkspace
            ? undefined
            : "当前运行配置不可用；已保存的会话仍可只读查看。",
        });
        setCatalogState("ready");
      } catch (error) {
        if (controller.signal.aborted) return;
        setCatalogState("config-error");
        setCatalogError(safeErrorMessage(error, "无法加载本地配置。"));
      }
    }
    void loadCatalogs();
    return () => controller.abort();
  }, [catalogRevision]);

  useEffect(() => {
    if (
      catalogState !== "ready" ||
      !session.selectedProvider ||
      !session.selectedWorkspaceId
    ) return;
    const controller = new AbortController();
    async function restoreConversation(): Promise<void> {
      setConversationState("loading");
      setConversationError(undefined);
      try {
        const response = await fetch("/api/conversations", {
          cache: "no-store",
          signal: controller.signal,
        });
        const value: unknown = await response.json();
        if (!response.ok) {
          throw new Error(parseWebApiError(value)?.error ?? "无法加载本地会话。");
        }
        const catalog = parseConversationCatalogResponse(value);
        setConversations(catalog.conversations);
        const remembered = window.localStorage.getItem("orbitcode.activeConversationId");
        const selected = catalog.conversations.find((item) => item.id === remembered)
          ?? catalog.conversations[0];
        if (selected) {
          if (!await loadConversation(selected.id, controller.signal, false)) return;
        } else {
          if (!await createConversation(
            session.selectedWorkspaceId,
            session.selectedProvider,
            controller.signal,
            false,
          )) return;
        }
        setConversationState("ready");
      } catch (error) {
        if (controller.signal.aborted) return;
        const detail = safeErrorMessage(error, "无法恢复本地会话。");
        setConversationState("error");
        setConversationError(detail);
      }
    }
    void restoreConversation();
    return () => controller.abort();
    // 仅在显式刷新或配置初次就绪时恢复，切换会话由事件处理器完成。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogState, conversationRevision]);

  useEffect(() => () => {
    activeRequestRef.current?.abort();
    const current = permissionSessionRef.current;
    if (current.status === "ready") closePermissionSession(current.id);
  }, []);

  const currentProvider = providers.find(
    (provider) => provider.name === session.selectedProvider,
  );
  const isStreaming =
    session.requestState === "streaming" || session.requestState === "stopping";
  const isAwaitingPermission = session.messages.some((message) =>
    message.toolExecutions?.some(
      (execution) => execution.state === "awaiting-approval",
    ),
  );
  const status: UiStatus = isStreaming
    ? session.requestState
    : catalogState === "ready"
      ? "ready"
      : catalogState;
  const controlsDisabled =
    catalogState !== "ready" ||
    permissionSession.status !== "ready" ||
    conversationState !== "ready" ||
    session.conversationAvailability !== "ready" ||
    !session.conversationId ||
    (isStreaming && !isAwaitingPermission);
  const notice =
    catalogError ??
    (permissionSession.status === "error" ? permissionSession.error : undefined) ??
    conversationError ??
    session.notice;

  function selectWorkspace(workspaceId: string): void {
    if (controlsDisabled) return;
    if (!workspaces.some((workspace) => workspace.id === workspaceId && workspace.available)) {
      return;
    }
    void createConversation(workspaceId, sessionRef.current.selectedProvider);
  }

  function selectProvider(provider: string): void {
    if (controlsDisabled) return;
    if (!providers.some((candidate) => candidate.name === provider && candidate.available)) {
      return;
    }
    void createConversation(sessionRef.current.selectedWorkspaceId, provider);
  }

  function resetPermissionSession(): void {
    activeRequestRef.current?.abort();
    const current = permissionSessionRef.current;
    if (current.status === "ready") closePermissionSession(current.id);
    setPermissionSession((value) => ({ status: "loading", mode: value.mode }));
    setCompressionState({ status: "idle" });
    setPermissionRevision((value) => value + 1);
  }

  async function loadConversation(
    conversationId: string,
    signal?: AbortSignal,
    renewPermission = true,
  ): Promise<boolean> {
    if (activeRequestRef.current) return false;
    const hadStableConversation = sessionRef.current.conversationId.length > 0;
    setConversationState("loading");
    setConversationError(undefined);
    try {
      const response = await fetch(`/api/conversations/${conversationId}`, {
        cache: "no-store",
        signal,
      });
      const value: unknown = await response.json();
      if (!response.ok) {
        throw new Error(parseWebApiError(value)?.error ?? "无法打开本地会话。");
      }
      let detail = parseConversationDetailResponse(value);
      if (detail.activity.status === "interrupted") {
        const recovery = await fetch(`/api/conversations/${conversationId}/recover`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedRevision: detail.activity.expectedRevision }),
          cache: "no-store",
          signal,
        });
        const recoveredValue: unknown = await recovery.json();
        if (!recovery.ok) {
          throw new Error(
            parseWebApiError(recoveredValue)?.error ?? "无法恢复上次中断的会话。",
          );
        }
        detail = parseConversationDetailResponse(recoveredValue);
      }
      const activeElsewhere = detail.activity.status === "active";
      dispatch({
        type: "conversation-loaded",
        conversationId: detail.summary.id,
        revision: detail.summary.revision,
        workspaceId: detail.summary.workspaceId,
        provider: detail.summary.providerId,
        mode: detail.mode,
        modeTurn: detail.modeTurn,
        messages: detail.displayMessages,
        availability: activeElsewhere ? "read-only" : detail.availability,
        notice: activeElsewhere
          ? "当前会话正在另一个页面中运行；这里显示最近完整记录。"
          : detail.unavailableReason,
      });
      window.localStorage.setItem("orbitcode.activeConversationId", detail.summary.id);
      if (renewPermission) resetPermissionSession();
      setConversationState("ready");
      return true;
    } catch (error) {
      if (signal?.aborted) {
        setConversationState(hadStableConversation ? "ready" : "error");
        return false;
      }
      setConversationState(hadStableConversation ? "ready" : "error");
      setConversationError(safeErrorMessage(error, "无法打开本地会话。"));
      return false;
    }
  }

  async function createConversation(
    workspaceId: string,
    providerId: string,
    signal?: AbortSignal,
    renewPermission = true,
  ): Promise<boolean> {
    if (!workspaceId || !providerId || activeRequestRef.current) return false;
    const hadStableConversation = sessionRef.current.conversationId.length > 0;
    setConversationState("loading");
    setConversationError(undefined);
    try {
      const response = await fetch("/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, providerId }),
        cache: "no-store",
        signal,
      });
      const value: unknown = await response.json();
      if (!response.ok) {
        throw new Error(parseWebApiError(value)?.error ?? "无法创建本地会话。");
      }
      const checkpoint = parseConversationDetailResponse(value);
      applyCheckpoint(checkpoint);
      window.localStorage.setItem("orbitcode.activeConversationId", checkpoint.summary.id);
      setConversations((current) => [checkpoint.summary, ...current]);
      if (renewPermission) resetPermissionSession();
      setConversationState("ready");
      return true;
    } catch (error) {
      if (signal?.aborted) {
        setConversationState(hadStableConversation ? "ready" : "error");
        return false;
      }
      const detail = safeErrorMessage(error, "无法创建本地会话。");
      setConversationState(hadStableConversation ? "ready" : "error");
      setConversationError(detail);
      return false;
    }
  }

  function applyCheckpoint(checkpoint: ConversationDetailResponse): void {
    dispatch({
      type: "conversation-loaded",
      conversationId: checkpoint.summary.id,
      revision: checkpoint.summary.revision,
      workspaceId: checkpoint.summary.workspaceId,
      provider: checkpoint.summary.providerId,
      mode: checkpoint.mode,
      modeTurn: checkpoint.modeTurn,
      messages: checkpoint.displayMessages,
      availability: checkpoint.availability,
      notice: checkpoint.unavailableReason,
    });
  }

  async function refreshConversationList(): Promise<void> {
    const response = await fetch("/api/conversations", { cache: "no-store" });
    const value: unknown = await response.json();
    if (!response.ok) throw new Error(parseWebApiError(value)?.error ?? "无法刷新会话列表。");
    setConversations(parseConversationCatalogResponse(value).conversations);
  }

  async function renameConversation(): Promise<void> {
    const snapshot = sessionRef.current;
    if (!snapshot.conversationId || snapshot.requestState !== "idle") return;
    const currentTitle = conversations.find((item) => item.id === snapshot.conversationId)?.title ?? "新对话";
    const title = window.prompt("输入新的会话标题", currentTitle)?.trim();
    if (!title || title === currentTitle) return;
    try {
      const response = await fetch(`/api/conversations/${snapshot.conversationId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: snapshot.revision, title }),
      });
      const value: unknown = await response.json();
      if (!response.ok) throw new Error(parseWebApiError(value)?.error ?? "无法重命名会话。");
      applyCheckpoint(parseConversationDetailResponse(value));
      await refreshConversationList();
    } catch (error) {
      dispatch({ type: "notice-set", notice: safeErrorMessage(error, "无法重命名会话。") });
    }
  }

  async function clearConversation(): Promise<void> {
    const snapshot = sessionRef.current;
    if (!snapshot.conversationId || snapshot.requestState !== "idle") return;
    if (!window.confirm("清空当前会话的消息和上下文？会话本身会保留。")) return;
    try {
      const response = await fetch(`/api/conversations/${snapshot.conversationId}/clear`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: snapshot.revision }),
      });
      const value: unknown = await response.json();
      if (!response.ok) throw new Error(parseWebApiError(value)?.error ?? "无法清空会话。");
      applyCheckpoint(parseConversationDetailResponse(value));
      await refreshConversationList();
    } catch (error) {
      dispatch({ type: "notice-set", notice: safeErrorMessage(error, "无法清空会话。") });
    }
  }

  async function deleteConversation(): Promise<void> {
    const snapshot = sessionRef.current;
    if (!snapshot.conversationId || snapshot.requestState !== "idle") return;
    if (!window.confirm("删除当前会话及其本地上下文记录？此操作不可撤销。")) return;
    try {
      const response = await fetch(`/api/conversations/${snapshot.conversationId}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: snapshot.revision }),
      });
      if (!response.ok) {
        const value: unknown = await response.json().catch(() => undefined);
        throw new Error(parseWebApiError(value)?.error ?? "无法删除会话。");
      }
      window.localStorage.removeItem("orbitcode.activeConversationId");
      resetPermissionSession();
      setConversationRevision((value) => value + 1);
    } catch (error) {
      dispatch({ type: "notice-set", notice: safeErrorMessage(error, "无法删除会话。") });
    }
  }

  async function retryUnsavedTurn(): Promise<void> {
    const snapshot = sessionRef.current;
    if (!snapshot.conversationId || snapshot.unsavedExpectedRevision === undefined) return;
    try {
      const response = await fetch(`/api/conversations/${snapshot.conversationId}/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: snapshot.unsavedExpectedRevision }),
      });
      const value: unknown = await response.json();
      if (!response.ok) throw new Error(parseWebApiError(value)?.error ?? "无法重试保存。");
      applyCheckpoint(parseConversationDetailResponse(value));
      await refreshConversationList();
    } catch (error) {
      dispatch({ type: "notice-set", notice: safeErrorMessage(error, "无法重试保存。") });
    }
  }

  async function exportConversation(): Promise<void> {
    const snapshot = sessionRef.current;
    if (
      !snapshot.conversationId ||
      snapshot.requestState !== "idle" ||
      conversationExporting
    ) return;
    setConversationExporting(true);
    try {
      const response = await fetch(
        `/api/conversations/${snapshot.conversationId}/export`,
        { method: "POST", cache: "no-store" },
      );
      if (!response.ok) {
        const value: unknown = await response.json().catch(() => undefined);
        throw new Error(parseWebApiError(value)?.error ?? "无法导出完整对话记录。");
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = exportFilename(response.headers.get("content-disposition"));
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      dispatch({
        type: "notice-set",
        notice: safeErrorMessage(error, "无法导出完整对话记录。"),
      });
    } finally {
      setConversationExporting(false);
    }
  }

  async function selectPermissionMode(mode: PermissionMode): Promise<void> {
    const current = permissionSessionRef.current;
    if (current.status !== "ready" || permissionModeUpdating || current.mode === mode) {
      return;
    }
    setPermissionModeUpdating(true);
    try {
      const response = await fetch(`/api/permission-sessions/${current.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const value: unknown = await response.json();
      if (!response.ok) {
        throw new Error(parseWebApiError(value)?.error ?? "无法更新权限模式。");
      }
      const updated = parsePermissionSessionResponse(value);
      if (permissionSessionRef.current.status === "ready" && permissionSessionRef.current.id === updated.sessionId) {
        setPermissionSession({ status: "ready", id: updated.sessionId, mode: updated.mode });
      }
    } catch (error) {
      dispatch({
        type: "notice-set",
        notice: safeErrorMessage(error, "无法更新权限模式。"),
      });
    } finally {
      setPermissionModeUpdating(false);
    }
  }

  function selectMode(mode: AgentMode, clearDraft = false): void {
    if (controlsDisabled) return;
    dispatch({
      type: "mode-selected",
      mode,
      clearDraft,
      notice:
        mode === "plan"
          ? "已切换到 Plan Mode：服务端只会开放读取、查找和搜索工具。"
          : "已切换到 Do Mode：服务端已恢复全部 Workspace 工具。",
    });
  }

  function submitMessage(): void {
    const input = sessionRef.current.draft.trim();
    if (input === "/plan" || input === "/do") {
      selectMode(input === "/plan" ? "plan" : "do", true);
      return;
    }
    void submitInput(input, sessionRef.current.mode);
  }

  async function submitInput(
    input: string,
    requestMode: AgentMode,
    requiredPlanMessageId?: string,
  ): Promise<void> {
    const snapshot = sessionRef.current;
    if (
      catalogState !== "ready" ||
      input.length === 0 ||
      !snapshot.selectedProvider ||
      !snapshot.selectedWorkspaceId ||
      !snapshot.conversationId ||
      snapshot.conversationAvailability !== "ready" ||
      permissionSessionRef.current.status !== "ready" ||
      snapshot.requestState !== "idle" ||
      activeRequestRef.current ||
      (requiredPlanMessageId !== undefined &&
        snapshot.executablePlanMessageId !== requiredPlanMessageId)
    ) return;

    const userMessage: PlainConversationMessage = { role: "user", content: input };
    const modeTurn = snapshot.mode === requestMode ? snapshot.modeTurn + 1 : 1;
    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    const controller = new AbortController();
    const permissionSessionId = permissionSessionRef.current.status === "ready"
      ? permissionSessionRef.current.id
      : undefined;
    if (!permissionSessionId) return;
    runStartedAtRef.current = Date.now();
    activeRequestRef.current = controller;
    dispatch({
      type: "request-started",
      mode: requestMode,
      modeTurn,
      userId,
      assistantId,
      userMessage,
    });

    let stopped = false;
    let reconcileCancelledTurn = false;
    let lastProgressRenderedAt = 0;
    let lastProgressSignature = "";
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId: snapshot.conversationId,
          revision: snapshot.revision,
          permissionSessionId,
          mode: requestMode,
          modeTurn,
          input,
        } satisfies WebChatRequest),
        signal: controller.signal,
      });
      if (!response.ok) {
        const value: unknown = await response.json().catch(() => undefined);
        const apiError = parseWebApiError(value);
        throw new WebRequestError(
          apiError?.error ?? "模型请求失败，请重试。",
          apiError?.code,
        );
      }
      if (!response.headers.get("content-type")?.startsWith("text/event-stream")) {
        throw new Error("聊天服务没有返回 SSE 响应。");
      }
      if (!response.body) throw new Error("模型服务没有返回响应流。");

      for await (const event of parseWebChatEvents(readWebStream(response.body))) {
        if (event.type === "text-delta") {
          dispatch({
            type: "text-delta",
            assistantId,
            iteration: event.iteration,
            text: event.text,
          });
        } else if (event.type === "progress") {
          const now = Date.now();
          const signature = [
            event.iteration,
            event.phase,
            event.model?.stage ?? "",
            event.model?.attempt ?? "",
            event.model?.toolName ?? "",
          ].join(":");
          if (
            signature !== lastProgressSignature ||
            now - lastProgressRenderedAt >= PROGRESS_RENDER_INTERVAL_MS
          ) {
            dispatch({ type: "progress", assistantId, event });
            lastProgressRenderedAt = now;
            lastProgressSignature = signature;
          }
        } else if (event.type === "tool-call") {
          dispatch({ type: "tool-call", assistantId, event });
        } else if (event.type === "tool-started") {
          dispatch({ type: "tool-started", assistantId, event });
        } else if (event.type === "permission-requested") {
          dispatch({ type: "permission-requested", assistantId, event });
        } else if (event.type === "permission-resolved") {
          dispatch({ type: "permission-resolved", assistantId, event });
        } else if (event.type === "tool-result") {
          dispatch({ type: "tool-result", assistantId, event });
        } else if (event.type === "token-usage") {
          dispatch({ type: "token-usage", assistantId, event });
        } else if (event.type === "stopped") {
          stopped = true;
          if (event.reason === "final-response" && event.finalMessage) {
            dispatch({
              type: "request-completed",
              assistantId,
              userMessage,
              finalMessage: event.finalMessage,
              mode: requestMode,
              event,
            });
          } else {
            dispatch({ type: "request-stopped", assistantId, event });
          }
          if (event.persistence?.status === "saved") {
            void refreshConversationList().catch(() => undefined);
          }
        }
      }
      if (!stopped) throw new Error("流式响应意外结束，请重试。");
    } catch (error) {
      const cancelled = controller.signal.aborted;
      reconcileCancelledTurn = cancelled && manualStopRequestRef.current === controller;
      if (reconcileCancelledTurn) {
        setConversationState("loading");
        setConversationError(undefined);
      }
      const detail = cancelled
        ? "回复已停止，已生成的进度会保留在后续上下文中。"
        : safeErrorMessage(error, "模型请求失败，请重试。");
      dispatch({
        type: "request-transport-failed",
        assistantId,
        detail,
        cancelled,
      });
      if (
        error instanceof WebRequestError &&
        error.code?.startsWith("workspace-")
      ) {
        setCatalogState("config-error");
        setCatalogError(detail);
      } else if (
        error instanceof WebRequestError &&
        error.code?.startsWith("conversation-")
      ) {
        setConversationState("error");
        setConversationError(detail);
      }
    } finally {
      if (manualStopRequestRef.current === controller) {
        manualStopRequestRef.current = undefined;
      }
      if (activeRequestRef.current === controller) {
        activeRequestRef.current = undefined;
      }
      dispatch({ type: "request-settled" });
    }
    if (reconcileCancelledTurn) {
      await reconcileCancelledConversation(
        snapshot.conversationId,
        snapshot.revision,
      );
    }
  }

  async function reconcileCancelledConversation(
    conversationId: string,
    previousRevision: number,
  ): Promise<void> {
    try {
      const checkpoint = await waitForCancelledTurnCheckpoint({
        previousRevision,
        load: async () => {
          const response = await fetch(`/api/conversations/${conversationId}`, {
            cache: "no-store",
          });
          const value: unknown = await response.json();
          if (!response.ok) {
            throw new Error(
              parseWebApiError(value)?.error ?? "无法同步停止后的会话记录。",
            );
          }
          return parseConversationDetailResponse(value);
        },
      });
      if (sessionRef.current.conversationId !== conversationId) return;
      applyCheckpoint(checkpoint);
      setConversations((current) => [
        checkpoint.summary,
        ...current.filter((item) => item.id !== checkpoint.summary.id),
      ]);
      setConversationState("ready");
    } catch (error) {
      if (sessionRef.current.conversationId !== conversationId) return;
      setConversationState("error");
      setConversationError(
        safeErrorMessage(error, "无法同步停止后的会话记录。"),
      );
    }
  }

  async function submitPermissionDecision(
    requestId: string,
    decision: PermissionUserDecision,
  ): Promise<void> {
    const current = permissionSessionRef.current;
    if (current.status !== "ready") return;
    dispatch({ type: "permission-submitting", requestId });
    try {
      const response = await fetch(
        `/api/permission-sessions/${current.id}/decisions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestId, decision }),
        },
      );
      const value: unknown = await response.json();
      if (!response.ok) {
        throw new Error(parseWebApiError(value)?.error ?? "无法提交授权决定。");
      }
      parsePermissionDecisionResponse(value);
      dispatch({ type: "permission-submitted", requestId });
    } catch (error) {
      dispatch({
        type: "permission-submit-failed",
        requestId,
        error: safeErrorMessage(error, "无法提交授权决定，请重试。"),
      });
    }
  }

  async function compressContext(): Promise<void> {
    if (
      !sessionRef.current.conversationId ||
      sessionRef.current.conversationAvailability !== "ready" ||
      sessionRef.current.requestState !== "idle" ||
      compressionState.status === "compressing"
    ) return;

    setCompressionState({ status: "compressing" });
    try {
      const response = await fetch(
        `/api/conversations/${sessionRef.current.conversationId}/compress`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedRevision: sessionRef.current.revision }),
        },
      );
      const value: unknown = await response.json();
      if (!response.ok) {
        throw new WebRequestError(
          parseWebApiError(value)?.error ?? "无法压缩上下文。",
          parseWebApiError(value)?.code,
        );
      }
      const parsed = parseContextCompressionResponse(value);
      setCompressionState(parsed);
      if (parsed.status === "succeeded") {
        await loadConversation(sessionRef.current.conversationId, undefined, false);
        await refreshConversationList();
      }
    } catch (error) {
      setCompressionState({ status: "idle" });
      dispatch({
        type: "notice-set",
        notice: safeErrorMessage(error, "无法压缩上下文。"),
      });
    }
  }

  function executePlan(messageId: string): void {
    void submitInput(PLAN_EXECUTION_PROMPT, "do", messageId);
  }

  function stopGeneration(): void {
    const controller = activeRequestRef.current;
    if (!controller || session.requestState !== "streaming") return;
    manualStopRequestRef.current = controller;
    dispatch({ type: "request-stopping" });
    controller.abort();
  }

  return (
    <main className="appFrame">
      <aside className="sidebar">
        <div className="brandBlock">
          <OrbitMark />
          <div>
            <p className="brandName">OrbitCode</p>
            <p className="brandTagline">LOCAL AI WORKSPACE</p>
          </div>
        </div>

        <div className="phaseCard">
          <div className="phaseHeader">
            <span>PHASE 04</span>
            <span className="liveBadge"><i /> LIVE</span>
          </div>
          <strong>Workspace · Plan · Execute</strong>
          <p>选择授权项目，只读规划，确认后在同一上下文自主执行</p>
        </div>

        <ConversationList
          conversations={conversations}
          selectedId={session.conversationId}
          disabled={isStreaming || conversationState !== "ready" || catalogState !== "ready"}
          onSelect={(conversationId) => void loadConversation(conversationId)}
          onCreate={() => void createConversation(session.selectedWorkspaceId, session.selectedProvider)}
          onRename={() => void renameConversation()}
          onDelete={() => void deleteConversation()}
        />

        <WorkspaceSelector
          workspaces={workspaces}
          selectedWorkspaceId={session.selectedWorkspaceId}
          disabled={controlsDisabled}
          onChange={selectWorkspace}
        />

        <div className="providerSection">
          <label htmlFor="provider-select">MODEL PROVIDER</label>
          <div className="selectWrap">
            <select
              id="provider-select"
              aria-label="MODEL PROVIDER"
              value={session.selectedProvider}
              disabled={controlsDisabled}
              onChange={(event) => selectProvider(event.target.value)}
            >
              {providers.length === 0 && <option value="">等待配置</option>}
              {providers.map((provider) => (
                <option key={provider.name} value={provider.name} disabled={!provider.available}>
                  {provider.name}{provider.available ? "" : "（不可用）"}
                </option>
              ))}
            </select>
            <ChevronIcon />
          </div>
          {currentProvider && (
            <div className="modelMeta">
              <span className={currentProvider.available ? "statusDot" : "statusDot statusDot--off"} />
              <span>{currentProvider.model}</span>
            </div>
          )}
        </div>

        <PermissionModeControl
          mode={permissionSession.mode}
          disabled={permissionSession.status !== "ready"}
          updating={permissionModeUpdating}
          onChange={(mode) => void selectPermissionMode(mode)}
        />

        <div className="sessionInfo">
          <div><span>当前模式</span><strong>{modeLabel(session.mode)}</strong></div>
          <div><span>工具范围</span><strong>{session.mode === "plan" ? "只读三项" : "完整 Workspace"}</strong></div>
          <div><span>权限模式</span><strong>{permissionModeLabel(permissionSession.mode)}</strong></div>
          <div><span>上下文</span><strong>{conversationContextLabel(session.conversationAvailability)}</strong></div>
        </div>

        <div className="sidebarFooter">
          <span className="shieldIcon" aria-hidden="true">◇</span>
          <div>
            <strong>SERVER ENFORCED</strong>
            <span>Workspace 与模式权限由服务端校验</span>
          </div>
        </div>
      </aside>

      <section className="chatPanel" aria-label="OrbitCode 对话工作区">
        <header className="chatHeader">
          <div>
            <p className="chatKicker">SESSION / {session.selectedWorkspaceId || "LOADING"}</p>
            <h2>对话工作区</h2>
          </div>
          <div className="headerActions">
            <button
              className="exportButton"
              type="button"
              aria-label="导出完整对话"
              onClick={() => void exportConversation()}
              disabled={
                conversationExporting ||
                isStreaming ||
                conversationState !== "ready" ||
                !session.conversationId
              }
            >
              <DownloadIcon />
              {conversationExporting ? "导出中…" : "导出对话"}
            </button>
            <ContextCompressionControl
              state={compressionState}
              disabled={
                session.conversationAvailability !== "ready" ||
                isStreaming ||
                isAwaitingPermission
              }
              onCompress={() => void compressContext()}
            />
            <span className={`modeBadge modeBadge--${session.mode}`}>
              {modeLabel(session.mode)}
            </span>
            <span className={`connectionState connectionState--${status}`}>
              <i /> {statusLabel(status)}
            </span>
            <button
              className="clearButton"
              type="button"
              onClick={() => void clearConversation()}
              disabled={!isAwaitingPermission && (isStreaming || (session.messages.length === 0 && session.mode === "do"))}
            >
              <TrashIcon />
              清空
            </button>
          </div>
        </header>

        <div className="noticeSlot">
          {notice && (
            <div className="noticeBanner" role="status">
              <span>!</span>
              <p>{notice}</p>
              {catalogState === "config-error" && (
                <button type="button" onClick={() => setCatalogRevision((value) => value + 1)}>
                  重新加载
                </button>
              )}
              {conversationState === "error" && (
                <button type="button" onClick={() => setConversationRevision((value) => value + 1)}>
                  重新加载会话
                </button>
              )}
              {session.unsavedExpectedRevision !== undefined && (
                <button type="button" onClick={() => void retryUnsavedTurn()}>
                  重试保存
                </button>
              )}
            </div>
          )}
        </div>

        <MessageList
          messages={session.messages}
          currentRunStartedAtMs={isStreaming ? runStartedAtRef.current : undefined}
          onSuggestion={(draft) => dispatch({ type: "draft-changed", draft })}
          executablePlanMessageId={session.executablePlanMessageId}
          planActionDisabled={controlsDisabled}
          onExecutePlan={executePlan}
          onPermissionDecision={(requestId, decision) =>
            void submitPermissionDecision(requestId, decision)
          }
        />
        <ChatComposer
          value={session.draft}
          mode={session.mode}
          disabled={
            catalogState !== "ready" ||
            permissionSession.status !== "ready" ||
            conversationState !== "ready" ||
            session.conversationAvailability !== "ready"
          }
          isStreaming={isStreaming}
          isStopping={session.requestState === "stopping"}
          onModeChange={(mode) => selectMode(mode)}
          onChange={(draft) => dispatch({ type: "draft-changed", draft })}
          onSubmit={submitMessage}
          onStop={stopGeneration}
        />
      </section>
    </main>
  );
}

class WebRequestError extends Error {
  constructor(message: string, readonly code?: WebApiError["code"]) {
    super(message);
    this.name = "WebRequestError";
  }
}

function statusLabel(status: UiStatus): string {
  if (status === "loading") return "载入配置";
  if (status === "streaming") return "Agent 运行中";
  if (status === "stopping") return "正在停止";
  if (status === "config-error") return "配置异常";
  return "准备就绪";
}

function modeLabel(mode: AgentMode): string {
  return mode === "plan" ? "PLAN MODE" : "DO MODE";
}

function permissionModeLabel(mode: PermissionMode): string {
  if (mode === "strict") return "严格";
  if (mode === "permissive") return "放行";
  return "默认";
}

function conversationContextLabel(
  availability: "loading" | "ready" | "read-only",
): string {
  if (availability === "loading") return "连接中";
  if (availability === "read-only") return "只读历史";
  return "已持久化";
}

function closePermissionSession(sessionId: string): void {
  void fetch(`/api/permission-sessions/${sessionId}`, {
    method: "DELETE",
    keepalive: true,
  }).catch(() => undefined);
}

function safeErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function exportFilename(contentDisposition: string | null): string {
  const match = /filename="([A-Za-z0-9._-]+)"/.exec(contentDisposition ?? "");
  return match?.[1] ?? "orbitcode-conversation.json";
}

function OrbitMark() {
  return (
    <div className="orbitMark" aria-hidden="true">
      <span className="orbitRing" />
      <span className="orbitCore">O</span>
      <span className="orbitSatellite" />
    </div>
  );
}

function ChevronIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4" /></svg>;
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M6.5 6.5v8m3.5-8v8m3.5-8v8M4 4.5h12M8 4.5v-2h4v2m2.8 0-.7 12.5H5.9L5.2 4.5" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 2.5v10m-4-4 4 4 4-4M4 16.5h12" />
    </svg>
  );
}
