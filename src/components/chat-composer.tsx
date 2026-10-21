"use client";
import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { MAX_WEB_CHAT_INPUT_LENGTH, type WebChatRequest, } from "@/web/chat-contract";
import { Popover } from "./ui/popover";
type ChatComposerProps = {
    readonly delegationKind?: import("@/core/sub-agents/parent-execution").DelegationKind;
    readonly onDelegationKindChange?: (kind: import("@/core/sub-agents/parent-execution").DelegationKind | undefined) => void;
    readonly parentExecutionMode?: import("@/core/sub-agents/parent-execution").ParentExecutionMode;
    readonly onParentExecutionChange?: (mode: import("@/core/sub-agents/parent-execution").ParentExecutionMode) => void;
    readonly blockedReason?: string;
    readonly value: string;
    readonly mode: WebChatRequest["mode"];
    readonly disabled: boolean;
    readonly isStreaming: boolean;
    readonly isStopping: boolean;
    readonly onModeChange: (mode: WebChatRequest["mode"]) => void;
    readonly onChange: (value: string) => void;
    readonly onSubmit: () => void;
    readonly onStop: () => void;
    readonly contextControl?: ReactNode;
};
export function ChatComposer({ value, blockedReason, mode, disabled, isStreaming, isStopping, onModeChange, onChange, onSubmit, onStop, contextControl, delegationKind, onDelegationKindChange, parentExecutionMode="collaborate",onParentExecutionChange }: ChatComposerProps) {
    const input = useRef<HTMLTextAreaElement>(null);
    useLayoutEffect(() => {
        const element = input.current;
        if (!element) return;
        // 重新量取内容高度，清空或切换到短草稿时释放阅读空间。
        element.style.height = "0px";
        element.style.height = `${element.scrollHeight}px`;
    }, [value]);
    const canSubmit = !disabled && !isStreaming && value.trim().length > 0;
    function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
        if (event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (canSubmit)
                onSubmit();
        }
    }
    return (<div className="composerWrap">
      <div className={`composer ${isStreaming ? "composer--active" : ""}`}>
        <label className="srOnly" htmlFor="chat-input">
          输入消息
        </label>
        <textarea ref={input} id="chat-input" value={value} rows={1} maxLength={MAX_WEB_CHAT_INPUT_LENGTH} placeholder={disabled
            ? blockedReason ?? "当前暂不可发送"
            : mode === "plan"
                ? "描述需要分析和规划的任务…"
                : "给 OrbitCode 发送任务…"} disabled={disabled || isStreaming} onChange={(event) => onChange(event.target.value)} onKeyDown={handleKeyDown}/>
        <div className="composerFooter">
          <div className="composerControls">
            <div className="modeSwitch" role="group" aria-label="Agent 模式">
              <button type="button" className={mode === "plan" ? "modeSwitchButton modeSwitchButton--active" : "modeSwitchButton"} aria-pressed={mode === "plan"} disabled={disabled || isStreaming} onClick={() => onModeChange("plan")}>
                规划
              </button>
              <button type="button" className={mode === "do" ? "modeSwitchButton modeSwitchButton--active" : "modeSwitchButton"} aria-pressed={mode === "do"} disabled={disabled || isStreaming} onClick={() => onModeChange("do")}>
                执行
              </button>
            </div>
            {onDelegationKindChange && <label>子任务类型 <select aria-label="子任务类型" value={delegationKind ?? "auto"} disabled={disabled || isStreaming} onChange={event => { const value = event.target.value; onDelegationKindChange(value === "defined" || value === "fork" ? value : undefined); }}><option value="auto">自动选择</option><option value="defined">定义式角色</option><option value="fork">Fork 继承上下文</option></select></label>}
            {onParentExecutionChange && <label>父级分工 <select aria-label="父级分工" value={parentExecutionMode} disabled={disabled||isStreaming} onChange={event=>{const value=event.target.value;if(value==="collaborate"||value==="delegate-only")onParentExecutionChange(value);}}><option value="collaborate">协作与接管</option><option value="delegate-only">仅委派汇总</option></select></label>}
            <span className="composerHint">
              {parentExecutionMode === "delegate-only" ? "父级仅委派汇总，子任务仍受角色和权限限制" : mode === "plan" ? "只读文件、查找与搜索" : "允许完整 Workspace 工具"}
              <span className="composerShortcut"><kbd>Enter</kbd> 发送</span>
            </span>
            {contextControl}
            <Popover className="composerPopover privacyInfo" label="ⓘ" accessibleLabel="本地工具与凭据说明">
              <div className="composerPopoverContent">本地工具仅在授权工作目录运行 · API Key 仅保留在服务端</div>
            </Popover>
          </div>
          {isStreaming ? (<button className="stopButton" type="button" onClick={onStop} disabled={isStopping} aria-label="停止生成">
              <span aria-hidden="true"/>
              {isStopping ? "停止中" : "停止"}
            </button>) : (<button className="sendButton" type="button" onClick={onSubmit} disabled={!canSubmit} aria-label="发送消息">
              <SendIcon />
            </button>)}
        </div>
      </div>
    </div>);
}
function SendIcon() {
    return (<svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 10h11M11 6l4 4-4 4"/>
    </svg>);
}
