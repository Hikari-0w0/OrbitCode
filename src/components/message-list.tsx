"use client";

import { useEffect, useRef, useState } from "react";

import type { WebChatEvent } from "@/web/chat-contract";

type ToolCompletedEvent = Extract<WebChatEvent, { type: "tool-completed" }>;

export type VisibleToolExecution = {
  readonly callId: string;
  readonly name: ToolCompletedEvent["name"];
  readonly state: "running" | "succeeded" | "failed" | "timed-out" | "cancelled";
  readonly result?: ToolCompletedEvent["result"];
};

export type VisibleMessage = {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly state: "complete" | "streaming" | "cancelled" | "failed";
  readonly detail?: string;
  readonly toolExecutions?: readonly VisibleToolExecution[];
};

type MessageListProps = {
  readonly messages: readonly VisibleMessage[];
  readonly onSuggestion: (value: string) => void;
};

const suggestions = [
  "读取 README.md 并总结当前能力",
  "查找 src 目录下的 TypeScript 文件",
  "搜索代码中所有 ProviderError 的位置",
];

export function MessageList({ messages, onSuggestion }: MessageListProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const followsLatestRef = useRef(true);
  const [followsLatest, setFollowsLatest] = useState(true);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !followsLatestRef.current) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
  }, [messages]);

  function handleScroll(): void {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    const isFollowing = distance < 72;
    followsLatestRef.current = isFollowing;
    setFollowsLatest(isFollowing);
  }

  function scrollToLatest(): void {
    const viewport = viewportRef.current;
    if (!viewport) return;
    followsLatestRef.current = true;
    setFollowsLatest(true);
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
  }

  return (
    <div className="messageRegion">
      <div
        ref={viewportRef}
        className="messageViewport"
        onScroll={handleScroll}
        role="log"
        aria-live="polite"
        aria-label="对话消息"
      >
        {messages.length === 0 ? (
          <EmptyConversation onSuggestion={onSuggestion} />
        ) : (
          <div className="messageStack">
            {messages.map((message) => (
              <article key={message.id} className={`message message--${message.role}`}>
                <div className="messageIdentity" aria-hidden="true">
                  {message.role === "assistant" ? "OC" : "你"}
                </div>
                <div className="messageContent">
                  <div className="messageMeta">
                    <span>{message.role === "assistant" ? "OrbitCode" : "你"}</span>
                    <MessageState state={message.state} />
                  </div>
                  {message.toolExecutions && message.toolExecutions.length > 0 && (
                    <div className="toolExecutionList" aria-label="工具执行记录">
                      {message.toolExecutions.map((execution) => (
                        <ToolExecutionCard key={execution.callId} execution={execution} />
                      ))}
                    </div>
                  )}
                  {message.content.length > 0 && (
                    <p className="messageText">{message.content}</p>
                  )}
                  {message.state === "streaming" && (
                    <span className="streamingCursor" aria-label="正在生成" />
                  )}
                  {message.detail && (
                    <p className={`messageDetail messageDetail--${message.state}`}>
                      {message.detail}
                    </p>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {!followsLatest && messages.length > 0 && (
        <button className="jumpToLatest" type="button" onClick={scrollToLatest}>
          <DownIcon />
          回到底部
        </button>
      )}
    </div>
  );
}

function EmptyConversation({ onSuggestion }: { readonly onSuggestion: (value: string) => void }) {
  return (
    <div className="emptyConversation">
      <div className="emptyMark" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <p className="emptyEyebrow">NEW LOCAL SESSION</p>
      <h1>从一个问题开始。</h1>
      <p className="emptyDescription">
        OrbitCode 可以在授权工作目录内读取、修改和查找代码，也可以在严格沙箱中执行命令。
      </p>
      <div className="suggestionGrid" aria-label="示例问题">
        {suggestions.map((suggestion) => (
          <button key={suggestion} type="button" onClick={() => onSuggestion(suggestion)}>
            <span>{suggestion}</span>
            <ArrowIcon />
          </button>
        ))}
      </div>
    </div>
  );
}

function ToolExecutionCard({ execution }: { readonly execution: VisibleToolExecution }) {
  const result = execution.result;
  const detail = result?.ok
    ? JSON.stringify(result.output, null, 2)
    : result?.error.message;

  return (
    <section className={`toolCard toolCard--${execution.state}`}>
      <div className="toolCardHeader">
        <span className="toolStateDot" aria-hidden="true" />
        <code>{execution.name}</code>
        <span>{toolStateLabel(execution.state)}</span>
      </div>
      {detail && (
        <details className="toolCardDetails" open={execution.state !== "succeeded"}>
          <summary>{result?.ok ? "查看执行结果" : "查看错误详情"}</summary>
          <pre>{detail}</pre>
        </details>
      )}
    </section>
  );
}

function toolStateLabel(state: VisibleToolExecution["state"]): string {
  if (state === "running") return "执行中";
  if (state === "succeeded") return "已完成";
  if (state === "timed-out") return "已超时";
  if (state === "cancelled") return "已取消";
  return "失败";
}

function MessageState({ state }: { readonly state: VisibleMessage["state"] }) {
  if (state === "streaming") return <span className="messageState">生成中</span>;
  if (state === "cancelled") return <span className="messageState">已停止</span>;
  if (state === "failed") return <span className="messageState">未完成</span>;
  return null;
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M5 10h9M10.5 6.5 14 10l-3.5 3.5" />
    </svg>
  );
}

function DownIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m6 8 4 4 4-4" />
    </svg>
  );
}
