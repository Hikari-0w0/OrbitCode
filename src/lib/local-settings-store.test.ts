import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalSettingsStore } from "@/lib/local-settings-store";
import { EMPTY_SETTINGS, SettingsError } from "@/runtime/settings-types";
import { SettingsService } from "@/runtime/settings-service";

test("托管设置以私密权限保存，并阻止旧版本覆盖", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-settings-"));
  try {
    const store = new LocalSettingsStore(root);
    assert.equal(await store.load(), null);
    const first = await store.save(0, EMPTY_SETTINGS);
    assert.equal(first.revision, 1);
    assert.equal((await stat(store.filePath)).mode & 0o077, 0);
    await assert.rejects(store.save(0, EMPTY_SETTINGS), (error) => error instanceof SettingsError && error.code === "conflict");
    assert.equal((await store.load())?.revision, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("服务端投影隐藏本地密钥，并保留模型身份", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-settings-"));
  try {
    const service = new SettingsService(new LocalSettingsStore(root));
    const first = await service.apply(0, {
      type: "provider-add", displayName: "测试", model: "test-model", baseUrl: "https://example.invalid/v1",
      windowTokens: 128000, credential: { kind: "local", value: "synthetic-sensitive-marker" },
    });
    assert.equal(first.providers.length, 1);
    assert.doesNotMatch(JSON.stringify(first), /synthetic-sensitive-marker/);
    const id = first.providers[0].id;
    const second = await service.apply(1, { type: "provider-edit", id, displayName: "新名称" });
    assert.equal(second.providers[0].id, id);
    assert.equal(second.providers[0].displayName, "新名称");
    assert.match(await readFile(service.store.filePath, "utf8"), /synthetic-sensitive-marker/);
    const cleared = await service.apply(2, { type: "provider-edit", id, credential: { kind: "none" } });
    assert.equal(cleared.providers[0].enabled, false);
    assert.equal(cleared.providers[0].credential.configured, false);
    assert.doesNotMatch(await readFile(service.store.filePath, "utf8"), /synthetic-sensitive-marker/);
    await assert.rejects(service.apply(3, { type: "provider-enable", id, enabled: true }), SettingsError);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("损坏设置与符号链接均拒绝读取且不被自动改写", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-settings-"));
  try {
    const store = new LocalSettingsStore(root);
    await writeFile(store.filePath, "{invalid", { mode: 0o600 });
    await assert.rejects(store.load(), (error) => error instanceof SettingsError && error.code === "invalid");
    assert.equal(await readFile(store.filePath, "utf8"), "{invalid");
    await rm(store.filePath);
    const target = path.join(root, "target");
    await writeFile(target, JSON.stringify(EMPTY_SETTINGS), { mode: 0o600 });
    await symlink(target, store.filePath);
    await assert.rejects(store.load(), (error) => error instanceof SettingsError && error.code === "invalid");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("显式恢复先备份损坏文件，再建立空托管设置", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-settings-"));
  try {
    const store = new LocalSettingsStore(root);
    await writeFile(store.filePath, "{invalid", { mode: 0o600 });
    const backup = await store.recoverInvalid();
    assert.equal(await readFile(path.join(root, backup), "utf8"), "{invalid");
    assert.equal((await stat(path.join(root, backup))).mode & 0o077, 0);
    assert.equal((await store.load())?.revision, 1);
    assert.deepEqual((await store.load())?.providers, []);
    await assert.rejects(store.recoverInvalid(), (error) => error instanceof SettingsError && error.code === "conflict");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("移除工作区只移除记录与其 MCP 配置，不删除目录", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-settings-"));
  try {
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const service = new SettingsService(new LocalSettingsStore(path.join(root, "data")));
    const added = await service.apply(0, { type: "workspace-add", name: "项目", rootPath: workspace });
    const id = added.workspaces[0].id;
    await service.apply(1, { type: "mcp-upsert", name: "demo", scope: "workspace", workspaceId: id,
      config: { type: "http", url: "https://example.invalid/mcp", headers: {} } });
    const removed = await service.apply(2, { type: "workspace-remove", id });
    assert.equal(removed.workspaces.length, 0);
    assert.equal(removed.mcpServers.length, 0);
    assert.equal((await stat(workspace)).isDirectory(), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("运行偏好严格校验并以同一 revision 保存", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-settings-"));
  try {
    const service = new SettingsService(new LocalSettingsStore(root));
    const result = await service.apply(0, { type: "preferences-set", maxIterations: 12, maxRuntimeMinutes: 3,
      defaultPermissionMode: "strict" });
    assert.equal(result.revision, 1);
    assert.equal(result.maxIterations, 12);
    assert.equal(result.defaultPermissionMode, "strict");
    await assert.rejects(service.apply(1, { type: "preferences-set", maxIterations: 33, maxRuntimeMinutes: 3,
      defaultPermissionMode: "strict" }), SettingsError);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("临时文件写入中途失败不会覆盖旧完整配置，也不遗留半份提交", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-settings-partial-"));
  const store = new LocalSettingsStore(root);
  try {
    await store.save(0, EMPTY_SETTINGS);
    const previous = await readFile(store.filePath, "utf8");
    const originalOpen = fs.open;
    let injected = false;
    context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (typeof args[0] === "string" && path.basename(args[0]).startsWith(".settings-") && !path.basename(args[0]).startsWith(".settings-owner-")) {
        const write = handle.writeFile.bind(handle);
        context.mock.method(handle, "writeFile", async () => { injected = true; await write("{partial"); throw new Error("模拟临时写入失败"); });
      }
      return handle;
    });
    await assert.rejects(store.save(1, { ...EMPTY_SETTINGS, maxIterations: 3 }));
    assert.equal(injected, true);
    assert.equal(await readFile(store.filePath, "utf8"), previous);
    assert.equal((await store.load())?.revision, 1);
    assert.deepEqual(await fs.readdir(root), ["settings-v1.json"]);
  } finally { context.mock.restoreAll(); await rm(root, { recursive: true, force: true }); }
});
