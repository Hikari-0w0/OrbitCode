import { parseKnowledgeConfig } from "@/runtime/knowledge/config";
import { isToolFailurePolicy } from "@/core/tool-failure-policy";
import { parseCommandSecurity } from "@/tools/command-security";
import { parseSubAgentLimits } from "@/core/sub-agents/types";
import { randomUUID } from "node:crypto";
import { open, mkdir, rename, rm, lstat, chmod, link } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { EMPTY_SETTINGS, SettingsError, type ManagedSettings } from "@/runtime/settings-types";
import { acquireSettingsLock } from "@/lib/settings-lock";
import { MAX_MODEL_OUTPUT_TOKENS } from "@/models/provider";

import { isReasoningEffort } from "@/models/reasoning-effort";

const MAX_BYTES = 256 * 1024;

export class LocalSettingsStore {
  constructor(readonly directory = path.join(homedir(), ".orbitcode")) {}

  get filePath(): string { return path.join(this.directory, "settings-v1.json"); }

  async load(): Promise<ManagedSettings | null> {
    let source: string;
    try {
      const file = await open(this.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > MAX_BYTES || (info.mode & 0o077) !== 0) {
          throw new SettingsError("invalid", "设置文件类型、权限或大小无效。");
        }
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_BYTES) throw new SettingsError("invalid", "设置文件超过大小上限。");
        source = buffer.subarray(0, bytesRead).toString("utf8");
      } finally { await file.close(); }
    } catch (error) {
      if (isMissing(error)) return null;
      if (hasCode(error, "ELOOP")) throw new SettingsError("invalid", "设置文件不能是符号链接。");
      if (error instanceof SettingsError) throw error;
      throw new SettingsError("storage", "无法读取本地设置。", error);
    }
    try { return validateSettings(JSON.parse(source) as unknown); }
    catch (error) {
      if (error instanceof SettingsError) throw error;
      throw new SettingsError("invalid", "本地设置文件无效，未覆盖原文件。", error);
    }
  }

  async save(expectedRevision: number, next: Omit<ManagedSettings, "revision">): Promise<ManagedSettings> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(this.directory);
    if (!directoryInfo.isDirectory() || (directoryInfo.mode & 0o077) !== 0) throw new SettingsError("invalid", "设置目录类型或权限无效。");
    const release = await acquireSettingsLock(this.directory);
    const temporary = path.join(this.directory, `.settings-${randomUUID()}.tmp`);
    try {
      const current = await this.load();
      if ((current?.revision ?? 0) !== expectedRevision) throw new SettingsError("conflict", "设置已更新，请刷新后重试。");
      const value = validateSettings({ ...next, revision: expectedRevision + 1 });
      const data = JSON.stringify(value, null, 2);
      if (Buffer.byteLength(data) > MAX_BYTES) throw new SettingsError("invalid", "设置文件超过大小上限。");
      const output = await open(temporary, "wx", 0o600);
      try { await output.writeFile(data); await output.sync(); }
      finally { await output.close(); }
      await rename(temporary, this.filePath);
      const parent = await open(this.directory, "r");
      try { await parent.sync(); }
      finally { await parent.close(); }
      return value;
    } catch (error) {
      if (error instanceof SettingsError) throw error;
      throw new SettingsError("storage", "无法保存本地设置。", error);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
      await release();
    }
  }

  async recoverInvalid(): Promise<string> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(this.directory);
    if (!directoryInfo.isDirectory() || (directoryInfo.mode & 0o077) !== 0) throw new SettingsError("invalid", "设置目录类型或权限无效。");
    const release = await acquireSettingsLock(this.directory);
    const backup = path.join(this.directory, `settings-v1.invalid-${randomUUID()}.json`);
    const temporary = path.join(this.directory, `.settings-${randomUUID()}.tmp`);
    let backupCreated = false;
    try {
      const info = await lstat(this.filePath);
      if (!info.isFile()) throw new SettingsError("invalid", "仅普通设置文件可由界面备份恢复。");
      let invalid = false;
      try { await this.load(); }
      catch (error) {
        if (!(error instanceof SettingsError) || error.code !== "invalid") throw error;
        invalid = true;
      }
      if (!invalid) throw new SettingsError("conflict", "设置已恢复有效，无需重置。");
      const replacement = validateSettings({ ...EMPTY_SETTINGS, revision: 1 });
      const output = await open(temporary, "wx", 0o600);
      try { await output.writeFile(JSON.stringify(replacement, null, 2)); await output.sync(); }
      finally { await output.close(); }
      await link(this.filePath, backup);
      const backupInfo = await lstat(backup);
      if (!backupInfo.isFile() || backupInfo.ino !== info.ino || backupInfo.dev !== info.dev)
        throw new SettingsError("conflict", "设置文件已被外部替换，请重新读取后恢复。");
      backupCreated = true;
      await chmod(backup, 0o600);
      const parent = await open(this.directory, "r");
      try { await parent.sync(); await rename(temporary, this.filePath); await parent.sync(); }
      finally { await parent.close(); }
      return path.basename(backup);
    } catch (error) {
      if (!backupCreated) await rm(backup, { force: true }).catch(() => undefined);
      if (error instanceof SettingsError) throw error;
      throw new SettingsError("storage", "无法备份并恢复损坏设置。", error);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
      await release();
    }
  }
}

function validateSettings(value: unknown): ManagedSettings {
  if (!record(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) throw invalid();
  if (Object.keys(value).some((key) => !["schemaVersion", "revision", "providers", "workspaces", "mcpServers", "defaultProviderId", "defaultWorkspaceId", "maxIterations", "maxRuntimeMinutes", "defaultPermissionMode", "subAgents", "commandSecurity", "toolFailurePolicy"].includes(key))) throw invalid();
  if (value.commandSecurity !== undefined) { try { value.commandSecurity = parseCommandSecurity(value.commandSecurity); } catch { throw invalid(); } }
  if (!Array.isArray(value.providers) || !Array.isArray(value.workspaces) || !Array.isArray(value.mcpServers)) throw invalid();
  if (value.providers.length > 32 || value.workspaces.length > 32 || value.mcpServers.length > 32) throw invalid();
  const providerIds = new Set<string>();
  for (const provider of value.providers) {
    if (!record(provider) || !identifier(provider.id) || !shortText(provider.displayName, 80) || !shortText(provider.model, 256) || !httpUrl(provider.baseUrl) || typeof provider.enabled !== "boolean" || !record(provider.context)) throw invalid();
    const providerUrl = new URL(provider.baseUrl);
    if (providerUrl.username || providerUrl.password || providerUrl.search || providerUrl.hash) throw invalid();
    if (Object.keys(provider).some((key) => !["id", "displayName", "model", "baseUrl", "credential", "context", "thinking", "reasoningEffort", "transport", "maxOutputTokens", "enabled"].includes(key))) throw invalid();
    if (provider.maxOutputTokens !== undefined && (!Number.isSafeInteger(provider.maxOutputTokens) || Number(provider.maxOutputTokens) < 1 || Number(provider.maxOutputTokens) > Math.min(MAX_MODEL_OUTPUT_TOKENS, Number(provider.context.windowTokens)))) throw invalid();
    if (provider.reasoningEffort !== undefined && !isReasoningEffort(provider.reasoningEffort)) throw invalid();
    if (provider.thinking !== undefined && (!record(provider.thinking) || typeof provider.thinking.enabled !== "boolean" ||
      Object.keys(provider.thinking).some((key) => !["enabled", "budgetTokens", "apiStyle"].includes(key)) ||
      (provider.thinking.budgetTokens !== undefined && (!Number.isSafeInteger(provider.thinking.budgetTokens) || Number(provider.thinking.budgetTokens) < 128 || Number(provider.thinking.budgetTokens) > 32768)) ||
      (provider.thinking.apiStyle !== undefined && !["siliconflow", "deepseek"].includes(String(provider.thinking.apiStyle))) ||
      (provider.thinking.budgetTokens !== undefined && (!provider.thinking.enabled || provider.thinking.apiStyle === "deepseek")))) throw invalid();
    const transport = provider.transport;
    if (transport !== undefined && (!record(transport) ||
      Object.keys(transport).some((key) => !["firstByteTimeoutMs", "idleTimeoutMs", "totalTimeoutMs", "maxRetries"].includes(key)) ||
      ["firstByteTimeoutMs", "idleTimeoutMs", "totalTimeoutMs"].some((key) => !Number.isSafeInteger(transport[key]) || Number(transport[key]) < 100 || Number(transport[key]) > 1_800_000) ||
      !Number.isSafeInteger(transport.maxRetries) || Number(transport.maxRetries) < 0 || Number(transport.maxRetries) > 3)) throw invalid();
    if (record(transport) && Number(transport.totalTimeoutMs) < Number(transport.firstByteTimeoutMs)) throw invalid();
    if (providerIds.has(provider.id)) throw invalid();
    providerIds.add(provider.id);
    const credential = provider.credential;
    if (!record(credential) || (credential.kind === "environment" ? !variable(credential.variable)
      : credential.kind === "local" ? !shortText(credential.value, 8192) : credential.kind !== "none")) throw invalid();
    if (Object.keys(credential).some((key) => !["kind", ...(credential.kind === "environment" ? ["variable"] : credential.kind === "local" ? ["value"] : [])].includes(key))) throw invalid();
    if (credential.kind === "none" && provider.enabled) throw invalid();
    if (!Number.isSafeInteger(provider.context.windowTokens) || Number(provider.context.windowTokens) < 1024 || Number(provider.context.windowTokens) > 10_000_000) throw invalid();
    if (Object.keys(provider.context).some((key) => !["windowTokens", "singleToolResultTokens", "toolResultGroupTokens", "recentMessagesTokens", "automaticReserveTokens", "manualReserveTokens", "previewChars", "operationalCompactionTokens", "recentToolExchanges"].includes(key))) throw invalid();
    for (const key of ["singleToolResultTokens", "toolResultGroupTokens", "recentMessagesTokens", "automaticReserveTokens", "manualReserveTokens", "previewChars"])
      if (!Number.isSafeInteger(provider.context[key]) || Number(provider.context[key]) < 1 || Number(provider.context[key]) > (key === "previewChars" ? 65536 : 1_000_000)) throw invalid();
    for (const [key, maximum] of [["operationalCompactionTokens", 1_000_000], ["recentToolExchanges", 32]] as const)
      if (provider.context[key] !== undefined && (!Number.isSafeInteger(provider.context[key]) || Number(provider.context[key]) < 1 || Number(provider.context[key]) > maximum)) throw invalid();
    if (Number(provider.context.toolResultGroupTokens) < Number(provider.context.singleToolResultTokens) || Number(provider.context.automaticReserveTokens) <= Number(provider.context.manualReserveTokens) || Number(provider.context.windowTokens) <= Number(provider.context.automaticReserveTokens) + Number(provider.context.recentMessagesTokens)) throw invalid();
  }
  const workspaceIds = new Set<string>();
  for (const workspace of value.workspaces) {
    if (!record(workspace) || !identifier(workspace.id) || !shortText(workspace.name, 80) || !shortText(workspace.rootPath, 4096) || !path.isAbsolute(workspace.rootPath) || typeof workspace.enabled !== "boolean") throw invalid();
    if (Object.keys(workspace).some((key) => !["id", "name", "rootPath", "enabled", "knowledge"].includes(key))) throw invalid();
    if (workspace.knowledge !== undefined) { try { workspace.knowledge = parseKnowledgeConfig(workspace.knowledge); } catch { throw invalid(); } }
    if (workspaceIds.has(workspace.id)) throw invalid();
    workspaceIds.add(workspace.id);
  }
  const serverKeys = new Set<string>();
  for (const server of value.mcpServers) {
    if (!record(server) || !identifier(server.name) || !["user", "workspace"].includes(String(server.scope)) || typeof server.enabled !== "boolean" || !record(server.config)) throw invalid();
    if (Object.keys(server).some((key) => !["name", "scope", "workspaceId", "enabled", "config"].includes(key))) throw invalid();
    if (server.scope === "workspace" ? !identifier(server.workspaceId) || !workspaceIds.has(String(server.workspaceId)) : server.workspaceId !== undefined) throw invalid();
    const key = `${server.scope}:${server.workspaceId ?? ""}:${server.name}`;
    if (serverKeys.has(key)) throw invalid();
    serverKeys.add(key);
    if (server.config.type === "http") {
      if (!httpUrl(server.config.url) || !record(server.config.headers) ||
        Object.keys(server.config).some((key) => !["type", "url", "headers"].includes(key)) ||
        !stringMap(server.config.headers, 32, 16 * 1024, /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)) throw invalid();
      const url = new URL(server.config.url);
      if (url.username || url.password || url.hash) throw invalid();
    } else if (server.config.type === "stdio") {
      if (!shortText(server.config.command, 4096) || !Array.isArray(server.config.args) ||
        server.config.args.length > 128 || server.config.args.some((arg: unknown) => typeof arg !== "string" || Buffer.byteLength(arg) > 4096 || arg.includes("\0")) ||
        !record(server.config.env) || !stringMap(server.config.env, 32, 16 * 1024, /^[A-Za-z_][A-Za-z0-9_]*$/) ||
        Object.keys(server.config).some((key) => !["type", "command", "args", "env"].includes(key))) throw invalid();
    } else throw invalid();
  }
  if (value.defaultProviderId !== undefined && (!providerIds.has(String(value.defaultProviderId)) || !value.providers.some((p: unknown) => record(p) && p.id === value.defaultProviderId && p.enabled))) throw invalid();
  if (value.defaultWorkspaceId !== undefined && (!workspaceIds.has(String(value.defaultWorkspaceId)) || !value.workspaces.some((w: unknown) => record(w) && w.id === value.defaultWorkspaceId && w.enabled))) throw invalid();
  if (value.toolFailurePolicy !== undefined && !isToolFailurePolicy(value.toolFailurePolicy)) throw invalid();
  if (value.maxIterations !== undefined && value.maxIterations !== "unlimited" && (!Number.isSafeInteger(value.maxIterations) || Number(value.maxIterations) < 1 || Number(value.maxIterations) > 32)) throw invalid();
  if (value.maxRuntimeMinutes !== undefined && (!Number.isSafeInteger(value.maxRuntimeMinutes) || Number(value.maxRuntimeMinutes) < 1 || Number(value.maxRuntimeMinutes) > 1440)) throw invalid();
  if (value.defaultPermissionMode !== undefined && !["strict", "default", "permissive"].includes(String(value.defaultPermissionMode))) throw invalid();
  try { parseSubAgentLimits(value.subAgents); } catch { throw invalid(); }
  return value as ManagedSettings;
}
function invalid(): SettingsError { return new SettingsError("invalid", "本地设置字段无效。"); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function identifier(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value); }
function variable(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value); }
function shortText(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value) <= max && !value.includes("\0"); }
function stringMap(value: Record<string, unknown>, maxEntries: number, maxValueBytes: number, keyPattern: RegExp): boolean {
  return Object.keys(value).length <= maxEntries && Object.entries(value).every(([key, entry]) =>
    keyPattern.test(key) && typeof entry === "string" && Buffer.byteLength(entry) <= maxValueBytes && !entry.includes("\0") && !/[\r\n]/.test(entry));
}
function httpUrl(value: unknown): value is string { try { return typeof value === "string" && ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; } }
function hasCode(value: unknown, code: string): boolean { return record(value) && value.code === code; }
function isMissing(value: unknown): boolean { return hasCode(value, "ENOENT"); }
export { validateSettings, EMPTY_SETTINGS };
