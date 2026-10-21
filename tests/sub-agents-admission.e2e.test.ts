import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runtimeFixture } from "./helpers/runtime-fixture";
import { call, say } from "./helpers/skill-fixture";

test("角色切换模型后，接纳契约、实际请求和子运行日志归属一致", async () => {
  let parents = 0, children = 0;
  const f = await runtimeFixture(request => {
    const body = request.body;
    if (typeof body === "object" && body !== null && "model" in body && JSON.stringify(body).includes("orbitcode_child_role")) {
      children++; assert.equal(body.model, "secondary-model"); return say("使用所选模型执行");
    }
    return ++parents === 1 ? call("agent", { operation: "start", task: { kind: "defined", role: "secondary", prompt: "返回执行结果", background: true } }, "delegate") : say("父完成");
  });
  try {
    await f.runtime.memory.setEnabled(false);
    const configuration = path.join(f.root, "orbitcode.yaml");
    await writeFile(configuration, (await readFile(configuration, "utf8")) + `\n  - name: secondary\n    protocol: openai\n    model: secondary-model\n    base_url: ${f.server.baseUrl}\n    api_key: FIXTURE_KEY\n    context:\n      window_tokens: 128000\n`);
    await mkdir(path.join(f.root, ".orbitcode/agents"), { recursive: true });
    await writeFile(path.join(f.root, ".orbitcode/agents/secondary.md"), "---\nname: secondary\ndescription: 指定模型\nallowed-tools: [read_file]\ndisallowed-tools: [agent]\nmodel: secondary\nmax-iterations: 2\npermission-mode: default\n---\n完成当前任务。");
    await f.controller.handleLine("验证模型归属"); assert.equal(f.errors(), "");
    const cp = await f.checkpoint(), scope = await f.runtime.taskScope(cp.summary.id), task = f.runtime.tasks.list(scope)[0];
    assert.ok(task); const done = await f.runtime.tasks.wait(scope, task.id, 3000, new AbortController().signal);
    assert.ok(done.task.state.status === "terminal" && done.task.state.result.stopReason === "final-response"); assert.equal(children, 1);
    assert.deepEqual(done.task.admission?.provider, { id: "secondary", model: "secondary-model" });
    const runs = await f.log.findAllForConversation(task.id); assert.equal(runs.length, 1);
    assert.equal(runs[0].providerId, "secondary"); assert.doesNotMatch(JSON.stringify(done.task), /synthetic-fixture-secret/);
  } finally { await f.close(); }
});
