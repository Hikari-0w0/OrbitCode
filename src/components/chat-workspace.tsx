"use client";

import { useEffect, useReducer, useRef, useState } from "react";

import { ChatComposer } from "@/components/chat-composer";
import {
  chatSessionReducer,
  INITIAL_CHAT_SESSION_STATE,
} from "@/components/chat-session-state";
import { MessageList } from "@/components/message-list";
import { WorkspaceSelector } from "@/components/workspace-selector";
import type { AgentMode } from "@/core/agent-events";
import type { PlainConversationMessage } from "@/models/provider";
import {
  parseProviderCatalogResponse,
  parseWebApiError,
  parseWebChatEvents,
  parseWorkspaceCatalogResponse,
  readWebStream,
  type ProviderSummary,
  type WebApiError,
  type WebChatRequest,
  type WorkspaceSummary,
} from "@/web/chat-contract";

const PLAN_EXECUTION_PROMPT = "请按照上述计划开始执行。";

type CatalogState = "loading" | "ready" | "config-error";
type UiStatus = "loading" | "ready" | "streaming" | "stopping" | "config-error";

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
  const activeRequestRef = useRef<AbortController | undefined>(undefined);
  const sessionRef = useRef(session);
  sessionRef.current = session;

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
        if (!availableProvider) {
          throw new Error("没有可用的模型配置，请检查本地 YAML 与 .env。");
        }
        if (!defaultWorkspace) {
          throw new Error("没有可用的 Workspace，请检查本地授权目录配置。");
        }

        setProviders(providerCatalog.providers);
        setWorkspaces(workspaceCatalog.workspaces);

        const current = sessionRef.current;
        const selectedProvider = providerCatalog.providers.some(
          (provider) =>
            provider.name === current.selectedProvider && provider.available,
        )
          ? current.selectedProvider
          : availableProvider.name;
        const selectedWorkspaceId = workspaceCatalog.workspaces.some(
          (workspace) =>
            workspace.id === current.selectedWorkspaceId && workspace.available,
        )
          ? current.selectedWorkspaceId
          : defaultWorkspace.id;

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
        dispatch({ type: "notice-set", notice: undefined });
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

  useEffect(() => () => activeRequestRef.current?.abort(), []);

  const currentProvider = providers.find(
    (provider) => provider.name === session.selectedProvider,
  );
  const isStreaming =
    session.requestState === "streaming" || session.requestState === "stopping";
  const status: UiStatus = isStreaming
    ? session.requestState
    : catalogState === "ready"
      ? "ready"
      : catalogState;
  const controlsDisabled = catalogState !== "ready" || isStreaming;
  const notice = catalogError ?? session.notice;

  function selectWorkspace(workspaceId: string): void {
    if (controlsDisabled) return;
    if (!workspaces.some((workspace) => workspace.id === workspaceId && workspace.available)) {
      return;
    }
    dispatch({ type: "workspace-selected", workspaceId });
  }

  function selectProvider(provider: string): void {
    if (controlsDisabled) return;
    if (!providers.some((candidate) => candidate.name === provider && candidate.available)) {
      return;
    }
    dispatch({ type: "provider-selected", provider });
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
      snapshot.requestState !== "idle" ||
      activeRequestRef.current ||
      (requiredPlanMessageId !== undefined &&
        snapshot.executablePlanMessageId !== requiredPlanMessageId)
    ) return;

    const userMessage: PlainConversationMessage = { role: "user", content: input };
    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    const controller = new AbortController();
    activeRequestRef.current = controller;
    dispatch({
      type: "request-started",
      mode: requestMode,
      userId,
      assistantId,
      userMessage,
    });

    let stopped = false;
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: snapshot.selectedProvider,
          workspaceId: snapshot.selectedWorkspaceId,
          mode: requestMode,
          messages: [...snapshot.history, userMessage],
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
          dispatch({ type: "text-delta", assistantId, text: event.text });
        } else if (event.type === "progress") {
          dispatch({ type: "progress", assistantId, event });
        } else if (event.type === "tool-call") {
          dispatch({ type: "tool-call", assistantId, event });
        } else if (event.type === "tool-started") {
          dispatch({ type: "tool-started", assistantId, event });
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
            });
          } else {
            dispatch({ type: "request-stopped", assistantId, event });
          }
        }
      }
      if (!stopped) throw new Error("流式响应意外结束，请重试。");
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const detail = cancelled
        ? "回复已停止，本轮不会加入后续上下文。"
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
      }
    } finally {
      if (activeRequestRef.current === controller) {
        activeRequestRef.current = undefined;
      }
      dispatch({ type: "request-settled" });
    }
  }

  function executePlan(messageId: string): void {
    void submitInput(PLAN_EXECUTION_PROMPT, "do", messageId);
  }

  function stopGeneration(): void {
    if (!activeRequestRef.current || session.requestState !== "streaming") return;
    dispatch({ type: "request-stopping" });
    activeRequestRef.current.abort();
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

        <div className="sessionInfo">
          <div><span>当前模式</span><strong>{modeLabel(session.mode)}</strong></div>
          <div><span>工具范围</span><strong>{session.mode === "plan" ? "只读三项" : "完整 Workspace"}</strong></div>
          <div><span>存储</span><strong>仅当前页面</strong></div>
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
            <span className={`modeBadge modeBadge--${session.mode}`}>
              {modeLabel(session.mode)}
            </span>
            <span className={`connectionState connectionState--${status}`}>
              <i /> {statusLabel(status)}
            </span>
            <button
              className="clearButton"
              type="button"
              onClick={() => dispatch({ type: "conversation-cleared" })}
              disabled={isStreaming || (session.messages.length === 0 && session.mode === "do")}
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
            </div>
          )}
        </div>

        <MessageList
          messages={session.messages}
          onSuggestion={(draft) => dispatch({ type: "draft-changed", draft })}
          executablePlanMessageId={session.executablePlanMessageId}
          planActionDisabled={controlsDisabled}
          onExecutePlan={executePlan}
        />
        <ChatComposer
          value={session.draft}
          mode={session.mode}
          disabled={catalogState !== "ready"}
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

function safeErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
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
