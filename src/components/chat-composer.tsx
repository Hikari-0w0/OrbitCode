"use client";

import type { KeyboardEvent } from "react";

import { MAX_WEB_CHAT_MESSAGE_LENGTH } from "@/web/chat-contract";

type ChatComposerProps = {
  readonly value: string;
  readonly disabled: boolean;
  readonly isStreaming: boolean;
  readonly isStopping: boolean;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onStop: () => void;
};

export function ChatComposer({
  value,
  disabled,
  isStreaming,
  isStopping,
  onChange,
  onSubmit,
  onStop,
}: ChatComposerProps) {
  const canSubmit = !disabled && !isStreaming && value.trim().length > 0;

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      if (canSubmit) onSubmit();
    }
  }

  return (
    <div className="composerWrap">
      <div className={`composer ${isStreaming ? "composer--active" : ""}`}>
        <label className="srOnly" htmlFor="chat-input">
          输入消息
        </label>
        <textarea
          id="chat-input"
          value={value}
          rows={3}
          maxLength={MAX_WEB_CHAT_MESSAGE_LENGTH}
          placeholder={disabled ? "模型配置不可用" : "给 OrbitCode 发送消息…"}
          disabled={disabled || isStreaming}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="composerFooter">
          <span className="composerHint">
            <kbd>Enter</kbd> 发送 · <kbd>Shift</kbd> + <kbd>Enter</kbd> 换行
          </span>
          {isStreaming ? (
            <button
              className="stopButton"
              type="button"
              onClick={onStop}
              disabled={isStopping}
              aria-label="停止生成"
            >
              <span aria-hidden="true" />
              {isStopping ? "停止中" : "停止"}
            </button>
          ) : (
            <button
              className="sendButton"
              type="button"
              onClick={onSubmit}
              disabled={!canSubmit}
              aria-label="发送消息"
            >
              <SendIcon />
            </button>
          )}
        </div>
      </div>
      <p className="privacyNote">本地会话 · API Key 仅保留在服务端</p>
    </div>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 10h11M11 6l4 4-4 4" />
    </svg>
  );
}
