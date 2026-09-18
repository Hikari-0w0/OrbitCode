import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture";
import { textDelta, DONE_EVENT } from "./helpers/openai-mock";
import { LocalConversationStore } from "@/lib/local-conversation-store";
import type { ConversationSaveInput } from "@/core/conversations/types";

test("会话重命名、继续、模式恢复、导出、清空和删除", async () => {
  const fixture = await runtimeFixture(() => ({ chunks: [{ data: textDelta("回答") + DONE_EVENT }] }), { terminal: true });
  try {
    await fixture.controller.handleLine("问题");
    const original = await fixture.checkpoint();
    await fixture.controller.handleLine("/rename 新标题");
    await fixture.controller.handleLine("/plan");
    await fixture.controller.handleLine("/new");
    await fixture.controller.handleLine(`/resume ${original.summary.id}`);
    assert.match(fixture.output(), /PLAN/);
    await fixture.controller.handleLine("/export conversation.json");
    const exported = JSON.parse(await readFile(path.join(fixture.root, "conversation.json"), "utf8"));
    assert.equal(exported.format, "orbitcode-conversation");
    assert.equal(exported.runs[0].source, "cli");
    await fixture.controller.handleLine("/clear");
    const token = [...fixture.output().matchAll(/\/confirm ([\w-]+) 确认/g)].at(-1)?.[1];
    assert.ok(token); await fixture.controller.handleLine(`/confirm ${token}`);
    const cleared = await fixture.store.load(original.summary.id);
    assert.equal(cleared.mode, "do"); assert.equal(cleared.displayMessages.length, 0);
    await fixture.controller.handleLine(`/delete ${original.summary.id}`);
    const deletion = [...fixture.output().matchAll(/\/confirm ([\w-]+) 确认/g)].at(-1)?.[1];
    assert.ok(deletion); await fixture.controller.handleLine(`/confirm ${deletion}`);
    await assert.rejects(fixture.store.load(original.summary.id));
    assert.equal(fixture.errors(), "");
  } finally { await fixture.close(); }
});

class FailingStore extends LocalConversationStore {
  fail = true;
  override async save(input: ConversationSaveInput) {
    if (this.fail) throw new Error("模拟磁盘不可写。");
    return super.save(input);
  }
}
test("保存失败后禁止新任务，重试保存不重放模型或工具", async () => {
  let store: FailingStore | undefined;
  const fixture = await runtimeFixture(() => ({ chunks: [{ data: textDelta("已经完成") + DONE_EVENT }] }), {
    storeFactory(root) { store = new FailingStore(root); return store; },
  });
  try {
    await fixture.controller.handleLine("问题");
    assert.match(fixture.errors(), /模拟磁盘不可写/);
    await fixture.controller.handleLine("不得发送");
    assert.equal(fixture.server.requests.length, 1);
    assert.ok(store); store.fail = false;
    await fixture.controller.handleLine("/retry-save");
    assert.equal(fixture.server.requests.length, 1);
    const c = await fixture.checkpoint();
    assert.equal(c.summary.revision, 1);
    assert.equal(c.displayMessages.length, 2);
    assert.deepEqual(await fixture.guard.inspect(c.summary.id), { status: "idle" });
  } finally { await fixture.close(); }
});

test("配置失效历史仍可读、导出，执行不能静默换绑", async () => {
  const fixture = await runtimeFixture(() => ({ chunks: [{ data: textDelta("保留历史") + DONE_EVENT }] }));
  try {
    await fixture.controller.handleLine("问题");
    const saved = await fixture.checkpoint();
    const { rename } = await import("node:fs/promises");
    await rename(path.join(fixture.root, "orbitcode.yaml"), path.join(fixture.root, "missing.yaml"));
    await fixture.controller.handleLine(`/resume ${saved.summary.id}`);
    await fixture.controller.handleLine("/history");
    await fixture.controller.handleLine("/export readonly.json");
    await fixture.controller.handleLine("不应执行");
    assert.equal(fixture.server.requests.length, 1);
    assert.match(fixture.output(), /历史可读/);
    assert.match(await readFile(path.join(fixture.root, "readonly.json"), "utf8"), /保留历史/);
    assert.match(fixture.errors(), /无法读取模型配置文件/);
  } finally { await fixture.close(); }
});

test("Provider 与 Workspace 切换新建 Do 会话，失败切换保留原绑定", async () => {
  const fixture = await runtimeFixture(() => ({ chunks: [{ data: textDelta("计划") + DONE_EVENT }] }));
  try {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const original = await fixture.checkpoint();
    const config = await readFile(path.join(fixture.root, "orbitcode.yaml"), "utf8");
    await writeFile(path.join(fixture.root, "orbitcode.yaml"), config + config.slice(config.indexOf("  - name:")).replace("name: primary", "name: secondary"));
    await fixture.controller.handleLine("/plan");
    await fixture.controller.handleLine("/provider secondary");
    const changed = await fixture.checkpoint();
    assert.notEqual(changed.summary.id, original.summary.id);
    assert.equal(changed.summary.providerId, "secondary"); assert.equal(changed.mode, "do");
    await fixture.controller.handleLine("/provider nonexistent");
    assert.equal((await fixture.checkpoint()).summary.id, changed.summary.id);
    const otherRoot = path.join(fixture.root, "other"); await mkdir(otherRoot);
    await writeFile(path.join(fixture.root, "orbitcode.workspaces.yaml"), `default: default\nworkspaces:\n  - id: default\n    name: first\n    path: ${fixture.root}\n  - id: other\n    name: other\n    path: ${otherRoot}\n`);
    await fixture.controller.handleLine("/workspace other");
    const workspace = await fixture.checkpoint();
    assert.equal(workspace.summary.workspaceId, "other"); assert.equal(workspace.mode, "do");
    await fixture.controller.handleLine(`/resume ${original.summary.id}`);
    await fixture.controller.handleLine("/history");
    assert.match(fixture.errors(), /找不到模型配置/);
  } finally { await fixture.close(); }
});
