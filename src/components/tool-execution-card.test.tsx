import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolExecutionCard } from "./tool-execution-card";
import type { VisibleToolExecution } from "./message-list";

const meta = { durationMs: 1240, truncated: false, truncatedFields: [] };
function render(name: string, result: NonNullable<VisibleToolExecution["result"]>) {
  return renderToStaticMarkup(<ToolExecutionCard execution={{ name, result, iteration: 2, sequence: 0, callId: "example", state: result.ok ? "succeeded" : "failed", argumentsJson: '{"private":"ARGUMENT_SENTINEL"}' }}/>);
}
test("知识检索展示真实来源、降级及过期数量，兼容新旧片段格式", () => {
  const markup = render("search_knowledge", { ok: true, sideEffect: "none", meta, output: { kind: "results", retrieval: "keyword-fallback", degradedReason: "provider-unavailable", staleCount: 2, hits: [
    { path: "src/current.ts", startLine: 10, endLine: 12, label: "当前实现", sourceLines: "10|const current = true;", matchedBy: ["keyword"] },
    { path: "docs/design.md", startLine: 1, endLine: 3, label: "设计", excerpt: "旧格式片段", matchedBy: ["semantic"] },
  ] } });
  for (const text of ["检索仓库知识", "2 条候选证据", "关键词降级", "过滤 2 条失效来源", "src/current.ts", "10–12 行", "10|const current", "旧格式片段", "1.2 s"]) assert.ok(markup.includes(text), text);
  assert.doesNotMatch(markup, /ARGUMENT_SENTINEL/);
});
test("命令失败仍展示 stderr、退出码、截断和可能副作用，错误不需展开才能看到", () => {
  const markup = render("run_command", { ok: false, error: { kind: "command-failed", message: "命令以非零状态结束。", retryable: true }, sideEffect: "possible", meta: { ...meta, truncated: true, truncatedFields: ["stderr"] }, output: { command: "npm run typecheck", cwd: "packages/web", exitCode: 1, stdout: "checking", stderr: "TypeError: invalid input" } });
  for (const text of ["执行命令", "$ npm run typecheck", "工作目录：packages/web", "命令以非零状态结束", "退出码 1", "标准输出", "错误输出", "TypeError: invalid input", "服务端结果已截断", "可能已产生部分影响"]) assert.ok(markup.includes(text), text);
});
test("原始大载荷按需渲染，文件预览明确省略且不会执行 HTML", () => {
  const content = '<script>alert("x")</script>\n' + "line\n".repeat(100) + "TAIL_SENTINEL";
  const markup = render("read_file", { ok: true, output: { path: "sample.ts", content }, sideEffect: "none", meta });
  assert.match(markup, /原始结果/);
  assert.match(markup, /预览已省略/);
  assert.doesNotMatch(markup, /TAIL_SENTINEL|<script>/);
  assert.match(markup, /&lt;script&gt;/);
});
test("零命中与检索业务失败不伪装成检索成功，批量写入显示已完成文件", () => {
  const empty = render("search_code", { ok: true, output: { matches: [], count: 0 }, sideEffect: "none", meta });
  assert.match(empty, /没有匹配的代码/);
  const unavailable = render("search_knowledge", { ok: true, output: { kind: "failure", code: "not-indexed", message: "请先构建索引。" }, sideEffect: "none", meta });
  assert.match(unavailable, /知识检索暂不可用/);assert.match(unavailable, /请先构建索引/);assert.doesNotMatch(unavailable, /混合检索/);
  assert.match(unavailable, /检索仓库知识 · 检索不可用/);assert.doesNotMatch(unavailable, /toolStatus--succeeded/);
  const unknown = render("search_knowledge", { ok: true, output: { legacy: "旧版数据" }, sideEffect: "none", meta });
  assert.match(unknown, /旧版数据/);assert.doesNotMatch(unknown, /混合检索|0 条候选证据/);
  const batch = render("write_files", { ok: false, error: { kind: "cancelled", message: "批量写入已取消", retryable: true }, output: { files: [{ path: "done.ts", created: true, byteLength: 10 }] }, sideEffect: "applied", meta });
  assert.match(batch, /已写入 1 个文件/);assert.match(batch, /done.ts/);
});
