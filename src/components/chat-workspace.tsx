"use client";

import { useEffect, useRef, useState } from "react";

import { ChatComposer } from "@/components/chat-composer";
import {
  MessageList,
  type VisibleMessage,
  type VisibleToolExecution,
} from "@/components/message-list";
import type { PlainConversationMessage } from "@/models/provider";
import {
  parseProviderCatalogResponse,
  parseWebApiError,
  parseWebChatEvents,
  readWebStream,
  type ProviderSummary,
  type WebChatEvent,
  type WebChatRequest,
} from "@/web/chat-contract";

type AgentMode = WebChatRequest["mode"];
type ToolResultEvent = Extract<WebChatEvent, { type: "tool-result" }>;
type StoppedEvent = Extract<WebChatEvent, { type: "stopped" }>;
type WorkspaceStatus =
  | "loading"
  | "ready"
  | "streaming"
  | "stopping"
  | "config-error";

export function ChatWorkspace() {
  const [providers, setProviders] = useState<readonly ProviderSummary[]>([]);
  const [selectedProvider, setSelectedProvider] = useState("");
  const [messages, setMessages] = useState<readonly VisibleMessage[]>([]);
  const [history, setHistory] = useState<readonly PlainConversationMessage[]>([]);
  const [mode, setMode] = useState<AgentMode>("do");
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<WorkspaceStatus>("loading");
  const [notice, setNotice] = useState<string>();
  const [catalogRevision, setCatalogRevision] = useState(0);
  const activeRequestRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    async function loadProviders(): Promise<void> {
      setStatus("loading");
      setNotice(undefined);
      try {
        const response = await fetch("/api/providers", {
          cache: "no-store",
          signal: controller.signal,
        });
        const value: unknown = await response.json();
        if (!response.ok) {
          throw new Error(parseWebApiError(value)?.error ?? "无法加载模型配置。");
        }
        const catalog = parseProviderCatalogResponse(value);
        const firstAvailable = catalog.providers.find((provider) => provider.available);
        setProviders(catalog.providers);
        if (!firstAvailable) {
          setSelectedProvider("");
          setStatus("config-error");
          setNotice("没有可用的模型配置，请检查本地 YAML 与 .env。");
          return;
        }
        setSelectedProvider(firstAvailable.name);
        setStatus("ready");
      } catch (error) {
        if (controller.signal.aborted) return;
        setStatus("config-error");
        setNotice(safeErrorMessage(error, "无法加载模型配置。"));
      }
    }
    void loadProviders();
    return () => controller.abort();
  }, [catalogRevision]);

  useEffect(() => () => activeRequestRef.current?.abort(), []);

  const currentProvider = providers.find((provider) => provider.name === selectedProvider);
  const isStreaming = status === "streaming" || status === "stopping";

  function selectProvider(name: string): void {
    if (isStreaming || name === selectedProvider) return;
    if (!providers.find((provider) => provider.name === name)?.available) return;
    setSelectedProvider(name);
    resetConversation();
  }

  function resetConversation(): void {
    setMessages([]);
    setHistory([]);
    setMode("do");
    setDraft("");
    setNotice(undefined);
  }

  function updateMessage(
    id: string,
    update: (message: VisibleMessage) => VisibleMessage,
  ): void {
    setMessages((current) =>
      current.map((message) => (message.id === id ? update(message) : message)),
    );
  }

  function applyStopped(
    assistantId: string,
    userMessage: PlainConversationMessage,
    event: StoppedEvent,
  ): void {
    if (event.reason === "final-response" && event.finalMessage) {
      const finalMessage = event.finalMessage;
      updateMessage(assistantId, (message) => ({
        ...message,
        content: finalMessage.content,
        state: "complete",
        stopReason: event.reason,
        progress: undefined,
      }));
      setHistory((current) => [...current, userMessage, finalMessage]);
      return;
    }
    const detail = stopDetail(event);
    updateMessage(assistantId, (message) => ({
      ...message,
      state: event.reason === "cancelled" ? "cancelled" : "failed",
      detail,
      stopReason: event.reason,
      progress: undefined,
      toolExecutions: settleInterruptedTools(message.toolExecutions ?? []),
    }));
    if (event.reason !== "cancelled") setNotice(detail);
  }

  async function submitMessage(): Promise<void> {
    const input = draft.trim();
    if (
      status !== "ready" ||
      input.length === 0 ||
      !selectedProvider ||
      activeRequestRef.current
    ) return;

    if (input === "/plan" || input === "/do") {
      const nextMode: AgentMode = input === "/plan" ? "plan" : "do";
      setMode(nextMode);
      setDraft("");
      setNotice(nextMode === "plan"
        ? "已切换到 Plan Mode：服务端只会开放读取、查找和搜索工具。"
        : "已切换到 Do Mode：服务端已恢复全部工作区工具。");
      return;
    }

    const userMessage: PlainConversationMessage = { role: "user", content: input };
    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    setMessages((current) => [
      ...current,
      { id: userId, role: "user", content: input, state: "complete" },
      {
        id: assistantId,
        role: "assistant",
        content: "",
        state: "streaming",
        toolExecutions: [],
      },
    ]);
    setDraft("");
    setNotice(undefined);
    setStatus("streaming");

    const controller = new AbortController();
    activeRequestRef.current = controller;
    let assistantContent = "";
    let stopped = false;

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: selectedProvider,
          mode,
          messages: [...history, userMessage],
        } satisfies WebChatRequest),
        signal: controller.signal,
      });
      if (!response.ok) {
        const value: unknown = await response.json().catch(() => undefined);
        throw new Error(parseWebApiError(value)?.error ?? "模型请求失败，请重试。");
      }
      if (!response.headers.get("content-type")?.startsWith("text/event-stream")) {
        throw new Error("聊天服务没有返回 SSE 响应。");
      }
      if (!response.body) throw new Error("模型服务没有返回响应流。");

      for await (const event of parseWebChatEvents(readWebStream(response.body))) {
        if (event.type === "text-delta") {
          assistantContent += event.text;
          updateMessage(assistantId, (message) => ({ ...message, content: assistantContent }));
        } else if (event.type === "progress") {
          updateMessage(assistantId, (message) => ({ ...message, progress: event }));
        } else if (event.type === "tool-call") {
          updateMessage(assistantId, (message) => ({
            ...message,
            toolExecutions: upsertToolExecution(message.toolExecutions ?? [], {
              iteration: event.iteration,
              sequence: event.sequence,
              callId: event.call.id,
              name: event.call.name,
              argumentsJson: event.call.argumentsJson,
              state: "queued",
            }),
          }));
        } else if (event.type === "tool-started") {
          updateMessage(assistantId, (message) => ({
            ...message,
            toolExecutions: updateToolState(
              message.toolExecutions ?? [],
              event.iteration,
              event.callId,
              "running",
            ),
          }));
        } else if (event.type === "tool-result") {
          updateMessage(assistantId, (message) => ({
            ...message,
            toolExecutions: applyToolResult(message.toolExecutions ?? [], event),
          }));
        } else if (event.type === "token-usage") {
          updateMessage(assistantId, (message) => ({
            ...message,
            usage: event.usage,
            cumulativeUsage: event.cumulative,
          }));
        } else if (event.type === "stopped") {
          stopped = true;
          applyStopped(assistantId, userMessage, event);
        }
      }
      if (!stopped) throw new Error("流式响应意外结束，请重试。");
    } catch (error) {
      if (controller.signal.aborted) {
        updateMessage(assistantId, (message) => ({
          ...message,
          state: "cancelled",
          detail: "回复已停止，本轮不会加入后续上下文。",
          toolExecutions: settleInterruptedTools(message.toolExecutions ?? []),
        }));
      } else {
        const message = safeErrorMessage(error, "模型请求失败，请重试。");
        updateMessage(assistantId, (current) => ({
          ...current,
          state: "failed",
          detail: message,
          toolExecutions: settleInterruptedTools(current.toolExecutions ?? []),
        }));
        setNotice(message);
      }
    } finally {
      if (activeRequestRef.current === controller) activeRequestRef.current = undefined;
      setStatus("ready");
    }
  }

  function stopGeneration(): void {
    if (!activeRequestRef.current || status !== "streaming") return;
    setStatus("stopping");
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
            <span>PHASE 03</span>
            <span className="liveBadge"><i /> LIVE</span>
          </div>
          <strong>自主 Agent Loop</strong>
          <p>模型会读取工具结果并继续行动，直到完成任务或触发安全上限</p>
        </div>

        <div className="providerSection">
          <label htmlFor="provider-select">MODEL PROVIDER</label>
          <div className="selectWrap">
            <select
              id="provider-select"
              aria-label="MODEL PROVIDER"
              value={selectedProvider}
              disabled={isStreaming || status === "loading"}
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
          <div><span>当前模式</span><strong>{modeLabel(mode)}</strong></div>
          <div><span>工具范围</span><strong>{mode === "plan" ? "只读" : "当前工作目录"}</strong></div>
          <div><span>存储</span><strong>仅当前页面</strong></div>
        </div>

        <div className="sidebarFooter">
          <span className="shieldIcon" aria-hidden="true">◇</span>
          <div>
            <strong>SERVER ENFORCED</strong>
            <span>模式权限由服务端过滤</span>
          </div>
        </div>
      </aside>

      <section className="chatPanel" aria-label="OrbitCode 对话工作区">
        <header className="chatHeader">
          <div>
            <p className="chatKicker">SESSION / UNTITLED</p>
            <h2>对话工作区</h2>
          </div>
          <div className="headerActions">
            <span className={`modeBadge modeBadge--${mode}`}>{modeLabel(mode)}</span>
            <span className={`connectionState connectionState--${status}`}>
              <i /> {statusLabel(status)}
            </span>
            <button
              className="clearButton"
              type="button"
              onClick={resetConversation}
              disabled={isStreaming || (messages.length === 0 && mode === "do")}
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
              {status === "config-error" && (
                <button type="button" onClick={() => setCatalogRevision((value) => value + 1)}>
                  重新加载
                </button>
              )}
            </div>
          )}
        </div>

        <MessageList messages={messages} onSuggestion={setDraft} />
        <ChatComposer
          value={draft}
          mode={mode}
          disabled={status === "loading" || status === "config-error"}
          isStreaming={isStreaming}
          isStopping={status === "stopping"}
          onChange={setDraft}
          onSubmit={() => void submitMessage()}
          onStop={stopGeneration}
        />
      </section>
    </main>
  );
}

function statusLabel(status: WorkspaceStatus): string {
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

function upsertToolExecution(
  current: readonly VisibleToolExecution[],
  next: VisibleToolExecution,
): readonly VisibleToolExecution[] {
  const index = current.findIndex(
    (execution) => execution.iteration === next.iteration && execution.callId === next.callId,
  );
  if (index < 0) return [...current, next];
  return current.map((execution, currentIndex) => currentIndex === index ? next : execution);
}

function updateToolState(
  current: readonly VisibleToolExecution[],
  iteration: number,
  callId: string,
  state: VisibleToolExecution["state"],
): readonly VisibleToolExecution[] {
  return current.map((execution) =>
    execution.iteration === iteration && execution.callId === callId
      ? { ...execution, state }
      : execution,
  );
}

function applyToolResult(
  current: readonly VisibleToolExecution[],
  event: ToolResultEvent,
): readonly VisibleToolExecution[] {
  const existing = current.find(
    (execution) => execution.iteration === event.iteration && execution.callId === event.callId,
  );
  return upsertToolExecution(current, {
    iteration: event.iteration,
    sequence: event.sequence,
    callId: event.callId,
    name: event.name,
    argumentsJson: existing?.argumentsJson ?? "{}",
    state: toolExecutionState(event.result),
    result: event.result,
  });
}

function settleInterruptedTools(
  current: readonly VisibleToolExecution[],
): readonly VisibleToolExecution[] {
  return current.map((execution) => {
    if (execution.state === "running") return { ...execution, state: "cancelled" };
    if (execution.state === "queued") return { ...execution, state: "skipped" };
    return execution;
  });
}

function toolExecutionState(result: ToolResultEvent["result"]): VisibleToolExecution["state"] {
  if (result.ok) return "succeeded";
  if (result.error.kind === "timeout") return "timed-out";
  if (result.error.kind === "cancelled") return "cancelled";
  return "failed";
}

function stopDetail(event: StoppedEvent): string {
  const base = event.detail ?? stopReasonLabel(event.reason);
  return event.sideEffect === "none"
    ? base
    : `${base} 工具可能已产生本地副作用，请检查工作目录。`;
}

function stopReasonLabel(reason: StoppedEvent["reason"]): string {
  if (reason === "final-response") return "任务已完成";
  if (reason === "max-iterations") return "已达到最大迭代次数";
  if (reason === "cancelled") return "用户已取消运行";
  if (reason === "repeated-unknown-tool") return "模型连续请求未知工具";
  if (reason === "model-error") return "模型响应流发生错误";
  return "Agent 内部发生错误";
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
