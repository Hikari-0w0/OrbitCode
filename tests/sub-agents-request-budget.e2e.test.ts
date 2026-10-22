import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { runtimeFixture } from "./helpers/runtime-fixture";
import { call, say, writeSkill } from "./helpers/skill-fixture";

test("独立Skill不领取新请求预算，执行文件工具后续轮同样被共享额度拒绝", async () => {
  let parents = 0, children = 0;
  const f = await runtimeFixture(request => {
    if (JSON.stringify(request.body).includes("BUDGET_ISOLATED_SKILL_MARKER")) { children++; return call("read_file", { path: "evidence.txt" }, "skill-read"); }
    parents++; return call("load_skill", { name: "budget-worker", arguments: "读取文件" }, "load");
  }, { subAgentLimits: { groupRequests: 2 } });
  try {
    await writeSkill(f, "budget-worker", { mode: "isolated", body: "BUDGET_ISOLATED_SKILL_MARKER：只读取 evidence.txt。" });
    await writeFile(path.join(f.root, "evidence.txt"), "独立执行原文"); await f.controller.handleLine("启动budget-worker");
    const cp = await f.checkpoint(), budget = f.runtime.usageFor(await f.runtime.taskScope(cp.summary.id)).requestBudgets[0];
    assert.equal(parents, 1); assert.equal(children, 1); assert.equal(f.server.requests.length, 2);
    assert.equal(budget.admittedAttempts, 2); assert.equal(budget.inFlight, 0); assert.ok(budget.rejectedRequests >= 1);
    assert.equal(cp.summary.lastStopReason, "model-error");
    const delivery = cp.context.messages.find(message => message.kind === "tool-result" && message.toolCallId === "load");
    assert.ok(delivery?.kind === "tool-result" && delivery.payload.storage === "inline");
    const result: unknown = JSON.parse(delivery.payload.content);
    assert.ok(typeof result === "object" && result !== null && "output" in result);
    const output = result.output;
    assert.ok(typeof output === "object" && output !== null && "runId" in output && typeof output.runId === "string");
    const childRun = await f.log.find(output.runId);
    assert.ok(childRun.tools.some(tool => tool.name === "read_file" && tool.status === "succeeded"));
  } finally { await f.close(); }
});

test("父结束和下一轮不为存活子任务补额度，预算拒绝前不发送HTTP且清理完整", async () => {
  let parents = 0, children = 0, release!: () => void, childStarted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { childStarted = resolve; });
  const f = await runtimeFixture(async request => {
    if (JSON.stringify(request.body).includes("orbitcode_child_role")) { children++; childStarted(); await gate; return call("read_file", { path: "evidence.txt" }, "child-read"); }
    if (++parents === 1) return call("agent", { operation: "start", task: { kind: "defined", role: "explorer", prompt: "读文件后说明", background: true } }, "delegate");
    if (parents === 2) await started;
    return say("父结束");
  }, { subAgentLimits: { groupRequests: 3 } });
  try {
    await f.runtime.memory.setEnabled(false); await writeFile(path.join(f.root, "evidence.txt"), "实际读取内容");
    await f.controller.handleLine("创建后台任务");
    const cp = await f.checkpoint(), scope = await f.runtime.taskScope(cp.summary.id), task = f.runtime.tasks.list(scope)[0];
    assert.equal(task.state.status, "running"); assert.equal(parents, 2); assert.equal(children, 1);
    assert.equal(task.admission?.requestBudget.limit, 3);
    await f.controller.handleLine("下一轮直接回复"); assert.equal(parents, 3);
    release(); const done = await f.runtime.tasks.wait(scope, task.id, 3000, new AbortController().signal);
    assert.ok(done.task.state.status === "terminal" && done.task.state.result.stopReason === "model-error" && done.task.state.result.cleanup === "complete");
    if (done.task.state.status === "terminal") assert.ok(done.task.state.result.handoff?.reads?.files.some(file => file.path === "evidence.txt"));
    assert.equal(children, 1); assert.equal(f.server.requests.length, 4);
    const groups = f.runtime.usageFor(scope).requestBudgets;
    assert.equal(groups.length, 2); const first = groups.find(group => group.id === task.admission?.requestBudget.id);
    assert.equal(first?.admittedAttempts, 3); assert.equal(first?.rejectedRequests, 1); assert.equal(first?.inFlight, 0);
    const latest = await f.checkpoint(); await f.runtime.invalidateTasks(latest);
    assert.equal(f.runtime.usageFor(scope).requestBudgets.length, 0);
  } finally { release(); await f.close(); }
});

test("只有一个请求额度时父工具执行保留，模型续轮被预算中止且不额外请求", async () => {
  const f = await runtimeFixture(() => call("read_file", { path: "evidence.txt" }, "read"), { subAgentLimits: { groupRequests: 1 } });
  try {
    await f.runtime.memory.setEnabled(false); await writeFile(path.join(f.root, "evidence.txt"), "原文");
    await f.controller.handleLine("读取文件再回答"); const cp = await f.checkpoint();
    assert.equal(cp.summary.lastStopReason, "model-error"); assert.equal(f.server.requests.length, 1);
    assert.ok(cp.context.messages.some(message => message.kind === "tool-result"));
    const budget = f.runtime.usageFor(await f.runtime.taskScope(cp.summary.id)).requestBudgets[0];
    assert.equal(budget.admittedAttempts, 1); assert.equal(budget.rejectedRequests, 1);
  } finally { await f.close(); }
});
