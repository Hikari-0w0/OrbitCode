import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalSettingsStore } from "@/lib/local-settings-store";
import { commitLegacySettings, previewLegacySettings } from "@/runtime/settings-import";
import { SettingsError } from "@/runtime/settings-types";
import { SettingsService } from "@/runtime/settings-service";
import { loadProviderContext } from "@/runtime/config";

const legacyModel = [
  "providers:",
  "  - name: primary",
  "    protocol: openai",
  "    model: example-model",
  "    base_url: https://example.invalid/v1",
  "    api_key: ORBITCODE_API_KEY",
  "    context:",
  "      window_tokens: 128000",
].join("\n");

test("旧配置预览不写入，确认后原文件保持原样并保留模型身份", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-import-"));
  const modelPath = path.join(root, "orbitcode.yaml");
  const store = new LocalSettingsStore(path.join(root, "data"));
  try {
    await writeFile(modelPath, legacyModel);
    const preview = await previewLegacySettings({ cwd: root, userHome: root, environment: {} });
    assert.deepEqual(preview.providers, ["primary"]);
    assert.deepEqual(preview.missingCredentials, ["primary"]);
    assert.equal(await store.load(), null);
    const saved = await commitLegacySettings({ previewId: preview.previewId, expectedRevision: 0,
      cwd: root, userHome: root, environment: {}, store });
    assert.equal(saved.revision, 1);
    assert.equal(saved.providers[0].id, "primary");
    assert.equal(saved.workspaces[0].rootPath, await realpath(root));
    assert.equal(await readFile(modelPath, "utf8"), legacyModel);
    await assert.rejects(commitLegacySettings({ previewId: preview.previewId, expectedRevision: 1,
      cwd: root, userHome: root, environment: {}, store }), (error) => error instanceof SettingsError && error.code === "conflict");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("输出预算在导入、保存、编辑和运行快照间保持一致", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-output-budget-"));
  const store = new LocalSettingsStore(path.join(root, "data"));
  try {
    await writeFile(path.join(root, "orbitcode.yaml"), legacyModel.replace("    context:", "    max_tokens: 32768\n    reasoning_effort: high\n    context:"));
    const preview = await previewLegacySettings({ cwd: root, userHome: root, environment: {} });
    const saved = await commitLegacySettings({ previewId: preview.previewId, expectedRevision: 0,
      cwd: root, userHome: root, environment: {}, store });
    assert.equal(saved.providers[0].maxOutputTokens, 32768);
    assert.equal(saved.providers[0].reasoningEffort, "high");
    await new SettingsService(store).apply(1, { type: "provider-edit", id: "primary", displayName: "新名称" });
    const snapshot = await loadProviderContext(root, {}, undefined, false, store, false);
    assert.equal(snapshot.providers[0].maxOutputTokens, 32768);
    assert.equal(snapshot.providers[0].reasoningEffort, "high");
    const settings = await store.load();
    assert.ok(settings);
    for (const maxOutputTokens of [0, 1.5, 1_048_577, 128001]) {
      await assert.rejects(store.save(2, { ...settings,
        providers: settings.providers.map((provider) => ({ ...provider, maxOutputTokens })),
      }), SettingsError);
    }
    assert.equal((await store.load())?.revision, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("旧 MCP 可省略可选参数，缺少环境凭据只报告并保留引用", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-import-"));
  try {
    await writeFile(path.join(root, "orbitcode.yaml"), legacyModel);
    await mkdir(path.join(root, ".orbitcode"));
    await writeFile(path.join(root, ".orbitcode/mcp.yaml"), 'mcpServers:\n  local:\n    type: stdio\n    command: node\n  remote:\n    type: http\n    url: https://example.invalid/mcp\n    headers:\n      Authorization: "Bearer ${MCP_TOKEN}"\n');
    const preview = await previewLegacySettings({ cwd: root, userHome: path.join(root, "home"), environment: {} });
    assert.ok(preview.missingCredentials.includes("MCP workspace:remote"));
    const settings = await commitLegacySettings({ previewId: preview.previewId, expectedRevision: 0, cwd: root,
      userHome: path.join(root, "home"), environment: {}, store: new LocalSettingsStore(path.join(root, "data")) });
    const local = settings.mcpServers.find((item) => item.name === "local");
    assert.deepEqual(local?.config, { type: "stdio", command: "node", args: [], env: {} });
    const remote = settings.mcpServers.find((item) => item.name === "remote");
    assert.equal(remote?.config.type === "http" && remote.config.headers.authorization, "Bearer ${MCP_TOKEN}");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("源文件在确认前变化时拒绝导入，不生成半份设置", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-import-"));
  const modelPath = path.join(root, "orbitcode.yaml");
  const store = new LocalSettingsStore(path.join(root, "data"));
  try {
    await writeFile(modelPath, legacyModel);
    const preview = await previewLegacySettings({ cwd: root, userHome: root, environment: {} });
    await writeFile(modelPath, legacyModel.replace("example-model", "changed-model"));
    await assert.rejects(commitLegacySettings({ previewId: preview.previewId, expectedRevision: 0,
      cwd: root, userHome: root, environment: {}, store }), (error) => error instanceof SettingsError && error.code === "conflict");
    assert.equal(await store.load(), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
