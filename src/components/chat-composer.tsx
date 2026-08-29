"use client";

import type { KeyboardEvent } from "react";

import {
  MAX_WEB_CHAT_INPUT_LENGTH,
  type WebChatRequest,
} from "@/web/chat-contract";

type ChatComposerProps = {
  readonly value: string;
  readonly mode: WebChatRequest["mode"];
  readonly disabled: boolean;
  readonly isStreaming: boolean;
  readonly isStopping: boolean;
  readonly onModeChange: (mode: WebChatRequest["mode"]) => void;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onStop: () => void;
};

export function ChatComposer({
  value,
  mode,
  disabled,
  isStreaming,
  isStopping,
  onModeChange,
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
          maxLength={MAX_WEB_CHAT_INPUT_LENGTH}
          placeholder={
            disabled
              ? "模型配置不可用"
              : mode === "plan"
                ? "描述需要分析和规划的任务…"
                : "给 OrbitCode 发送任务…"
          }
          disabled={disabled || isStreaming}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="composerFooter">
          <div className="composerControls">
            <div className="modeSwitch" role="group" aria-label="Agent 模式">
              <button
                type="button"
                className={mode === "plan" ? "modeSwitchButton modeSwitchButton--active" : "modeSwitchButton"}
                aria-pressed={mode === "plan"}
                disabled={disabled || isStreaming}
                onClick={() => onModeChange("plan")}
              >
                PLAN
              </button>
              <button
                type="button"
                className={mode === "do" ? "modeSwitchButton modeSwitchButton--active" : "modeSwitchButton"}
                aria-pressed={mode === "do"}
                disabled={disabled || isStreaming}
                onClick={() => onModeChange("do")}
              >
                DO
              </button>
            </div>
            <span className="composerHint">
              {mode === "plan" ? "只读文件、查找与搜索" : "允许完整 Workspace 工具"}
              <span className="composerShortcut"><kbd>Enter</kbd> 发送</span>
            </span>
          </div>
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
      <p className="privacyNote">
        本地工具仅在授权工作目录运行 · API Key 仅保留在服务端
      </p>
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
