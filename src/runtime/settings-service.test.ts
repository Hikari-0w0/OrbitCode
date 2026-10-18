import assert from "node:assert/strict";
import { access, chmod, mkdtemp, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalSettingsStore } from "@/lib/local-settings-store";
import { loadProviderContext, resolveRuntimeProvider, summarizeProviders } from "@/runtime/config";
import { SettingsService } from "@/runtime/settings-service";
import { loadWorkspaceCatalog, resolveWorkspaceBoundary } from "@/runtime/workspace-config";

test("模型改名保留身份和凭据，替换/停用/默认/清除不误用旧密钥", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-settings-life-"));
  try {
    const store = new LocalSettingsStore(root);
    const service = new SettingsService(store);
    const first = await service.apply(0, { type: "provider-add", displayName: "旧名", model: "model", baseUrl: "https://example.invalid/v1", windowTokens: 128000, credential: { kind: "local", value: "synthetic-old-key" } });
    const id = first.providers[0].id;
    await service.apply(1, { type: "provider-edit", id, displayName: "新名" });
    assert.equal(resolveRuntimeProvider(await loadProviderContext(root, {}, undefined, false, store, false), id).apiKey, "synthetic-old-key");
    const second = await service.apply(2, { type: "provider-add", displayName: "环境模型", model: "model-2", baseUrl: "https://example.invalid/v1", windowTokens: 128000, credential: { kind: "environment", variable: "SELECTED_KEY" } });
    const other = second.providers[1].id;
    await service.apply(3, { type: "provider-default", id: other });
    assert.equal((await service.view()).defaultProviderId, other);
    assert.throws(() => resolveRuntimeProvider({ providers: [], environment: {}, maxIterations: 12, maxRuntimeMs: 1000 }, other));
    const configured = await loadProviderContext(root, { SELECTED_KEY: "synthetic-env-key" }, undefined, false, store, false);
    assert.equal(resolveRuntimeProvider(configured, other).apiKey, "synthetic-env-key");
    assert.equal(summarizeProviders(configured)[0].name, other);
    assert.equal(configured.providers[0].name, id);
    await service.apply(4, { type: "provider-edit", id, credential: { kind: "local", value: "synthetic-replacement-key" } });
    assert.doesNotMatch(await readFile(store.filePath, "utf8"), /synthetic-old-key/);
    await service.apply(5, { type: "provider-enable", id: other, enabled: false });
    assert.equal((await service.view()).defaultProviderId, id);
    await service.apply(6, { type: "provider-edit", id, credential: { kind: "none" } });
    const final = await service.view();
    assert.equal(final.defaultProviderId, undefined);
    assert.equal(final.providers[0].enabled, false);
    assert.doesNotMatch(JSON.stringify(final), /synthetic-(old|env|replacement)-key/);
    assert.doesNotMatch(await readFile(store.filePath, "utf8"), /synthetic-replacement-key/);
    await assert.rejects(service.apply(7, { type: "provider-default", id }));
    assert.equal((await store.load())?.revision, 7);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("工作区改名保持绑定，停用和移除禁止新调用但不删除目录", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-workspace-life-"));
  try {
    const store = new LocalSettingsStore(path.join(root, "data"));
    const service = new SettingsService(store);
    await assert.rejects(service.apply(0, { type: "workspace-add", name: "不存在", rootPath: path.join(root, "missing") }));
    await writeFile(path.join(root, "file.txt"), "original");
    await assert.rejects(service.apply(0, { type: "workspace-add", name: "普通文件", rootPath: path.join(root, "file.txt") }));
    const view = await service.apply(0, { type: "workspace-add", name: "旧名", rootPath: root });
    const id = view.workspaces[0].id;
    await service.apply(1, { type: "workspace-rename", id, name: "新名" });
    assert.equal((await resolveWorkspaceBoundary(await loadWorkspaceCatalog({ settingsStore: store }), id)).root, await realpath(root));
    await service.apply(2, { type: "workspace-enable", id, enabled: false });
    await assert.rejects(resolveWorkspaceBoundary(await loadWorkspaceCatalog({ settingsStore: store }), id));
    await service.apply(3, { type: "workspace-remove", id });
    assert.equal((await service.view()).workspaces.length, 0);
    await access(root);
    assert.equal(await readFile(path.join(root, "file.txt"), "utf8"), "original");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("事务写入目录不可写时保留旧文件及 revision", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-settings-unwritable-"));
  const store = new LocalSettingsStore(root);
  try {
    await store.save(0, { schemaVersion: 1, providers: [], workspaces: [], mcpServers: [] });
    const before = await readFile(store.filePath, "utf8");
    await chmod(root, 0o500);
    await assert.rejects(store.save(1, { schemaVersion: 1, providers: [], workspaces: [], mcpServers: [], maxIterations: 4 }));
    assert.equal(await readFile(store.filePath, "utf8"), before);
    assert.equal((await store.load())?.revision, 1);
  } finally { await chmod(root, 0o700); await rm(root, { recursive: true, force: true }); }
});

test("高级模型设置支持创建、保留、清除及窗口约束，运行快照保留参数", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-provider-advanced-"));
  try {
    const store = new LocalSettingsStore(root), service = new SettingsService(store);
    const created = await service.apply(0, { type: "provider-add", displayName: "高级模型", model: "model", baseUrl: "https://example.invalid/v1", windowTokens: 128000,
      credential: { kind: "local", value: "synthetic-test-key" }, maxOutputTokens: 32768, thinking: { enabled: false, apiStyle: "deepseek" } });
    const id = created.providers[0].id;
    await service.apply(1, { type: "provider-edit", id, displayName: "改名" });
    const provider = resolveRuntimeProvider(await loadProviderContext(root, {}, undefined, false, store, false), id);
    assert.equal(provider.maxOutputTokens, 32768);
    assert.deepEqual(provider.thinking, { enabled: false, apiStyle: "deepseek" });
    await assert.rejects(service.apply(2, { type: "provider-edit", id, windowTokens: 16000 }));
    await assert.rejects(service.apply(2, { type: "provider-edit", id, maxOutputTokens: 1.5 }));
    await assert.rejects(service.apply(2, { type: "provider-edit", id, thinking: { enabled: true, apiStyle: "deepseek", budgetTokens: 1000 } }));
    assert.equal((await store.load())?.revision, 2);
    const cleared = await service.apply(2, { type: "provider-edit", id, maxOutputTokens: null, thinking: null });
    assert.equal(cleared.providers[0].maxOutputTokens, undefined);
    assert.equal(cleared.providers[0].thinking, undefined);
    const enabled = await service.apply(3, { type: "provider-edit", id, thinking: { enabled: true, apiStyle: "siliconflow", budgetTokens: 1024 } });
    assert.equal(enabled.providers[0].thinking?.budgetTokens, 1024);
  } finally { await rm(root, { recursive: true, force: true }); }
});
