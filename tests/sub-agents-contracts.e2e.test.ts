import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runtimeFixture } from "./helpers/runtime-fixture";
import { call, say } from "./helpers/skill-fixture";
import { LocalAgentRunExporter } from "@/lib/local-agent-run-exporter";

test("仅委派契约在真实 Runtime 拒绝父读写，子仍能读取；用户切回协作后可接管", async () => {
  let parents = 0, children = 0, taskId = "";
  const f = await runtimeFixture(request => {
    const body = request.body as { tools?: { function: { name: string } }[]; messages?: { role: string; content?: string }[] };
    if (JSON.stringify(body).includes("orbitcode_child_role")) {
      assert.ok(body.tools?.some(tool => tool.function.name === "read_file"));
      assert.ok(!body.tools?.some(tool => tool.function.name === "agent"));
      return ++children === 1 ? call("read_file", { path: "evidence.txt" }, "child-read") : say("子实际读取了 evidence.txt");
    }
    parents++;
    if (parents <= 4) assert.deepEqual(body.tools?.map(tool => tool.function.name), ["agent"]);
    if (parents === 1) return call("write_file", { path: "forbidden.txt", content: "不能写入" }, "parent-violates");
    if (parents === 2) return call("agent", { operation: "start", task: { kind: "defined", role: "explorer", prompt: "读取 evidence.txt", background: true } }, "delegate");
    if (parents === 3) {
      for (const message of body.messages ?? []) {
        if (message.role !== "tool" || !message.content) continue;
        const value = JSON.parse(message.content);
        if (value.output?.taskId) taskId = value.output.taskId;
      }
      assert.ok(taskId);
      return call("agent", { operation: "wait", taskId, timeoutMs: 3000 }, "wait");
    }
    if (parents === 5) return call("write_file", { path: "takeover.txt", content: "用户已切换协作" }, "authorized-parent");
    return say("已按当前契约完成");
  });
  try {
    await f.runtime.memory.setEnabled(false);

    await f.controller.handleLine("/delegation delegate-only");
    await writeFile(path.join(f.root, "evidence.txt"), "实际内容");
    await f.controller.handleLine("仅委派测试");
    assert.equal(f.errors(), "");
    const cp = await f.checkpoint();
    assert.deepEqual(cp.lastTurn?.parentExecution, { version: 1, mode: "delegate-only" });
    await assert.rejects(readFile(path.join(f.root, "forbidden.txt")));
    const task = f.runtime.tasks.get(await f.runtime.taskScope(cp.summary.id), taskId);
    assert.ok(task.state.status === "terminal" && task.state.result.handoff?.reads?.files.some(file => file.path === "evidence.txt"));
    assert.ok(cp.context.messages.some(message => message.kind === "tool-result" && JSON.stringify(message).includes("permission-denied")));
    await f.controller.handleLine("/delegation collaborate");
    await f.controller.handleLine("现在允许父级接管，写 takeover.txt");
    assert.equal(await readFile(path.join(f.root, "takeover.txt"), "utf8"), "用户已切换协作");
  } finally { await f.close(); }
});

test("子长回复摘要截断后，正文可分页读取和跨实例导出；清空使旧正文失效", async () => {
  let parents = 0;
  const fullReply = "中文😀".repeat(2000) + "IMPORTANT_TAIL";
  const f = await runtimeFixture(request => JSON.stringify(request.body).includes("orbitcode_child_role") ? say(fullReply) : ++parents === 1 ? call("agent", { operation: "start", task: { kind: "defined", role: "explorer", prompt: "返回长回复", background: true } }, "start") : say("父结束"));
  try {
    await f.runtime.memory.setEnabled(false);
    f.conversations.configureTasks(cp => f.runtime.invalidateTasks(cp));
    await f.controller.handleLine("长交付测试");
    const cp = await f.checkpoint(), scope = await f.runtime.taskScope(cp.summary.id), task = f.runtime.tasks.list(scope)[0];
    const done = await f.runtime.tasks.wait(scope, task.id, 3000, new AbortController().signal);
    assert.equal(done.task.state.status, "terminal");
    if (done.task.state.status !== "terminal") return;
    assert.equal(done.task.state.result.replyTruncated, true);
    assert.equal(done.task.state.result.replyStorage?.status, "saved");
    let text = "", offset = 0;
    for (;;) { const chunk = await f.runtime.readTaskReply(cp.summary.id, task.id, offset, 999); text += chunk.content; if (chunk.nextOffset === null) break; offset = chunk.nextOffset; }
    assert.equal(text, fullReply);
    const exporter = new LocalAgentRunExporter(f.log, f.store);
    const exported = await exporter.createRunExport({ runId: task.id });
    assert.deepEqual(exported.childReply, { status: "included", content: fullReply });
    assert.equal(JSON.parse(exported.childToolFacts??"{}").commandCalls.count,0);
    assert.deepEqual((await exporter.createRunExport({ runId: task.id, includeContext: false })).childReply, { status: "omitted" });
    await f.conversations.clear({ conversationId: cp.summary.id, expectedRevision: (await f.checkpoint()).summary.revision });
    await assert.rejects(f.runtime.readTaskReply(cp.summary.id, task.id));
  } finally { await f.close(); }
});

test("CLI契约拒绝错误类型后可恢复创建Fork，完整历史与全文检索在子Runtime内生效", async () => {
  let parents = 0, children = 0, taskId = "", parentReference = "";
  const marker = "HIDDEN_😀_PROOF", bodyText = "字".repeat(40000) + marker + "尾".repeat(40000);
  const f = await runtimeFixture(request => {
    const body = request.body as { tools?: { function: { name: string; parameters: unknown } }[]; messages?: { role: string; content?: string }[] };
    if (JSON.stringify(body).includes("orbitcode_child_role")) {
      children++;
      if (children === 1) {
        const reference = JSON.stringify(body.messages).match(/context:\/\/v1\/[a-f0-9-]{36}/)?.[0];
        assert.ok(reference);
        assert.notEqual(reference, parentReference);
        return call("read_context", { reference: parentReference, query: "HIDDEN_", offset: 0, limit: 1000 }, "child-search");
      }
      assert.ok(JSON.stringify(body).includes(marker));
      assert.ok(JSON.stringify(body).includes('\\"complete\\":true'));
      return say(marker);
    }
    parents++;
    if (parents === 1) return call("agent", { operation: "start", task: { kind: "defined", role: "explorer", prompt: "错误类型", background: true } }, "wrong-kind");
    if (parents === 2) {
      assert.ok(JSON.stringify(body.messages).includes("本轮只允许 fork"));
      return call("agent", { operation: "start", task: { kind: "fork", prompt: "全文检索 HIDDEN_ 前缀", background: true } }, "right-kind");
    }
    if (parents === 3) {
      for (const message of body.messages ?? []) if (message.role === "tool" && message.content) taskId = JSON.parse(message.content).output?.taskId ?? taskId;
      assert.ok(taskId);
      return call("agent", { operation: "wait", taskId, timeoutMs: 3000 }, "wait-fork");
    }
    return say("已汇总");
  });
  try {
    await f.runtime.memory.setEnabled(false);
    const cp = await f.checkpoint(), signal = new AbortController().signal;
    const stored = await f.store.write({ sessionId: cp.summary.id, content: bodyText, signal });
    parentReference = stored.reference;
    const messages = [{ kind: "assistant-tool-call" as const, content: "", toolCalls: [{ id: "seed-tool", name: "read_file", argumentsJson: '{"path":"large.txt"}' }] },
      { kind: "tool-result" as const, toolCallId: "seed-tool", payload: { storage: "offloaded" as const, reference: stored.reference, originalBytes: Buffer.byteLength(bodyText), estimatedTokens: 40000, preview: "正文已卸载" } }];
    await f.store.save({ conversationId: cp.summary.id, expectedRevision: cp.summary.revision, checkpoint: { ...cp, context: { messages, consecutiveSummaryFailures: 0 } } });
    await f.controller.handleLine(`/resume ${cp.summary.id}`);
    await f.controller.handleLine("/delegation delegate-only fork");
    await f.controller.handleLine("实际委派并搜索");
    assert.equal(f.errors(), "");
    const saved = await f.checkpoint(), tasks = f.runtime.tasks.list(await f.runtime.taskScope(saved.summary.id));
    assert.equal(tasks.length, 1); assert.equal(tasks[0].kind, "fork");
    assert.deepEqual(saved.lastTurn?.parentExecution, { version: 1, mode: "delegate-only", delegationKind: "fork" });
    assert.ok(tasks[0].state.status === "terminal" && tasks[0].state.result.finalReply === marker);
    const query = { sessionId: cp.summary.id, reference: stored.reference, query: marker, signal };
    assert.equal((await f.store.search(query)).matchCount, 1);
    await assert.rejects(f.store.search({ ...query, sessionId: "another-conversation" }));
    await f.store.deleteReference(query);
    await assert.rejects(f.store.search(query));
  } finally { await f.close(); }
});
