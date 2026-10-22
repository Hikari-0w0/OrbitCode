import {createHash} from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "@/core/agent-events";
import { successfulToolResult } from "@/tools/registry";
import { toolFailure, type ToolExecutionResult } from "@/tools/types";
import { ChildHandoff } from "./handoff";

const event = (name: string, result: ToolExecutionResult, callId = "actual-call"): AgentEvent => ({ type: "tool-result", iteration: 1, sequence: 0, name, callId, result });

test("交接保留命令失败到复验顺序、部分批量写入，不把命令副作用当完整文件清单", () => {
  const facts = new ChildHandoff();
  facts.record(event("write_file", successfulToolResult({ path: "module.mjs", byteLength: 1 }, "applied")));
  facts.record(event("edit_file", successfulToolResult({ path: "module.mjs" }, "applied")));
  facts.record(event("write_files", { ...toolFailure("cancelled", "取消", { sideEffect: "applied" }), output: { files: [{ path: "test.mjs" }] } }));
  facts.record(event("write_file", toolFailure("permission-denied", "不能进入摘要的错误正文")));
  facts.record(event("run_command", { ...toolFailure("command-failed", "失败"), output: { exitCode: 1, stderr: "private output", command: "private command" } }, "failed-call"));
  facts.record(event("run_command", successfulToolResult({ exitCode: 0, path: "not-confirmed.txt" }, "applied"), "verified-call"));
  const result = facts.snapshot();
  assert.deepEqual(result.fileWrites, { scope: "file-tool-results-only", paths: ["module.mjs", "test.mjs"], omitted: 0 });
  assert.deepEqual(result.commandCalls.results.map(call => [call.callId, call.ok, call.exitCode]), [["failed-call", false, 1], ["verified-call", true, 0]]);
  assert.doesNotMatch(JSON.stringify(result), /private|不能进入/);
});

test("交接有界且不从未执行的调用、模型文本或非法工具输出推断写入", () => {
  const facts = new ChildHandoff();
  facts.record({ type: "tool-call", iteration: 1, sequence: 0, call: { id: "not-run", name: "write_file", argumentsJson: '{"path":"not-run.txt"}' } });
  facts.record(event("read_file", successfulToolResult({ path: "read.txt" }, "none")));
  for (let i = 0; i < 40; i++) {
    facts.record(event("run_command", successfulToolResult({ exitCode: 0 }), `call-${i}`));
    facts.record(event("write_file", successfulToolResult({ path: `file-${i}` }, "applied")));
  }
  facts.record(event("write_file", successfulToolResult({ path: "长".repeat(1024) }, "applied")));
  const result = facts.snapshot();
  assert.equal(result.commandCalls.count, 40);
  assert.equal(result.commandCalls.omitted, 24);
  assert.equal(result.commandCalls.results[0].callId, "call-24");
  assert.equal(result.fileWrites.paths.length, 8);
  assert.equal(result.fileWrites.omitted, 33);
  assert.doesNotMatch(JSON.stringify(result.fileWrites), /not-run|read.txt/);
  assert.notEqual(facts.snapshot().commandCalls.results, result.commandCalls.results);
});

test("只读交接仅保留工具确认的路径与定位，有界去重且无源码正文", () => {
  const facts = new ChildHandoff();
  facts.record(event("read_file", toolFailure("not-found", "不可读取")));
  facts.record(event("read_file", successfulToolResult({ path: "src/main.ts", content: "secret code" }), "read"));
  facts.record(event("search_code", successfulToolResult({ matches: [{ path: "src/main.ts", line: 10, text: "secret code" }, { path: "../escape", line: 1 }] }), "search"));
  facts.record(event("search_code", successfulToolResult({ matches: [{ path: "src/main.ts", line: 10 }] }), "again"));
  const result = facts.snapshot();
  assert.deepEqual(result.reads, { files: [{ path: "src/main.ts", callId: "read", sha256:createHash("sha256").update("secret code").digest("hex"),byteLength:11 }], matches: [{ path: "src/main.ts", line: 10, callId: "search" }], omitted: 0 });
  assert.doesNotMatch(JSON.stringify(result), /secret|escape/);
  for (let i = 0; i < 30; i++) facts.record(event("read_file", successfulToolResult({ path: `src/file-${i}.ts` }), `read-${i}`));
  assert.equal(facts.snapshot().reads?.files.length, 16);
  assert.equal(facts.snapshot().reads?.omitted, 15);
  assert.equal(result.reads?.files.length, 1);
  facts.record(event("read_file", successfulToolResult({ path: "长".repeat(200) })));
  assert.equal(facts.snapshot().reads?.omitted, 16);
});

test("全文搜索交接保存工具确认范围与精确计数，分页或伪造范围不算全量检索", () => {
  const facts = new ChildHandoff();
  const reference = "context://v1/00000000-0000-4000-8000-000000000001";
  const output = { reference, mode: "search", query: "needle", complete: true, matchCount: 0, totalCharacters: 80000, searchedFrom: 0, searchedUntil: 80000 };
  const event = (value: typeof output, callId: string) => ({ type: "tool-result" as const, iteration: 1, sequence: 1, name: "read_context", callId, result: successfulToolResult(value) });
  facts.record(event({ ...output, searchedFrom: 10 }, "partial"));
  assert.equal(facts.snapshot().reads?.contextSearches, undefined);
  facts.record(event(output, "actual"));
  assert.deepEqual(facts.snapshot().reads?.contextSearches, [{ reference, query: "needle", complete: true, callId: "actual", matchCount: 0, totalCharacters: 80000 }]);
  for (let i = 0; i < 5; i++) facts.record(event(output, `more-${i}`));
  assert.equal(facts.snapshot().reads?.contextSearches?.length, 4);
  assert.equal(facts.snapshot().reads?.omitted, 2);
});
