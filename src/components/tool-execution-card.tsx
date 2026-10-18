"use client";
import { memo, useMemo } from "react";
import type { VisibleToolExecution } from "./message-list";
import type { PermissionUserDecision } from "@/core/permissions/approval";
import { PermissionRequestCard } from "./permission-request-card";
export const ToolExecutionCard = memo(function ToolExecutionCard({ execution, onPermissionDecision, }: {
    readonly execution: VisibleToolExecution;
    readonly onPermissionDecision: (requestId: string, decision: PermissionUserDecision) => void;
}) {
    const result = execution.result;
    const detail = useMemo(() => result?.ok
        ? JSON.stringify(result.output, null, 2)
        : result
            ? `错误：\n${result.error.message}`
            : "参数已在服务端完成校验，原始内容不在页面展示。", [result]);
    const summary = result
        ? result.ok
            ? "查看执行结果"
            : "查看安全错误详情"
        : "查看安全调用说明";
    return (<section className={`toolCard toolCard--${execution.state}`}>
      <div className="toolCardHeader">
        <span className="toolStateDot" aria-hidden="true"/>
        <code>{execution.name}</code>
        <span>第 {execution.iteration} 轮 · {toolStateLabel(execution.state)}</span>
      </div>
      <details className="toolCardDetails" open={execution.state === "failed" || execution.state === "timed-out"}>
        <summary>{summary}</summary>
        <pre>{detail}</pre>
      </details>
      {execution.permission && (<PermissionRequestCard request={execution.permission} onDecision={onPermissionDecision}/>)}
    </section>);
});
function toolStateLabel(state: VisibleToolExecution["state"]): string {
    if (state === "queued")
        return "等待执行";
    if (state === "awaiting-approval")
        return "等待授权";
    if (state === "running")
        return "执行中";
    if (state === "succeeded")
        return "已完成";
    if (state === "timed-out")
        return "已超时";
    if (state === "cancelled")
        return "已取消";
    if (state === "skipped")
        return "已跳过";
    return "失败";
}
