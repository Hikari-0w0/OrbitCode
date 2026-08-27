"use client";

import { useEffect, useRef, useState } from "react";

export type VisibleMessage = {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly state: "complete" | "streaming" | "cancelled" | "failed";
  readonly detail?: string;
};

type MessageListProps = {
  readonly messages: readonly VisibleMessage[];
  readonly onSuggestion: (value: string) => void;
};

const suggestions = [
  "介绍一下你自己，以及你现在能做什么",
  "用三个要点解释 TypeScript 严格模式",
  "帮我分析一个技术方案的优缺点",
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
        当前是纯对话模式。消息只保留在本页中，刷新后即清空。
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
