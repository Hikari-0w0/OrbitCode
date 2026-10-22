"use client";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { MessageContent, CopyButton } from "./message-content";
import { ToolExecutionCard } from "./tool-execution-card";
import type { McpInitializationRecord } from "@/core/mcp-events";
import { PermissionRequestCard } from "@/components/permission-request-card";
import type { CompletionAssessment } from "@/core/completion-tracker";
import type { WebChatEvent } from "@/web/chat-contract";
type ProgressEvent = Extract<WebChatEvent, {
    type: "progress";
}>;
type TokenUsageEvent = Extract<WebChatEvent, {
    type: "token-usage";
}>;
type StoppedEvent = Extract<WebChatEvent, {
    type: "stopped";
}>;
type ToolResultEvent = Extract<WebChatEvent, {
    type: "tool-result";
}>;
type PermissionPrompt = Extract<WebChatEvent, {
    type: "permission-requested";
}>["prompt"];
export type VisiblePermissionRequest = {
    readonly prompt: PermissionPrompt;
    readonly state: "awaiting" | "submitting" | "submitted" | "allowed" | "denied" | "expired" | "cancelled" | "invalid";
    readonly scope?: "once" | "session" | "permanent";
    readonly error?: string;
};
export type VisibleToolExecution = {
    readonly iteration: number;
    readonly sequence: number;
    readonly callId: string;
    readonly name: string;
    readonly argumentsJson: string;
    readonly state: "queued" | "awaiting-approval" | "running" | "succeeded" | "failed" | "timed-out" | "cancelled" | "skipped";
    readonly result?: ToolResultEvent["result"];
    readonly permission?: VisiblePermissionRequest;
};
export type VisibleMessagePart = {
    readonly type: "text";
    readonly iteration: number;
    readonly content: string;
} | {
    readonly type: "tool";
    readonly iteration: number;
    readonly callId: string;
};
export type VisibleMessage = {
    readonly initialization?: readonly McpInitializationRecord[];
    readonly runtimePermissions?: readonly VisiblePermissionRequest[];
    readonly id: string;
    readonly role: "user" | "assistant";
    readonly content: string;
    readonly state: "complete" | "streaming" | "cancelled" | "failed";
    readonly detail?: string;
    readonly parts?: readonly VisibleMessagePart[];
    readonly toolExecutions?: readonly VisibleToolExecution[];
    readonly progress?: ProgressEvent;
    readonly usage?: TokenUsageEvent["usage"];
    readonly cumulativeUsage?: TokenUsageEvent["cumulative"];
    readonly stopReason?: StoppedEvent["reason"];
    readonly durationMs?: number;
    readonly verification?: CompletionAssessment;
    readonly persistence?: StoppedEvent["persistence"];
};
type MessageListProps = {
    readonly messages: readonly VisibleMessage[];
    readonly currentRunStartedAtMs?: number;
    readonly onSuggestion: (value: string) => void;
    readonly executablePlanMessageId?: string;
    readonly planActionDisabled: boolean;
    readonly onExecutePlan: (messageId: string) => void;
};
const suggestions = [
    "读取 README.md 并总结当前能力",
    "查找 src 目录下的 TypeScript 文件",
    "搜索代码中所有 ProviderError 的位置",
];
export function MessageList({ messages, currentRunStartedAtMs, onSuggestion, executablePlanMessageId, planActionDisabled, onExecutePlan, }: MessageListProps) {
    const actions = useRef({ onExecutePlan });
    useEffect(() => { actions.current = { onExecutePlan }; }, [onExecutePlan]);
    const executePlan = useCallback((id: string) => actions.current.onExecutePlan(id), []);
    const viewportRef = useRef<HTMLDivElement>(null);
    const followsLatestRef = useRef(true);
    const [followsLatest, setFollowsLatest] = useState(true);
    useEffect(() => {
        const viewport = viewportRef.current;
        if (!viewport || !followsLatestRef.current)
            return;
        viewport.scrollTo({ top: viewport.scrollHeight, behavior: "instant" });
    }, [messages]);
    function handleScroll(): void {
        const viewport = viewportRef.current;
        if (!viewport)
            return;
        const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
        const isFollowing = distance < 72;
        followsLatestRef.current = isFollowing;
        setFollowsLatest(isFollowing);
    }
    function scrollToLatest(): void {
        const viewport = viewportRef.current;
        if (!viewport)
            return;
        followsLatestRef.current = true;
        setFollowsLatest(true);
        viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
    }
    return (<div className="messageRegion">
      <div ref={viewportRef} className="messageViewport" onScroll={handleScroll} role="log" aria-live="polite" aria-label="对话消息">
        {messages.length === 0 ? (<EmptyConversation onSuggestion={onSuggestion}/>) : (<div className="messageStack">
            {messages.map((message) => (<MessageItem key={message.id} message={message} currentRunStartedAtMs={message.state === "streaming" ? currentRunStartedAtMs : undefined} executablePlan={message.id === executablePlanMessageId} planActionDisabled={message.id === executablePlanMessageId && planActionDisabled} onExecutePlan={executePlan}/>))}
          </div>)}
      </div>

      {!followsLatest && messages.length > 0 && (<button className="jumpToLatest" type="button" onClick={scrollToLatest}>
          <DownIcon />
          回到底部
        </button>)}
    </div>);
}
const MessageItem = memo(function MessageItem({ message, currentRunStartedAtMs, executablePlan, planActionDisabled, onExecutePlan }: {
    readonly message: VisibleMessage;
    readonly currentRunStartedAtMs?: number;
    readonly executablePlan: boolean;
    readonly planActionDisabled: boolean;
    readonly onExecutePlan: (id: string) => void;
}) {
    return (<article className={`message message--${message.role}`}>
                <div className="messageIdentity" aria-hidden="true">
                  {message.role === "assistant" ? "OC" : "你"}
                </div>
                <div className="messageContent">
                  <div className="messageMeta">
                    <span>{message.role === "assistant" ? "OrbitCode" : "你"}</span>
                    <MessageState state={message.state}/>
                  </div>
                  {message.runtimePermissions?.map((request) => (<PermissionRequestCard key={request.prompt.requestId} request={request}/>))}
                  {message.initialization?.map((record) => (<p className="usageLine" key={record.serverName}>MCP {record.serverName}：{record.detail}</p>))}
                  {message.parts && message.parts.length > 0 ? (<MessageTimeline message={message}/>) : (<>
                      {message.toolExecutions && message.toolExecutions.length > 0 && (<div className="toolExecutionList" aria-label="工具执行记录">
                          {message.toolExecutions.map((execution) => (<ToolExecutionCard key={`${execution.iteration}:${execution.callId}`} execution={execution}/>))}
                        </div>)}
                      {message.content.length > 0 && <MessageContent text={message.content}/>}
                    </>)}
                  {message.content && message.state !== "streaming" && <div className="messageActions"><CopyButton text={message.content} label="复制消息"/><details><summary>查看原文</summary><pre>{message.content}</pre></details></div>}
                  {message.state === "streaming" && (<span className="streamingCursor" aria-label="正在生成"/>)}
                  {message.progress && (<AgentProgress progress={message.progress} runStartedAtMs={currentRunStartedAtMs}/>)}
                  {message.cumulativeUsage && <UsageLine usage={message.cumulativeUsage}/>}
                  {message.durationMs !== undefined && (<p className="usageLine">总用时：{formatDuration(message.durationMs)}</p>)}
                  {message.stopReason && (<p className={`stopReason stopReason--${message.state}`}>
                      停止原因：{stopReasonLabel(message.stopReason)}
                    </p>)}
                  {message.persistence && (<p className="usageLine" role="status">
                      保存状态：{message.persistence.status === "saved" ? "已保存到本地" : `保存失败：${message.persistence.detail}`}
                    </p>)}
                  {message.verification && (<>
                      <p className={`verificationState verificationState--${message.verification.status}`}>
                        {message.verification.status === "observed" ? "运行证据" : "验证状态"}：{verificationLabel(message.verification.status)}
                      </p>
                      <p className="usageLine">{message.verification.status === "observed" ? "仅记录外部工具调用结果，答复内容未验收。" : "仅覆盖所列检查，不代表全部需求已验收。"}</p>
                      {message.verification.checks.length > 0 && (<details>
                          <summary>查看检查范围</summary>
                          <ul>{message.verification.checks.map((check, index) => (<li key={index}>{check.criterion}：{check.status === "passed" ? "通过" : check.status === "failed" ? "失败" : "未执行"}</li>))}</ul>
                        </details>)}
                    </>)}
                  {message.toolExecutions?.some((tool) => tool.name === "start_process" && tool.state === "succeeded") && (<p className="usageLine">临时服务仅用于本轮验证，结束后自动回收；预览地址不保证在回复后可用。</p>)}
                  {message.detail && (<p className={`messageDetail messageDetail--${message.state}`}>
                      {message.detail}
                    </p>)}
                  {executablePlan && message.state === "complete" && (<div className="planAction">
                      <div>
                        <strong>计划已就绪</strong>
                        <span>将保留当前 Workspace 和对话上下文，以 Do 模式开始执行。</span>
                      </div>
                      <button type="button" disabled={planActionDisabled} onClick={() => onExecutePlan(message.id)}>
                        按此计划执行
                        <ArrowIcon />
                      </button>
                    </div>)}
                </div>
              </article>);
});
function MessageTimeline({ message, }: {
    readonly message: VisibleMessage;
}) {
    return (<div className="messageTimeline">
      {message.parts?.map((part, index) => {
            if (part.type === "text") {
                if (part.content.trim().length === 0)
                    return null;
                return <MessageContent key={`text:${index}`} text={part.content}/>;
            }
            const execution = message.toolExecutions?.find((item) => item.iteration === part.iteration && item.callId === part.callId);
            if (!execution)
                return null;
            return (<div key={`tool:${part.iteration}:${part.callId}`} className="toolExecutionList" aria-label="工具执行记录">
            <ToolExecutionCard execution={execution}/>
          </div>);
        })}
    </div>);
}
function AgentProgress({ progress, runStartedAtMs, }: {
    readonly progress: ProgressEvent;
    readonly runStartedAtMs?: number;
}) {
    const toolProgress = progress.phase === "tools"
        ? ` · 工具 ${progress.completedTools ?? 0}/${progress.totalTools ?? 0}`
        : (<ModelProgressLabel key={modelProgressKey(progress)} progress={progress}/>);
    const percentage = progress.maxIterations === "unlimited"
        ? 18
        : progress.phase === "tools" && progress.totalTools
            ? ((progress.iteration - 1) + (progress.completedTools ?? 0) / progress.totalTools)
                / progress.maxIterations * 100
            : (progress.iteration - 1) / progress.maxIterations * 100;
    const iterationLimit = progress.maxIterations === "unlimited"
        ? "∞"
        : progress.maxIterations;
    return (<div className="agentProgress" aria-label="Agent 当前进度">
      <div className="progressHeader">
        <span>迭代 {progress.iteration}/{iterationLimit}</span>
        <span>
          {toolProgress}
          {runStartedAtMs !== undefined && <LiveTotalDuration startedAtMs={runStartedAtMs}/>}
        </span>
      </div>
      <div className="progressTrack" aria-hidden="true">
        <span style={{ width: `${Math.max(4, percentage)}%` }}/>
      </div>
    </div>);
}
function LiveTotalDuration({ startedAtMs }: {
    readonly startedAtMs: number;
}) {
    const [durationMs, setDurationMs] = useState(0);
    useEffect(() => {
        const timer = window.setInterval(() => {
            setDurationMs(Math.max(0, Date.now() - startedAtMs));
        }, 250);
        return () => window.clearInterval(timer);
    }, [startedAtMs]);
    return <> · 总用时：{formatDuration(durationMs)}</>;
}
function ModelProgressLabel({ progress }: {
    readonly progress: ProgressEvent;
}) {
    const [silentMs, setSilentMs] = useState(0);
    useEffect(() => {
        const receivedAt = Date.now();
        const timer = window.setInterval(() => {
            setSilentMs(Date.now() - receivedAt);
        }, 1000);
        return () => window.clearInterval(timer);
    }, []);
    return modelProgressLabel(progress, silentMs);
}
function modelProgressKey(progress: ProgressEvent): string {
    if (progress.phase !== "model" || progress.model === undefined)
        return "model";
    return [
        progress.iteration,
        progress.model.stage,
        progress.model.elapsedMs,
        progress.model.attempt,
        progress.model.toolName ?? "",
        progress.model.toolArgumentsChars ?? "",
    ].join(":");
}
function modelProgressLabel(progress: ProgressEvent, silentMs = 0): string {
    if (progress.phase !== "model" || progress.model === undefined) {
        return " · 正在请求模型";
    }
    const seconds = Math.max(0, (progress.model.elapsedMs + silentMs) / 1000).toFixed(1);
    const retry = progress.model.attempt > 1 ? ` · 重试 ${progress.model.attempt - 1}` : "";
    const waiting = silentMs >= 1000
        ? ` · 等待新数据 ${Math.floor(silentMs / 1000)}s`
        : "";
    if (progress.model.stage === "waiting-first-byte") {
        return ` · 等待模型响应 ${seconds}s${retry}${waiting}`;
    }
    if (progress.model.stage === "streaming-tool-arguments") {
        const name = progress.model.toolName ?? "工具";
        const size = progress.model.toolArgumentsChars ?? 0;
        return ` · 生成 ${name} 参数 ${size.toLocaleString()} 字符 · ${seconds}s${retry}${waiting}`;
    }
    if (progress.model.stage === "waiting-done") {
        return ` · 等待模型结束标记 ${seconds}s${retry}${waiting}`;
    }
    return ` · 正在生成回复 ${seconds}s${retry}${waiting}`;
}
function UsageLine({ usage }: {
    readonly usage: TokenUsageEvent["cumulative"];
}) {
    if (usage.availability === "unavailable") {
        return <p className="usageLine">Token 用量：模型未报告</p>;
    }
    return (<p className="usageLine">
      Token：{usage.totalTokens.toLocaleString()}（输入 {usage.promptTokens.toLocaleString()} · 输出 {usage.completionTokens.toLocaleString()}）
      {cacheUsageLabel(usage)}
    </p>);
}
function formatDuration(durationMs: number): string {
    if (durationMs < 1000)
        return `${durationMs} 毫秒`;
    if (durationMs < 60000)
        return `${(durationMs / 1000).toFixed(1)} 秒`;
    const minutes = Math.floor(durationMs / 60000);
    const seconds = Math.floor((durationMs % 60000) / 1000);
    return `${minutes} 分 ${seconds} 秒`;
}
function cacheUsageLabel(usage: Extract<TokenUsageEvent["cumulative"], {
    availability: "reported";
}>): string {
    if (usage.promptCache.availability === "unavailable") {
        return " · 缓存：模型未报告";
    }
    if (usage.promptCache.availability === "status") {
        return ` · 缓存：${usage.promptCache.hit ? "命中" : "未命中"}`;
    }
    const percentage = usage.promptTokens === 0
        ? 0
        : usage.promptCache.cachedTokens / usage.promptTokens * 100;
    const formatted = percentage.toLocaleString(undefined, {
        maximumFractionDigits: 1,
    });
    return ` · 缓存：${usage.promptCache.cachedTokens.toLocaleString()} Token（${formatted}%）`;
}
function EmptyConversation({ onSuggestion }: {
    readonly onSuggestion: (value: string) => void;
}) {
    return (<div className="emptyConversation">
      <div className="emptyMark" aria-hidden="true"><span /><span /><span /></div>
      <p className="emptyEyebrow">思考、规划，然后动手。</p>
      <h1>从一个任务开始。</h1>
      <p className="emptyDescription">
        把想法变成代码。选择一个项目，描述你的任务，剩下的交给 OrbitCode。
      </p>
      <div className="suggestionGrid" role="group" aria-label="示例问题">
        {suggestions.map((suggestion) => (<button key={suggestion} type="button" onClick={() => onSuggestion(suggestion)}>
            <span>{suggestion}</span>
            <ArrowIcon />
          </button>))}
      </div>
    </div>);
}
function stopReasonLabel(reason: StoppedEvent["reason"]): string {
    if (reason === "final-response")
        return "模型生成最终回复";
    if (reason === "max-iterations")
        return "达到最大迭代次数";
    if (reason === "max-runtime")
        return "达到最大运行时间";
    if (reason === "cancelled")
        return "用户取消";
    if (reason === "repeated-unknown-tool")
        return "连续调用未知工具";
    if (reason === "repeated-tool-failure")
        return "工具连续产生同类失败";
    if (reason === "context-error")
        return "上下文压缩失败";
    if (reason === "context-capacity")
        return "上下文容量不足";
    if (reason === "context-circuit-open")
        return "上下文自动压缩熔断";
    if (reason === "model-error")
        return "模型响应流错误";
    return "Agent 内部错误";
}
function verificationLabel(status: CompletionAssessment["status"]): string {
    if (status === "verified")
        return "所列检查通过";
    if (status === "observed")
        return "外部调用结果已记录";
    if (status === "partial")
        return "部分验证";
    if (status === "blocked")
        return "存在阻塞";
    return "未验证";
}
function MessageState({ state }: {
    readonly state: VisibleMessage["state"];
}) {
    if (state === "streaming")
        return <span className="messageState">运行中</span>;
    if (state === "cancelled")
        return <span className="messageState">已停止</span>;
    if (state === "failed")
        return <span className="messageState">未完成</span>;
    return null;
}
function ArrowIcon() {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 10h9M10.5 6.5 14 10l-3.5 3.5"/></svg>;
}
function DownIcon() {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4"/></svg>;
}
