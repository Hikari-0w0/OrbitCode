import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChildResultStore, CHILD_REPLY_MAX_BYTES } from "./child-result-store";

test("子正文跨实例分页保持中文与尾部，归属、世代、过期及覆盖均受限", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "child-results-"));
  const scope = { conversationId: "parent", lifecycleEpoch: "epoch" }, signal = new AbortController().signal;
  let now = Date.now();
  try {
    await mkdir(path.join(root, "parent")); await mkdir(path.join(root, "other"));
    const store = new ChildResultStore(root, () => now), reply = "中文😀".repeat(2000) + "TAIL_PROOF";
    const saved = await store.save(scope, "task", reply);
    assert.equal(saved.status, "saved");
    const restored = new ChildResultStore(root, () => now);
    let content = "", offset = 0;
    for (;;) { const chunk = await restored.read(scope, "task", offset, 997, signal); content += chunk.content; if (chunk.nextOffset === null) break; offset = chunk.nextOffset; }
    assert.equal(content, reply);
    assert.equal(await restored.exportReply("parent", "task"), reply);
    await assert.rejects(restored.read({ ...scope, conversationId: "other" }, "task", 0, 1000, signal));
    await assert.rejects(restored.read({ ...scope, lifecycleEpoch: "new" }, "task", 0, 1000, signal));
    await assert.rejects(restored.read(scope, "../task", 0, 1000, signal));
    await assert.rejects(restored.read(scope, "task", 0, 4001, signal));
    assert.equal((await store.save(scope, "task", "改写")).status, "unavailable");
    assert.equal((await store.save(scope, "huge", "x".repeat(CHILD_REPLY_MAX_BYTES + 1))).status, "unavailable");
    now += 31 * 24 * 60 * 60 * 1000;
    await assert.rejects(restored.read(scope, "task", 0, 1000, signal));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("子正文拒绝父目录和结果目录符号链接，不写出存储根", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "child-result-boundary-"));
  try {
    await mkdir(path.join(root, "outside")); await mkdir(path.join(root, "store"));
    await symlink(path.join(root, "outside"), path.join(root, "store", "parent"));
    const store = new ChildResultStore(path.join(root, "store")), scope = { conversationId: "parent", lifecycleEpoch: "epoch" };
    assert.equal((await store.save(scope, "task", "正文")).status, "unavailable");
    await rm(path.join(root, "store", "parent")); await mkdir(path.join(root, "store", "parent"));
    await symlink(path.join(root, "outside"), path.join(root, "store", "parent", "child-results"));
    assert.equal((await store.save(scope, "task", "正文")).status, "unavailable");
    await writeFile(path.join(root, "outside", "task.json"), "合成外部内容");
    await assert.rejects(store.read(scope, "task", 0, 1000, new AbortController().signal));
  } finally { await rm(root, { recursive: true, force: true }); }
});
