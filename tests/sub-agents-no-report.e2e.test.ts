import {createHash} from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runtimeFixture } from "./helpers/runtime-fixture";
import { call, say } from "./helpers/skill-fixture";

for (const kind of ["defined", "fork"] as const) test(`${kind} 子执行直接验证并结束，无报告工具或报告门禁`, async () => {
  let parentStep = 0, childStep = 0;
  const f = await runtimeFixture(request => {
    const body = request.body as { messages: { role: string; content?: string }[]; tools?: { function: { name: string } }[] };
    assert.ok(body.tools?.every(tool => tool.function.name !== "report_completion"));
    if (JSON.stringify(body).includes("orbitcode_child_role")) {
      if (++childStep === 1) return call("read_file", { path: "a.txt" }, "child-read");
      if (childStep === 2) return call("edit_file", { path: "a.txt", old_text: "before", new_text: "after" }, "child-edit");
      if (childStep === 3) return call("read_file", { path: "a.txt" }, "child-verify");
      return say("已修改并回读；未验证浏览器交互。");
    }
    if (++parentStep === 1) return call("agent", { operation: "start", task: { kind, ...(kind === "defined" ? { role: "worker" } : {}), prompt: "读取修改并回读a.txt，只执行当前子任务", background: true } }, "start");
    if (parentStep === 2) {
      const result = body.messages.filter(message => message.role === "tool").map(message => JSON.parse(message.content ?? "{}")).find(value => value.output?.taskId);
      assert.ok(result?.output.taskId);
      return call("agent", { operation: "wait", taskId: result.output.taskId, timeoutMs: 3000 }, "wait");
    }
    return say("子工具事实已保留；任务验收仍以独立检查为准。");
  }, { terminal: true });
  try {
    await f.runtime.memory.setEnabled(false);
    await mkdir(path.join(f.root, ".orbitcode/agents"), { recursive: true });
    await writeFile(path.join(f.root, ".orbitcode/agents/worker.md"), (await readFile("agents/general.md", "utf8")).replace("name: general", "name: worker").replace("permission-mode: default", "permission-mode: permissive"));
    await writeFile(path.join(f.root, "a.txt"), "before");

    await f.controller.handleLine("委派修改并验证");
    assert.equal(await readFile(path.join(f.root, "a.txt"), "utf8"), "after");
    assert.equal(childStep, 4);
    assert.equal(parentStep, 3);
    const cp = await f.checkpoint(), scope = await f.runtime.taskScope(cp.summary.id), tasks = f.runtime.tasks.list(scope);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].state.status, "terminal");
    if (tasks[0].state.status !== "terminal") throw new Error("未结束");
    assert.equal(tasks[0].state.result.stopReason, "final-response");
    assert.equal(tasks[0].state.result.verification.status, "unverified");
    assert.equal(tasks[0].state.result.handoff?.completionReports, undefined);
    assert.deepEqual(tasks[0].state.result.handoff?.fileWrites.paths, ["a.txt"]);
    assert.equal(cp.context.messages.filter(message => message.kind === "child-result").length, 1);
    assert.equal(f.errors(), "");
  } finally { await f.close(); }
});

test("两次普通参数失败后仍可修复验证，不因报告门禁隐藏工具", async () => {
  let step = 0;
  const f = await runtimeFixture(request => {
    const body = request.body as { tools?: { function: { name: string } }[] };
    assert.ok(body.tools);
    assert.ok(body.tools.some(tool => tool.function.name === "read_file"));
    assert.ok(body.tools.every(tool => tool.function.name !== "report_completion"));
    if (++step <= 2) return call("read_file", { path: 42 }, `bad-${step}`);
    if (step === 3) return call("read_file", { path: "a.txt" }, "valid");
    return say("参数已纠正，实际读取成功。");
  });
  try {
    await f.runtime.memory.setEnabled(false);
    await writeFile(path.join(f.root, "a.txt"), "actual");
    await f.controller.handleLine("读取文件");
    const cp = await f.checkpoint();
    assert.equal(step, 4);
    assert.equal(cp.displayMessages[1].stopReason, "final-response");
    assert.deepEqual(cp.displayMessages[1].toolExecutions?.map(tool => tool.result.ok), [false, false, true]);
    assert.equal(f.errors(), "");
  } finally { await f.close(); }
});

test("子搜索误传文件可纠正；耗尽预算仍交接读取与定位，原生日志保留原因", async () => {
  let parentStep = 0, childStep = 0;
  const f = await runtimeFixture(request => {
    const body = request.body as { messages: { role: string; content?: string }[]; tools?: { function: { name: string } }[] };
    if (JSON.stringify(body).includes("orbitcode_child_role")) {
      assert.ok(body.tools?.some(tool => tool.function.name === "search_code"));
      if (++childStep > 1) assert.ok(body.messages.some(message => message.content?.includes(`第 ${childStep}/4 轮`)));
      if(childStep===4) { const suffix=body.messages.at(-1)?.content??"";assert.match(suffix,/当前子执行事实/);assert.match(suffix,/a\.txt/);assert.match(suffix,/"readFileCount":1/); }
      if (childStep === 1) return call("search_code", { path: "a.txt", query: "proof" }, "wrong-target");
      if (childStep === 2) return call("search_code", { file_pattern: "a.txt", query: "proof" }, "correct-target");
      return call("read_file", { path: "a.txt" }, `read-${childStep}`);
    }
    if (++parentStep === 1) return call("agent", { operation: "start", task: { kind: "defined", role: "limited", prompt: "探索a.txt", background: true } }, "start");
    if (parentStep === 2) {
      const value = body.messages.filter(message => message.role === "tool").map(message => JSON.parse(message.content ?? "{}")).find(value => value.output?.taskId);
      return call("agent", { operation: "wait", taskId: value.output.taskId, timeoutMs: 3000 }, "wait");
    }
    return say("根据交接事实报告未完成，不补做读取。");
  }, { terminal: true });
  try {
    await f.runtime.memory.setEnabled(false);
    await mkdir(path.join(f.root, ".orbitcode/agents"), { recursive: true });
    await writeFile(path.join(f.root, ".orbitcode/agents/limited.md"), (await readFile("agents/explorer.md", "utf8")).replace("name: explorer", "name: limited").replace("max-iterations: 16", "max-iterations: 4"));
    await writeFile(path.join(f.root, "a.txt"), "proof actual-content-not-for-handoff");
    await f.controller.handleLine("委派探索");
    const cp = await f.checkpoint(), scope = await f.runtime.taskScope(cp.summary.id), task = f.runtime.tasks.list(scope)[0];
    if (task.state.status !== "terminal") throw new Error("未结束");
    const result = task.state.result;
    assert.equal(childStep, 4);
    assert.equal(result.stopReason, "max-iterations");
    assert.equal(result.finalReply, "");
    assert.equal(result.failures[0].targetFailureReason, "not-directory");
    assert.equal(result.failures[0].callId, "wrong-target");
    assert.equal(result.failures[0].iteration, 1);
    assert.equal(result.failures.at(-1)?.kind, "cancelled");
    assert.deepEqual(result.handoff?.reads?.files, [{ path: "a.txt", callId: "read-3", sha256:createHash("sha256").update("proof actual-content-not-for-handoff").digest("hex"),byteLength:36 }]);
    assert.deepEqual(result.handoff?.reads?.matches, [{ path: "a.txt", line: 1, callId: "correct-target" }]);
    const logs = await f.log.findAllForConversation(task.id);
    assert.equal(logs[0].tools[0].targetFailureReason, "not-directory");
    assert.equal(logs[0].tools[0].iteration, 1);
    const delivery = cp.context.messages.find(message => message.kind === "child-result");
    assert.ok(delivery && "content" in delivery);
    assert.match(delivery.content, /correct-target/);
    assert.doesNotMatch(delivery.content, /actual-content-not-for-handoff/);
  } finally { await f.close(); }
});
