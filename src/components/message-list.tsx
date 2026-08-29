"use client";

import { useEffect, useRef, useState } from "react";

import { PermissionRequestCard } from "@/components/permission-request-card";
import type { PermissionUserDecision } from "@/core/permissions/approval";
import type { WebChatEvent } from "@/web/chat-contract";

type ProgressEvent = Extract<WebChatEvent, { type: "progress" }>;
type TokenUsageEvent = Extract<WebChatEvent, { type: "token-usage" }>;
type StoppedEvent = Extract<WebChatEvent, { type: "stopped" }>;
type ToolResultEvent = Extract<WebChatEvent, { type: "tool-result" }>;
type PermissionPrompt = Extract<
  WebChatEvent,
  { type: "permission-requested" }
>["prompt"];

export type VisiblePermissionRequest = {
  readonly prompt: PermissionPrompt;
  readonly state:
    | "awaiting"
    | "submitting"
    | "submitted"
    | "allowed"
    | "denied"
    | "expired"
    | "cancelled"
    | "invalid";
  readonly scope?: "once" | "session" | "permanent";
  readonly error?: string;
};

export type VisibleToolExecution = {
  readonly iteration: number;
  readonly sequence: number;
  readonly callId: string;
  readonly name: string;
  readonly argumentsJson: string;
  readonly state:
    | "queued"
    | "awaiting-approval"
    | "running"
    | "succeeded"
    | "failed"
    | "timed-out"
    | "cancelled"
    | "skipped";
  readonly result?: ToolResultEvent["result"];
  readonly permission?: VisiblePermissionRequest;
};

export type VisibleMessage = {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly state: "complete" | "streaming" | "cancelled" | "failed";
  readonly detail?: string;
  readonly toolExecutions?: readonly VisibleToolExecution[];
  readonly progress?: ProgressEvent;
  readonly usage?: TokenUsageEvent["usage"];
  readonly cumulativeUsage?: TokenUsageEvent["cumulative"];
  readonly stopReason?: StoppedEvent["reason"];
};

type MessageListProps = {
  readonly messages: readonly VisibleMessage[];
  readonly onSuggestion: (value: string) => void;
  readonly executablePlanMessageId?: string;
  readonly planActionDisabled: boolean;
  readonly onExecutePlan: (messageId: string) => void;
  readonly onPermissionDecision?: (
    requestId: string,
    decision: PermissionUserDecision,
  ) => void;
};

const suggestions = [
  "读取 README.md 并总结当前能力",
  "查找 src 目录下的 TypeScript 文件",
  "搜索代码中所有 ProviderError 的位置",
];

export function MessageList({
  messages,
  onSuggestion,
  executablePlanMessageId,
  planActionDisabled,
  onExecutePlan,
  onPermissionDecision = () => undefined,
}: MessageListProps) {
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
                  {message.progress && <AgentProgress progress={message.progress} />}
                  {message.toolExecutions && message.toolExecutions.length > 0 && (
                    <div className="toolExecutionList" aria-label="工具执行记录">
                      {message.toolExecutions.map((execution) => (
                        <ToolExecutionCard
                          key={`${execution.iteration}:${execution.callId}`}
                          execution={execution}
                          onPermissionDecision={onPermissionDecision}
                        />
                      ))}
                    </div>
                  )}
                  {message.content.length > 0 && <p className="messageText">{message.content}</p>}
                  {message.state === "streaming" && (
                    <span className="streamingCursor" aria-label="正在生成" />
                  )}
                  {message.cumulativeUsage && <UsageLine usage={message.cumulativeUsage} />}
                  {message.stopReason && (
                    <p className={`stopReason stopReason--${message.state}`}>
                      停止原因：{stopReasonLabel(message.stopReason)}
                    </p>
                  )}
                  {message.detail && (
                    <p className={`messageDetail messageDetail--${message.state}`}>
                      {message.detail}
                    </p>
                  )}
                  {message.id === executablePlanMessageId && message.state === "complete" && (
                    <div className="planAction">
                      <div>
                        <strong>计划已就绪</strong>
                        <span>将保留当前 Workspace 和对话上下文，以 Do 模式开始执行。</span>
                      </div>
                      <button
                        type="button"
                        disabled={planActionDisabled}
                        onClick={() => onExecutePlan(message.id)}
                      >
                        按此计划执行
                        <ArrowIcon />
                      </button>
                    </div>
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

function AgentProgress({ progress }: { readonly progress: ProgressEvent }) {
  const toolProgress = progress.phase === "tools"
    ? ` · 工具 ${progress.completedTools ?? 0}/${progress.totalTools ?? 0}`
    : " · 正在请求模型";
  const percentage = progress.phase === "tools" && progress.totalTools
    ? ((progress.iteration - 1) + (progress.completedTools ?? 0) / progress.totalTools)
      / progress.maxIterations * 100
    : (progress.iteration - 1) / progress.maxIterations * 100;

  return (
    <div className="agentProgress" aria-label="Agent 当前进度">
      <div className="progressHeader">
        <span>迭代 {progress.iteration}/{progress.maxIterations}</span>
        <span>{toolProgress}</span>
      </div>
      <div className="progressTrack" aria-hidden="true">
        <span style={{ width: `${Math.max(4, percentage)}%` }} />
      </div>
    </div>
  );
}

function UsageLine({ usage }: { readonly usage: TokenUsageEvent["cumulative"] }) {
  if (usage.availability === "unavailable") {
    return <p className="usageLine">Token 用量：模型未报告</p>;
  }
  return (
    <p className="usageLine">
      Token：{usage.totalTokens.toLocaleString()}（输入 {usage.promptTokens.toLocaleString()} · 输出 {usage.completionTokens.toLocaleString()}）
      {cacheUsageLabel(usage)}
    </p>
  );
}

function cacheUsageLabel(
  usage: Extract<TokenUsageEvent["cumulative"], { availability: "reported" }>,
): string {
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

function EmptyConversation({ onSuggestion }: { readonly onSuggestion: (value: string) => void }) {
  return (
    <div className="emptyConversation">
      <div className="emptyMark" aria-hidden="true"><span /><span /><span /></div>
      <p className="emptyEyebrow">NEW AUTONOMOUS SESSION</p>
      <h1>从一个任务开始。</h1>
      <p className="emptyDescription">
        OrbitCode 会自主调用模型与本地工具直到完成任务。输入 /plan 切换只读分析，输入 /do 恢复执行。
      </p>
      <div className="suggestionGrid" role="group" aria-label="示例问题">
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

function ToolExecutionCard({
  execution,
  onPermissionDecision,
}: {
  readonly execution: VisibleToolExecution;
  readonly onPermissionDecision: (
    requestId: string,
    decision: PermissionUserDecision,
  ) => void;
}) {
  const result = execution.result;
  const detail = result?.ok
    ? JSON.stringify(result.output, null, 2)
    : result
      ? `错误：\n${result.error.message}`
      : "参数已在服务端完成校验，原始内容不在页面展示。";
  const summary = result
    ? result.ok
      ? "查看执行结果"
      : "查看安全错误详情"
    : "查看安全调用说明";

  return (
    <section className={`toolCard toolCard--${execution.state}`}>
      <div className="toolCardHeader">
        <span className="toolStateDot" aria-hidden="true" />
        <code>{execution.name}</code>
        <span>第 {execution.iteration} 轮 · {toolStateLabel(execution.state)}</span>
      </div>
      <details className="toolCardDetails" open={execution.state === "failed" || execution.state === "timed-out"}>
        <summary>{summary}</summary>
        <pre>{detail}</pre>
      </details>
      {execution.permission && (
        <PermissionRequestCard
          request={execution.permission}
          onDecision={onPermissionDecision}
        />
      )}
    </section>
  );
}

function toolStateLabel(state: VisibleToolExecution["state"]): string {
  if (state === "queued") return "等待执行";
  if (state === "awaiting-approval") return "等待授权";
  if (state === "running") return "执行中";
  if (state === "succeeded") return "已完成";
  if (state === "timed-out") return "已超时";
  if (state === "cancelled") return "已取消";
  if (state === "skipped") return "已跳过";
  return "失败";
}

function stopReasonLabel(reason: StoppedEvent["reason"]): string {
  if (reason === "final-response") return "模型生成最终回复";
  if (reason === "max-iterations") return "达到最大迭代次数";
  if (reason === "cancelled") return "用户取消";
  if (reason === "repeated-unknown-tool") return "连续调用未知工具";
  if (reason === "model-error") return "模型响应流错误";
  return "Agent 内部错误";
}

function MessageState({ state }: { readonly state: VisibleMessage["state"] }) {
  if (state === "streaming") return <span className="messageState">运行中</span>;
  if (state === "cancelled") return <span className="messageState">已停止</span>;
  if (state === "failed") return <span className="messageState">未完成</span>;
  return null;
}

function ArrowIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 10h9M10.5 6.5 14 10l-3.5 3.5" /></svg>;
}

function DownIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4" /></svg>;
}
