import assert from "node:assert/strict";
import test from "node:test";
import { CompletionTracker, isCompletionAssessment } from "./completion-tracker";
import { successfulToolResult } from "@/tools/registry";
import { toolFailure } from "@/tools/types";

test("本地写入和成功验证只保留证据，不自动宣告任务通过", () => {
  const tracker = new CompletionTracker({ createRunId: () => "local" });
  tracker.record({ call: { id: "write", name: "write_file", argumentsJson: '{}' }, result: successfulToolResult({}, "applied"), iteration: 1, sequence: 0, mutability: "workspace-write" });
  const id = tracker.record({ call: { id: "check", name: "run_command", argumentsJson: '{"command":"node check.mjs"}' }, result: successfulToolResult({ exitCode: 0 }), iteration: 2, sequence: 0, mutability: "command" });
  assert.equal(id, "e_local_2");
  assert.equal(tracker.evidenceId("check"), id);
  assert.deepEqual(tracker.assessment(), { status: "unverified", checks: [], blockers: [] });
});

test("证据ID重试稳定且每轮隔离，不把旧报告验证带入新轮次", () => {
  let run = 0;
  const tracker = new CompletionTracker({ createRunId: () => `run${++run}` });
  const input = { call: { id: "same", name: "read_file", argumentsJson: '{}' }, result: successfulToolResult({}), iteration: 1, sequence: 0, mutability: "read-only" as const };
  assert.equal(tracker.record(input), "e_run1_1");
  assert.equal(tracker.record(input), "e_run1_1");
  tracker.beginRun();
  assert.equal(tracker.evidenceId("same"), undefined);
  assert.equal(tracker.record(input), "e_run2_1");
  assert.equal(tracker.assessment().status, "unverified");
});

test("外部调用的成功和失败只表示返回被观测，不证明副作用或任务完成", () => {
  const tracker = new CompletionTracker();
  for (const [index, result] of [successfulToolResult({}), toolFailure("mcp-tool-error", "受控失败")].entries()) tracker.record({ call: { id: `mcp-${index}`, name: "mcp__fixture", argumentsJson: '{}' }, result, iteration: index + 1, sequence: 0, mutability: "external" });
  const assessment = tracker.assessment();
  assert.equal(assessment.status, "observed");
  assert.deepEqual(assessment.checks.map(check => check.status), ["passed", "failed"]);
  assert.ok(assessment.checks.every(check => check.scope === "external-call"));
  assert.equal(isCompletionAssessment(assessment), true);
});

test("读取卸载引用不扩大外部调用验收，混入本地操作保持未自动验收", () => {
  const tracker = new CompletionTracker();
  const record = (name: string, mutability: "external" | "read-only") => tracker.record({ call: { id: name, name, argumentsJson: '{}' }, result: successfulToolResult({}), iteration: 1, sequence: 0, mutability });
  record("mcp__fixture", "external"); record("read_context", "read-only");
  assert.equal(tracker.assessment().status, "observed");
  record("read_file", "read-only");
  assert.equal(tracker.assessment().status, "unverified");
});

test("被动外部调用摘要有界，原始证据映射仍保留", () => {
  const tracker = new CompletionTracker();
  for (let i = 0; i < 30; i++) tracker.record({ call: { id: `external-${i}`, name: "mcp__fixture", argumentsJson: '{}' }, result: successfulToolResult({}), iteration: i + 1, sequence: 0, mutability: "external" });
  assert.equal(tracker.assessment().checks.length, 20);
  assert.ok(tracker.evidenceId("external-0"));
  assert.equal(isCompletionAssessment(tracker.assessment()), true);
});

test("旧会话验证状态继续严格读取，非法或额外字段仍被拒绝", () => {
  const old = { status: "verified", checks: [{ criterion: "历史已验证检查", status: "passed", evidenceCallIds: ["e_old_1"] }], blockers: [] };
  assert.equal(isCompletionAssessment(old), true);
  assert.equal(isCompletionAssessment({ ...old, extra: true }), false);
  assert.equal(isCompletionAssessment({ ...old, checks: [{ ...old.checks[0], evidenceCallIds: ["../invalid"] }] }), false);
  assert.equal(isCompletionAssessment({ ...old, status: "complete" }), false);
});

test("证据运行标识拒绝不安全字符", () => {
  assert.throws(() => new CompletionTracker({ createRunId: () => "../outside" }));
});

test("相同失败提示有界且不泄漏参数，成功变更后重试不沿用旧计数", () => {
  const tracker = new CompletionTracker();
  const fail = (id: string, args = '{"path":"PRIVATE"}') => tracker.record({ call: { id, name: "search_code", argumentsJson: args }, result: toolFailure("invalid-arguments", "PRIVATE"), iteration: 2, sequence: 0, mutability: "read-only" });
  fail("a"); fail("b");
  assert.deepEqual(tracker.reviewMessages(), []);
  fail("c");
  assert.match(tracker.reviewMessages()[0].content, /重复失败提示/u);
  assert.doesNotMatch(tracker.reviewMessages()[0].content, /PRIVATE/u);
  assert.equal(tracker.assessment().status, "unverified");
  tracker.record({ call: { id: "write", name: "write_file", argumentsJson: "{}" }, result: successfulToolResult({}, "applied"), iteration: 3, sequence: 0, mutability: "workspace-write" });
  fail("d");
  assert.doesNotMatch(JSON.stringify(tracker.reviewMessages()), /重复失败提示/u);
  tracker.beginRun();
  for (let i = 0; i < 100; i++) fail(String(i), JSON.stringify({ path: String(i) }));
  fail("old-a", '{"path":"0"}'); fail("old-b", '{"path":"0"}');
  assert.deepEqual(tracker.reviewMessages(), []);
});

test("运行复核保留失败、截断和时序，零退出不自动验收且不注入工具正文", () => {
  const tracker = new CompletionTracker({ createRunId: () => "review" });
  assert.deepEqual(tracker.reviewMessages(), []);
  tracker.record({ call: { id: "write", name: "write_file", argumentsJson: '{"content":"PRIVATE"}' }, result: successfulToolResult({}, "applied"), iteration: 1, sequence: 0, mutability: "workspace-write" });
  tracker.record({ call: { id: "fail", name: "run_command", argumentsJson: '{"command":"PRIVATE"}' }, result: { ...toolFailure("command-failed", "PRIVATE"), output: { exitCode: 7, stdout: "PRIVATE" }, meta: { durationMs: 1, truncated: true, truncatedFields: ["stdout"] } }, iteration: 2, sequence: 0, mutability: "command" });
  tracker.record({ call: { id: "pass", name: "run_command", argumentsJson: '{}' }, result: successfulToolResult({ exitCode: 0 }), iteration: 3, sequence: 0, mutability: "command" });
  const content = tracker.reviewMessages()[0].content;
  assert.match(content, /第1轮\/0 文件写入/u);
  assert.match(content, /第2轮\/0 命令：工具失败\(command-failed\)；exitCode=7；输出已截断/u);
  assert.match(content, /第3轮\/0 命令：工具返回成功；exitCode=0/u);
  assert.doesNotMatch(content, /PRIVATE/u);
  assert.equal(tracker.assessment().status, "unverified");
  tracker.beginRun();
  assert.deepEqual(tracker.reviewMessages(), []);
});

test("运行复核只保留有界本地事实，并按轮次和批次顺序而非并行完成顺序排列", () => {
  const tracker = new CompletionTracker({ createRunId: () => "bounded" });
  for (let i = 10; i > 0; i--) tracker.record({ call: { id: `cmd-${i}`, name: "run_command", argumentsJson: '{}' }, result: successfulToolResult({ exitCode: 0 }), iteration: 2, sequence: i, mutability: "command" });
  tracker.record({ call: { id: "read", name: "read_file", argumentsJson: '{}' }, result: successfulToolResult({}), iteration: 3, sequence: 0, mutability: "read-only" });
  const content = tracker.reviewMessages()[0].content;
  assert.match(content, /共 10 项，显示最近 8 项/u);
  assert.doesNotMatch(content, /第2轮\/1 /u);
  assert.ok(content.indexOf("第2轮/3 ") < content.indexOf("第2轮/10 "));
});
