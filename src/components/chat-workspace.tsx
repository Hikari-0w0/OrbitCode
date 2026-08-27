"use client";

import { useEffect, useRef, useState } from "react";

import { ChatComposer } from "@/components/chat-composer";
import { MessageList, type VisibleMessage } from "@/components/message-list";
import type { ConversationMessage } from "@/models/provider";
import {
  parseProviderCatalogResponse,
  parseWebApiError,
  parseWebChatEvents,
  readWebStream,
  type ProviderSummary,
} from "@/web/chat-contract";

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
  const [history, setHistory] = useState<readonly ConversationMessage[]>([]);
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
        const firstAvailable = catalog.providers.find(
          (provider) => provider.available,
        );
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

  useEffect(
    () => () => {
      activeRequestRef.current?.abort();
    },
    [],
  );

  const currentProvider = providers.find(
    (provider) => provider.name === selectedProvider,
  );
  const isStreaming = status === "streaming" || status === "stopping";

  function selectProvider(name: string): void {
    if (isStreaming || name === selectedProvider) return;
    const provider = providers.find((candidate) => candidate.name === name);
    if (!provider?.available) return;
    setSelectedProvider(name);
    resetConversation();
  }

  function resetConversation(): void {
    setMessages([]);
    setHistory([]);
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

  async function submitMessage(): Promise<void> {
    const input = draft.trim();
    if (status !== "ready" || input.length === 0 || !selectedProvider) return;

    const userMessage: ConversationMessage = { role: "user", content: input };
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
      },
    ]);
    setDraft("");
    setNotice(undefined);
    setStatus("streaming");

    const controller = new AbortController();
    activeRequestRef.current = controller;
    let assistantContent = "";
    let completed = false;
    let streamFailed = false;

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: selectedProvider,
          messages: [...history, userMessage],
        }),
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
          updateMessage(assistantId, (message) => ({
            ...message,
            content: assistantContent,
          }));
        } else if (event.type === "completed") {
          completed = true;
        } else {
          streamFailed = true;
          updateMessage(assistantId, (message) => ({
            ...message,
            state: "failed",
            detail: event.message,
          }));
          setNotice(event.message);
        }
      }

      if (streamFailed) return;
      if (!completed) throw new Error("流式响应意外结束，请重试。");
      updateMessage(assistantId, (message) => ({
        ...message,
        state: "complete",
      }));
      setHistory((current) => [
        ...current,
        userMessage,
        { role: "assistant", content: assistantContent },
      ]);
    } catch (error) {
      if (controller.signal.aborted) {
        updateMessage(assistantId, (message) => ({
          ...message,
          state: "cancelled",
          detail: "回复已停止，本轮不会加入后续上下文。",
        }));
      } else {
        const message = safeErrorMessage(error, "模型请求失败，请重试。");
        updateMessage(assistantId, (current) => ({
          ...current,
          state: "failed",
          detail: message,
        }));
        setNotice(message);
      }
    } finally {
      if (activeRequestRef.current === controller) {
        activeRequestRef.current = undefined;
      }
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
            <span>PHASE 01</span>
            <span className="liveBadge"><i /> LIVE</span>
          </div>
          <strong>纯对话模式</strong>
          <p>流式模型响应与当前页多轮上下文</p>
        </div>

        <div className="providerSection">
          <label htmlFor="provider-select">MODEL PROVIDER</label>
          <div className="selectWrap">
            <select
              id="provider-select"
              value={selectedProvider}
              disabled={isStreaming || status === "loading"}
              onChange={(event) => selectProvider(event.target.value)}
            >
              {providers.length === 0 && <option value="">等待配置</option>}
              {providers.map((provider) => (
                <option
                  key={provider.name}
                  value={provider.name}
                  disabled={!provider.available}
                >
                  {provider.name}{provider.available ? "" : "（不可用）"}
                </option>
              ))}
            </select>
            <ChevronIcon />
          </div>
          {currentProvider && (
            <div className="modelMeta">
              <span
                className={
                  currentProvider.available
                    ? "statusDot"
                    : "statusDot statusDot--off"
                }
              />
              <span>{currentProvider.model}</span>
            </div>
          )}
        </div>

        <div className="sessionInfo">
          <div><span>存储</span><strong>仅当前页面</strong></div>
          <div><span>协议</span><strong>OpenAI · SSE</strong></div>
        </div>

        <div className="sidebarFooter">
          <span className="shieldIcon" aria-hidden="true">◇</span>
          <div>
            <strong>LOCAL FIRST</strong>
            <span>凭据不会发送到浏览器</span>
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
            <span className={`connectionState connectionState--${status}`}>
              <i /> {statusLabel(status)}
            </span>
            <button
              className="clearButton"
              type="button"
              onClick={resetConversation}
              disabled={isStreaming || messages.length === 0}
            >
              <TrashIcon />
              清空
            </button>
          </div>
        </header>

        <div className="noticeSlot">
          {notice && (
            <div className="noticeBanner" role="alert">
              <span>!</span>
              <p>{notice}</p>
              {status === "config-error" && (
                <button
                  type="button"
                  onClick={() => setCatalogRevision((value) => value + 1)}
                >
                  重新加载
                </button>
              )}
            </div>
          )}
        </div>

        <MessageList messages={messages} onSuggestion={setDraft} />
        <ChatComposer
          value={draft}
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
  switch (status) {
    case "loading":
      return "载入配置";
    case "streaming":
      return "正在生成";
    case "stopping":
      return "正在停止";
    case "config-error":
      return "配置异常";
    case "ready":
      return "准备就绪";
  }
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
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m6 8 4 4 4-4" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M6.5 6.5v8m3.5-8v8m3.5-8v8M4 4.5h12M8 4.5v-2h4v2m2.8 0-.7 12.5H5.9L5.2 4.5" />
    </svg>
  );
}
