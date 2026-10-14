import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalSettingsStore } from "@/lib/local-settings-store";
import { loadProviderContext } from "@/runtime/config";
import { loadMcpConfig } from "@/runtime/mcp-config";
import { SettingsService } from "@/runtime/settings-service";
import { loadWorkspaceCatalog } from "@/runtime/workspace-config";

test("配置更新只影响新快照，已有轮次保持同版模型、工作区和 MCP", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-snapshot-"));
  try {
    const store = new LocalSettingsStore(path.join(root, "data"));
    const service = new SettingsService(store);
    await service.apply(0, { type: "provider-add", displayName: "初始", model: "model-a", baseUrl: "https://example.invalid/v1",
      windowTokens: 128000, credential: { kind: "local", value: "synthetic-key" } });
    const added = await service.apply(1, { type: "workspace-add", name: "原名称", rootPath: root });
    await service.apply(2, { type: "mcp-upsert", name: "demo", scope: "workspace", workspaceId: added.workspaces[0].id,
      config: { type: "http", url: "https://example.invalid/old", headers: {} } });
    const old = await loadProviderContext(root, {}, undefined, false, store, false);
    await service.apply(3, { type: "workspace-rename", id: added.workspaces[0].id, name: "新名称" });
    await service.apply(4, { type: "mcp-upsert", name: "demo", scope: "workspace", workspaceId: added.workspaces[0].id,
      config: { type: "http", url: "https://example.invalid/new", headers: {} } });
    const current = await loadProviderContext(root, {}, undefined, false, store, false);
    const oldWorkspace = await loadWorkspaceCatalog({ cwd: root, managedSettings: old.managedSettings ?? null });
    const newWorkspace = await loadWorkspaceCatalog({ cwd: root, managedSettings: current.managedSettings ?? null });
    assert.equal(oldWorkspace.entries[0].name, "原名称");
    assert.equal(newWorkspace.entries[0].name, "新名称");
    const oldMcp = await loadMcpConfig({ workspaceRoot: oldWorkspace.entries[0].rootPath, environment: {}, managedSettings: old.managedSettings ?? null });
    const newMcp = await loadMcpConfig({ workspaceRoot: newWorkspace.entries[0].rootPath, environment: {}, managedSettings: current.managedSettings ?? null });
    assert.equal(oldMcp.servers[0].config.type, "http");
    assert.equal(oldMcp.servers[0].config.type === "http" && oldMcp.servers[0].config.url, "https://example.invalid/old");
    assert.equal(newMcp.servers[0].config.type === "http" && newMcp.servers[0].config.url, "https://example.invalid/new");
    assert.equal(old.settingsRevision, 3);
    assert.equal(current.settingsRevision, 5);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("一个托管工作区失效时仍列出状态并允许使用其他工作区", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-workspaces-"));
  try {
    const unavailable = path.join(root, "removed");
    const available = path.join(root, "available");
    await mkdir(unavailable); await mkdir(available);
    const store = new LocalSettingsStore(path.join(root, "data"));
    const service = new SettingsService(store);
    await service.apply(0, { type: "workspace-add", name: "旧目录", rootPath: unavailable });
    await service.apply(1, { type: "workspace-add", name: "可用目录", rootPath: available });
    await rm(unavailable, { recursive: true });
    const catalog = await loadWorkspaceCatalog({ settingsStore: store });
    assert.equal(catalog.summaries[0].available, false);
    assert.equal(catalog.summaries[1].available, true);
    assert.equal(catalog.entries[1].rootPath, await realpath(available));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("显式旧配置来源不与托管配置混合，损坏托管配置不静默回退", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-config-source-"));
  const { writeFile } = await import("node:fs/promises");
  try {
    const store = new LocalSettingsStore(path.join(root, "data"));
    await new SettingsService(store).apply(0, { type: "provider-add", displayName: "托管", model: "managed-model", baseUrl: "https://example.invalid/v1", windowTokens: 128000, credential: { kind: "local", value: "synthetic-key" } });
    const file = path.join(root, "explicit.yaml");
    await writeFile(file, 'providers:\n  - name: legacy\n    protocol: openai\n    model: legacy-model\n    base_url: https://example.invalid/v1\n    api_key: LEGACY_KEY\n    context:\n      window_tokens: 128000\n');
    assert.equal((await loadProviderContext(root, {}, file, false, store, false)).providers[0].model, "managed-model");
    assert.equal((await loadProviderContext(root, {}, file, true, store, false)).providers[0].model, "legacy-model");
    await writeFile(store.filePath, "{invalid", { mode: 0o600 });
    await assert.rejects(loadProviderContext(root, {}, file, false, store, false));
  } finally { await rm(root, { recursive: true, force: true }); }
});
