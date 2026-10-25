import type { ReactNode } from "react";
import type { JsonValue } from "@/tools/types";

export function resultRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function resultText(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function preview(value: string, maxLines = 16): string {
  const lines = value.split("\n");
  const text = lines.slice(0, maxLines).join("\n");
  return text.slice(0, 2400) + (lines.length > maxLines || text.length > 2400 ? "\n… 预览已省略，完整内容见原始结果" : "");
}
function CodePreview({ text, label, lines = 16 }: { readonly text: string; readonly label?: string; readonly lines?: number }) {
  return <div className="toolOutputBlock">{label && <div className="toolOutputLabel">{label}</div>}<pre>{preview(text, lines)}</pre></div>;
}
function EmptyResult({ children }: { readonly children: ReactNode }) {
  return <p className="toolEmptyResult">{children}</p>;
}
function ResultRows({ rows, limit = 5 }: { readonly rows: readonly ReactNode[]; readonly limit?: number }) {
  return <>{rows.slice(0, limit)}{rows.length > limit && <details className="toolMoreResults"><summary>展开其余 {rows.length - limit} 项</summary>{rows.slice(limit)}</details>}</>;
}

export function ToolResultView({ name, output }: { readonly name: string; readonly output: JsonValue | undefined }) {
  const data = resultRecord(output);
  if (name === "search_knowledge" && (data.kind === "results" || data.kind === "failure")) {
    if (data.kind === "failure") return <div className="toolResultNotice toolResultNotice--warning"><strong>知识检索暂不可用</strong><p>{resultText(data.message) || resultText(resultRecord(data.error).message) || "请展开原始结果查看原因。"}</p></div>;
    const hits = Array.isArray(data.hits) ? data.hits : [];
    return <>
      <div className="toolResultStats"><strong>{hits.length} 条候选证据</strong><span>{data.retrieval === "keyword-fallback" ? "关键词降级" : "混合检索"}</span>{typeof data.staleCount === "number" && data.staleCount > 0 && <span>过滤 {data.staleCount} 条失效来源</span>}</div>
      {typeof data.degradedReason === "string" && <p className="toolResultHint">语义检索未完成，当前展示关键词检索结果。</p>}
      {hits.length === 0 ? <EmptyResult>当前索引没有返回可用证据，可换个描述或更新索引后重试。</EmptyResult> : <div className="toolSourceList"><ResultRows limit={2} rows={hits.map((value, index) => {
        const hit = resultRecord(value);
        return <article className="toolSource" key={index}><div className="toolSourceHeading"><span className="toolSourceNumber">{index + 1}</span><code>{resultText(hit.path)}</code><span className="toolSourceRange">{String(hit.startLine ?? "?")}–{String(hit.endLine ?? "?")} 行</span></div><strong className="toolSourceTitle">{resultText(hit.label) || "来源片段"}</strong><CodePreview lines={2} text={resultText(hit.sourceLines) || resultText(hit.excerpt)}/><div className="toolSourceTags">{Array.isArray(hit.matchedBy) && hit.matchedBy.map((method, i) => <span key={i}>{method === "semantic" ? "语义匹配" : method === "keyword" ? "关键词匹配" : String(method)}</span>)}{hit.historical === true && <span>历史资料</span>}</div></article>;
      })}/></div>}
      <p className="toolResultHint">检索片段用于定位；修改前仍需读取当前文件。</p>
    </>;
  }
  if (name === "find_files" && Array.isArray(data.paths)) {
    return <><div className="toolResultStats"><strong>找到 {typeof data.count === "number" ? data.count : data.paths.length} 个文件</strong></div>{data.paths.length ? <div className="toolFileList"><ResultRows rows={data.paths.map((file, index) => <code className="toolFileRow" key={index}>{resultText(file)}</code>)}/></div> : <EmptyResult>没有匹配的文件。</EmptyResult>}</>;
  }
  if (name === "search_code" && Array.isArray(data.matches)) {
    return <><div className="toolResultStats"><strong>{typeof data.count === "number" ? data.count : data.matches.length} 处匹配</strong>{typeof data.skippedFiles === "number" && data.skippedFiles > 0 && <span>跳过 {data.skippedFiles} 个文件</span>}</div>{data.matches.length ? <div className="toolMatchList"><ResultRows rows={data.matches.map((value, index) => { const match = resultRecord(value); return <div className="toolMatch" key={index}><div className="toolSourceHeading"><code>{resultText(match.path)}</code><span className="toolSourceRange">{String(match.line ?? "?")} 行</span></div><pre>{preview(resultText(match.text))}</pre></div>; })}/></div> : <EmptyResult>没有匹配的代码。</EmptyResult>}</>;
  }
  if (name === "run_command" || typeof data.stdout === "string" || typeof data.stderr === "string") {
    return <>{resultText(data.command) && <CodePreview label={`执行命令${resultText(data.cwd) ? ` · 工作目录：${resultText(data.cwd)}` : ""}`} text={`$ ${resultText(data.command)}`}/>}<div className="toolResultStats">{typeof data.exitCode === "number" && <strong>退出码 {data.exitCode}</strong>}{data.timedOut === true && <span>执行超时</span>}{data.cancelled === true && <span>执行已取消</span>}</div>{resultText(data.stdout) && <CodePreview label="标准输出" text={resultText(data.stdout)}/>} {resultText(data.stderr) && <CodePreview label="错误输出" text={resultText(data.stderr)}/>} {!resultText(data.stdout) && !resultText(data.stderr) && <EmptyResult>命令未产生文本输出。</EmptyResult>}</>;
  }
  if (name === "read_file" && typeof data.content === "string") {
    const range = resultRecord(data.range);
    return <><div className="toolResultStats"><code>{resultText(data.path) || "文件内容"}</code>{typeof range.startLine === "number" && <span>第 {range.startLine}–{String(range.endLine)} 行{range.complete === false ? " · 部分内容" : ""}</span>}</div><CodePreview text={data.content}/></>;
  }
  if (name === "write_files" && Array.isArray(data.files)) {
    return <><div className="toolResultStats"><strong>已写入 {data.files.length} 个文件</strong></div><div className="toolFileList"><ResultRows rows={data.files.map((value, index) => { const file = resultRecord(value); return <div className="toolFileRow" key={index}><span className="toolFileAction">{file.created === true ? "新增" : "写入"}</span><code>{resultText(file.path)}</code></div>; })}/></div></>;
  }
  if (["write_file", "edit_file"].includes(name) && typeof data.path === "string") {
    return <div className="toolChangeSummary"><span className="toolChangeMark">✓</span><div><strong>{name === "edit_file" ? "文件已修改" : data.created === true ? "文件已创建" : "文件已写入"}</strong><code>{data.path}</code>{typeof data.replacements === "number" && <span>完成 {data.replacements} 处替换</span>}</div></div>;
  }
  if (typeof data.content === "string") return <CodePreview text={data.content}/>;
  if (Array.isArray(data.content)) {
    const texts = data.content.map(value => resultText(resultRecord(value).text)).filter(Boolean);
    if (texts.length) return <CodePreview text={texts.join("\n")}/>;
  }
  if (typeof output === "string") return <CodePreview text={output}/>;
  const entries = Object.entries(data).filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean").slice(0, 6);
  return entries.length ? <dl className="toolFieldList">{entries.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{preview(String(value))}</dd></div>)}</dl> : <EmptyResult>执行结果已返回，展开原始结果查看完整数据。</EmptyResult>;
}
