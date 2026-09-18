import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixture } from "../../tests/helpers/runtime-fixture";
import { DONE_EVENT } from "../../tests/helpers/openai-mock";

test("共享服务所有写操作检查 revision，保存模式且拒绝并发修改", async () => {
  const fixture = await runtimeFixture(() => ({ chunks: [{ data: DONE_EVENT }] }));
  try {
    const c = await fixture.checkpoint();
    const mutation = { conversationId: c.summary.id, expectedRevision: c.summary.revision };
    const updated = await fixture.conversations.setMode({ ...mutation, mode: "plan" });
    assert.equal(updated.mode, "plan");
    await assert.rejects(fixture.conversations.rename({ ...mutation, title: "旧页面" }), /会话已更新/);
    const lease = await fixture.guard.begin(c.summary.id, "agent");
    try { await assert.rejects(fixture.conversations.clear({ ...mutation, expectedRevision: 1 }), /进行中的操作/); }
    finally { await lease.finish(); }
    assert.equal((await fixture.store.load(c.summary.id)).mode, "plan");
  } finally { await fixture.close(); }
});
