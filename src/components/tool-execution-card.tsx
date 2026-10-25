"use client";
import { memo, useMemo, useState } from "react";
import type { VisibleToolExecution } from "./message-list";
import { PermissionRequestCard } from "./permission-request-card";
import { resultRecord, resultText, ToolResultView } from "./tool-result-view";

const TOOL_LABELS: Readonly<Record<string, string>> = {
  search_knowledge: "检索仓库知识", read_file: "读取文件", find_files: "查找文件", search_code: "搜索代码",
  write_file: "写入文件", write_files: "批量写入文件", edit_file: "修改文件", run_command: "运行命令",
  agent: "执行子任务", load_skill: "加载技能", read_skill_resource: "读取技能资源", read_context: "读取上下文",
  read_memory: "读取记忆", start_process: "启动进程", process_status: "查看进程", stop_process: "停止进程",
};
const STATE_LABELS: Readonly<Record<VisibleToolExecution["state"], string>> = {
  queued: "等待执行", "awaiting-approval": "等待授权", running: "执行中", succeeded: "已完成",
  failed: "执行失败", "timed-out": "已超时", cancelled: "已取消", skipped: "已跳过",
};

export const ToolExecutionCard = memo(function ToolExecutionCard({ execution }: { readonly execution: VisibleToolExecution }) {
  const [rawOpen, setRawOpen] = useState(false);
  const result = execution.result;
  // 原始数据只在用户展开时序列化，避免流式消息频繁渲染大段 JSON。
  const raw = useMemo(() => rawOpen && result ? JSON.stringify(result, null, 2) : "", [rawOpen, result]);
  const data = resultRecord(result?.output);
  const unavailable = execution.name === "search_knowledge" && data.kind === "failure";
  const status = unavailable ? "检索不可用" : STATE_LABELS[execution.state];
  const target = resultText(data.path);
  const title = TOOL_LABELS[execution.name] ?? (execution.name.startsWith("mcp__") ? "调用外部工具" : "执行工具");
  return <section className={`toolCard toolCard--${execution.state}`} aria-label={`${title} · ${status}`}>
    <header className="toolCardHeader"><span className="toolKindIcon" aria-hidden="true"><ToolIcon name={execution.name}/></span><div className="toolCardIdentity"><strong>{title}</strong><code>{execution.name}</code></div><div className="toolCardMeta"><span className={`toolStatus toolStatus--${unavailable ? "unavailable" : execution.state}`}><span className="toolStateDot" aria-hidden="true"/>{status}</span><span>第 {execution.iteration} 轮{result ? ` · ${formatDuration(result.meta.durationMs)}` : ""}</span></div></header>
    {target && execution.name !== "read_file" && execution.name !== "write_file" && execution.name !== "edit_file" && <code className="toolTarget">{target}</code>}
    {result ? <div className="toolCardBody">
      {!result.ok && <div className="toolResultNotice toolResultNotice--error"><strong>{result.error.kind === "timeout" ? "工具执行超时" : result.error.kind === "permission-denied" || result.error.kind === "protected-path" ? "访问受到限制" : "工具未能完成"}</strong><p>{result.error.message}</p><code>{result.error.kind}</code></div>}
      {(result.ok || result.output !== undefined) && <ToolResultView name={execution.name} output={result.output}/>}
      {result.meta.truncated && <p className="toolResultHint toolResultHint--warning">服务端结果已截断{result.meta.truncatedFields.length ? `（${result.meta.truncatedFields.join("、")}）` : ""}，当前内容并非完整输出。</p>}
      {result.sideEffect === "possible" && !result.ok && <p className="toolResultHint toolResultHint--warning">操作可能已产生部分影响，重试前请核对当前状态。</p>}
    </div> : <p className="toolPending"><span className="toolStateDot" aria-hidden="true"/>{execution.state === "running" ? "正在执行，结果将在此处显示…" : execution.state === "awaiting-approval" ? "等待授权后继续执行。" : execution.state === "queued" ? "工具已加入执行队列。" : "本次调用没有返回执行结果。"}</p>}
    {result && <details className="toolCardDetails" onToggle={event => setRawOpen(event.currentTarget.open)}><summary>原始结果<span>完整结构化数据</span></summary>{rawOpen && <pre>{raw}</pre>}</details>}
    {execution.permission && <PermissionRequestCard request={execution.permission}/>}
  </section>;
});
function formatDuration(milliseconds: number): string {
  return milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}
function ToolIcon({ name }: { readonly name: string }) {
  const path = name === "run_command" ? "m4 6 4 4-4 4m7 0h5" : name === "search_knowledge" ? "M8 3H4v14h12V9m-8-6h5l3 3v3M8 3v6h8m-9 4h6" : name === "search_code" || name === "find_files" ? "m14 14 4 4M15 9a6 6 0 1 1-12 0 6 6 0 0 1 12 0" : "M5 2h7l4 4v12H5zM11 2v5h5M8 11h5m-5 3h5";
  return <svg viewBox="0 0 20 20"><path d={path}/></svg>;
}
