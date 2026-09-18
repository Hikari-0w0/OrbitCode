import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runtimeFixture, waitUntil } from "./helpers/runtime-fixture";
import { textDelta, toolCallDelta, TOOL_FINISH_EVENT, TRANSPORT_DONE_EVENT, DONE_EVENT } from "./helpers/openai-mock";

for (const choice of ["once", "session", "permanent", "deny"] as const) {
  test(`CLI 生成中处理审批 ${choice}，迟到答案无效`, async () => {
    let count = 0;
    const fixture = await runtimeFixture(() => ({ chunks: [{ data: ++count === 1
      ? toolCallDelta({ id: "write", name: "write_file", argumentsJson: '{"path":"approval.txt","content":"approved"}' }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT
      : textDelta("结束") + DONE_EVENT }] }), { terminal: true });
    try {
      const turn = fixture.controller.handleLine("写入文件");
      await waitUntil(() => /\/approve ([\w-]+) </.test(fixture.output()));
      const id = /\/approve ([\w-]+) </.exec(fixture.output())?.[1];
      assert.ok(id); assert.equal(fixture.controller.busy, true);
      await fixture.controller.handleLine(`/approve ${id} ${choice}`);
      await turn;
      if (choice === "deny") await assert.rejects(readFile(path.join(fixture.root, "approval.txt")));
      else assert.equal(await readFile(path.join(fixture.root, "approval.txt"), "utf8"), "approved");
      if (choice === "permanent") assert.match(await readFile(path.join(fixture.root, ".orbitcode/permissions.local.yaml"), "utf8"), /approval.txt/);
      await fixture.controller.handleLine(`/approve ${id} once`);
      assert.match(fixture.errors(), /授权请求不存在/);
    } finally { await fixture.close(); }
  });
}

test("非 TTY 审批拒绝，取消等待中的交互审批回收资源", async () => {
  for (const terminal of [false, true]) {
    let count = 0;
    const fixture = await runtimeFixture(() => ({ chunks: [{ data: ++count === 1
      ? toolCallDelta({ id: "ask", name: "write_file", argumentsJson: '{"path":"no.txt","content":"no"}' }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT
      : textDelta("结束") + DONE_EVENT }] }), { terminal });
    try {
      const turn = fixture.controller.handleLine("写入");
      if (terminal) { await waitUntil(() => fixture.output().includes("需要授权")); fixture.controller.cancel(); }
      await turn;
      await assert.rejects(readFile(path.join(fixture.root, "no.txt")));
      const c = await fixture.checkpoint();
      assert.deepEqual(await fixture.guard.inspect(c.summary.id), { status: "idle" });
      assert.match(fixture.output(), terminal ? /停止：cancelled/ : /非交互输入无法审批/);
    } finally { await fixture.close(); }
  }
});
