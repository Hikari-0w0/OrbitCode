import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runtimeFixture } from "./helpers/runtime-fixture";
import { call, say } from "./helpers/skill-fixture";

for (const target of ["parent", "child"] as const) test(`默认配置的${target}在非交互运行中直接写入并执行命令`, async () => {
  let parentCalls = 0, childCalls = 0;
  const f = await runtimeFixture(request => {
    const child = JSON.stringify(request.body).includes("orbitcode_child_role");
    if (target === "child" && !child) return ++parentCalls === 1
      ? call("agent", { operation: "start", task: { kind: "defined", role: "general", prompt: "创建文件并运行命令", background: true } }, "start")
      : say("父完成委派");
    const iteration = child ? ++childCalls : ++parentCalls;
    if (iteration === 1) return call("write_file", { path: "direct.txt", content: "DIRECT_EXECUTION" }, "write");
    if (iteration === 2) return call("run_command", { command: "node -e \"process.stdout.write('COMMAND_DONE')\"" }, "command");
    return say("完成");
  });
  try {
    await f.runtime.memory.setEnabled(false);
    await f.controller.handleLine("执行任务");
    if (target === "child") {
      const scope = await f.runtime.taskScope((await f.checkpoint()).summary.id), task = f.runtime.tasks.list(scope)[0];
      const completed = await f.runtime.tasks.wait(scope, task.id, 3000, new AbortController().signal);
      assert.equal(completed.task.state.status, "terminal");
      if (completed.task.state.status !== "terminal") assert.fail("子任务未完成");
      assert.equal(completed.task.state.result.failureCount, 0);
      assert.equal(completed.task.state.result.handoff?.commandCalls.succeeded, 1);
    }
    assert.equal(await readFile(path.join(f.root, "direct.txt"), "utf8"), "DIRECT_EXECUTION");
    const cp = await f.checkpoint(), runs = await f.log.findAllForConversation(cp.summary.id);
    assert.ok(runs.length > 0);
    assert.ok(runs.flatMap(run => run.tools).every(tool => !tool.authorization));
  } finally { await f.close(); }
});
