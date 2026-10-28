import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isAlias, parseDocument, visit } from "yaml";

import { LocalSettingsStore } from "@/lib/local-settings-store";
import type { Environment } from "@/lib/environment";
import { loadProviderConfigs } from "@/models/config";
import { parseMcpServerConfig, type McpServerConfig } from "@/runtime/mcp-config";
import { SettingsError, type ManagedMcpServer, type ManagedSettings } from "@/runtime/settings-types";
import { loadWorkspaceCatalog } from "@/runtime/workspace-config";

const previews = new Map<string, { fingerprint: string; cwd: string; userHome: string; expiresAt: number }>();

export async function previewLegacySettings(options: { cwd: string; userHome?: string; environment: Environment }): Promise<{
  previewId: string; providers: readonly string[]; workspaces: readonly string[]; mcpServers: readonly string[]; missingCredentials: readonly string[];
}> {
  const userHome = options.userHome ?? homedir();
  const { settings, fingerprint } = await readLegacy({ ...options, userHome });
  for (const [id, preview] of previews) if (preview.expiresAt <= Date.now()) previews.delete(id);
  if (previews.size >= 32) throw new SettingsError("unavailable", "导入预览数量已达上限，请稍后重试。");
  const previewId = randomUUID();
  previews.set(previewId, { fingerprint, cwd: options.cwd, userHome, expiresAt: Date.now() + 10 * 60_000 });
  return { previewId, providers: settings.providers.map((item) => item.displayName),
    workspaces: settings.workspaces.map((item) => item.name),
    mcpServers: settings.mcpServers.map((item) => `${item.scope}:${item.name}`),
    missingCredentials: [
      ...settings.providers.filter((item) => item.credential.kind === "environment" && !options.environment[item.credential.variable]).map((item) => item.displayName),
      ...settings.mcpServers.filter((server) => Object.values(server.config.type === "http" ? server.config.headers : server.config.env)
        .some((value) => [...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].some((match) => options.environment[match[1]] === undefined)))
        .map((server) => `MCP ${server.scope}:${server.name}`),
    ] };
}

export async function commitLegacySettings(options: {
  previewId: string; expectedRevision: number; cwd: string; userHome?: string; environment: Environment; store: LocalSettingsStore;
}): Promise<ManagedSettings> {
  const preview = previews.get(options.previewId);
  previews.delete(options.previewId);
  if (!preview || preview.expiresAt < Date.now() || preview.cwd !== options.cwd || preview.userHome !== (options.userHome ?? homedir())) throw new SettingsError("conflict", "导入预览已过期，请重新预览。");
  const { settings, fingerprint } = await readLegacy({ cwd: options.cwd, userHome: preview.userHome, environment: options.environment });
  if (fingerprint !== preview.fingerprint) throw new SettingsError("conflict", "原配置文件已变化，请重新预览。");
  const current = await options.store.load();
  if (current && (current.providers.length || current.workspaces.length || current.mcpServers.length)) throw new SettingsError("conflict", "托管配置已存在；请逐项处理冲突后再导入。");
  return options.store.save(options.expectedRevision, settings);
}

async function readLegacy(options: { cwd: string; userHome: string; environment: Environment }): Promise<{ settings: ManagedSettings; fingerprint: string }> {
  const hash = createHash("sha256");
  const modelPath = path.join(options.cwd, "orbitcode.yaml");
  const modelSource = await readSource(modelPath);
  if (!modelSource) throw new SettingsError("unavailable", "未找到旧模型配置文件。");
  hash.update(modelPath).update(modelSource);
  const models = await loadProviderConfigs({ filePath: modelPath, readTextFile: async () => modelSource });
  if (models.some((provider) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(provider.name)))
    throw new SettingsError("invalid", "旧模型名称不符合托管配置 ID 规则，请先调整旧配置并重新预览。");
  const workspacePath = path.join(options.cwd, "orbitcode.workspaces.yaml");
  const workspaceSource = await readSource(workspacePath);
  hash.update(workspacePath).update(workspaceSource ?? "missing");
  const catalog = await loadWorkspaceCatalog({ cwd: options.cwd, preferLegacy: true, readTextFile: async () => {
    if (workspaceSource === null) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return workspaceSource;
  } });
  const userPath = path.join(options.userHome, ".orbitcode", "mcp.yaml");
  const userSource = await readSource(userPath);
  hash.update(userPath).update(userSource ?? "missing");
  const userServers = parseMcpLayer(userSource);
  const mcpServers: ManagedMcpServer[] = [];
  for (const [name, config] of Object.entries(userServers)) mcpServers.push({ name, scope: "user", enabled: true, config });
  for (const workspace of catalog.entries) {
    const projectPath = path.join(workspace.rootPath, ".orbitcode", "mcp.yaml");
    const projectSource = await readSource(projectPath);
    hash.update(projectPath).update(projectSource ?? "missing");
    const projectServers = parseMcpLayer(projectSource);
    for (const [name, config] of Object.entries(projectServers)) mcpServers.push({ name, scope: "workspace", workspaceId: workspace.id, enabled: true, config });
  }
  const settings: ManagedSettings = { schemaVersion: 1, revision: 0,
    providers: models.map((provider) => ({ id: provider.name, displayName: provider.name, model: provider.model,
      baseUrl: provider.baseUrl, credential: { kind: "environment", variable: provider.apiKeyEnvironmentVariable },
      context: provider.context, ...(provider.thinking ? { thinking: provider.thinking } : {}),
      ...(provider.reasoningEffort === undefined ? {} : { reasoningEffort: provider.reasoningEffort }),
      ...(provider.maxOutputTokens === undefined ? {} : { maxOutputTokens: provider.maxOutputTokens }),
      ...(provider.transport ? { transport: provider.transport } : {}), enabled: true })),
    workspaces: catalog.entries.map((workspace) => ({ ...workspace, enabled: true })),
    mcpServers,
    defaultProviderId: models.length === 1 ? models[0].name : undefined,
    defaultWorkspaceId: catalog.defaultWorkspaceId,
  };
  return { settings, fingerprint: hash.digest("hex") };
}
async function readSource(file: string): Promise<string | null> {
  try {
    const source = await readFile(file, "utf8");
    if (Buffer.byteLength(source) > 256 * 1024) throw new SettingsError("invalid", "旧配置文件超过大小上限。");
    return source;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    if (error instanceof SettingsError) throw error;
    throw new SettingsError("storage", "无法读取旧配置文件。", error);
  }
}
function parseMcpLayer(source: string | null): Record<string, McpServerConfig> {
  if (!source) return {};
  let value: unknown;
  try {
    const doc = parseDocument(source, { uniqueKeys: true, prettyErrors: false });
    if (doc.errors.length) throw new Error("yaml");
    visit(doc, (_key, node) => { if (isAlias(node)) throw new Error("alias"); });
    value = doc.toJS({ maxAliasCount: 0 });
  } catch { throw new SettingsError("invalid", "旧 MCP 配置无法安全解析。"); }
  if (!record(value) || Object.keys(value).some((key) => key !== "mcpServers") || !record(value.mcpServers)) throw new SettingsError("invalid", "旧 MCP 配置结构无效。");
  const result: Record<string, McpServerConfig> = {};
  for (const [name, raw] of Object.entries(value.mcpServers)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || !record(raw)) throw new SettingsError("invalid", "旧 MCP Server 配置无效。");
    try { result[name] = parseMcpServerConfig(raw); }
    catch { throw new SettingsError("invalid", "旧 MCP Server 配置无效。"); }
  }
  return result;
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
