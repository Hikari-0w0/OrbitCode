import { parseKnowledgeConfig, publicKnowledgeConfig } from "@/runtime/knowledge/config";
import { parseCommandSecurity } from "@/tools/command-security";
import { resolveSandboxReadRoots } from "@/tools/sandbox-read-roots";
import { resolveSandboxWritableRoots } from "@/tools/sandbox-writable-roots";
import { parseSubAgentLimits, type SubAgentLimits } from "@/core/sub-agents/types";
import { isToolFailurePolicy, type ToolFailurePolicy } from "@/core/tool-failure-policy";
import { MAX_MODEL_OUTPUT_TOKENS, type ModelThinkingConfig } from "@/models/provider";
import { randomUUID } from "node:crypto";
import type { AgentIterationLimit } from "@/core/agent-events";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { LocalSettingsStore } from "@/lib/local-settings-store";
import type { ContextPolicyConfig } from "@/core/context/types";
import type { McpServerConfig } from "@/runtime/mcp-config";
import {
  DEFAULT_AUTOMATIC_RESERVE_TOKENS,
  DEFAULT_CONTEXT_PREVIEW_CHARS,
  DEFAULT_MANUAL_RESERVE_TOKENS,
  DEFAULT_RECENT_MESSAGES_TOKENS,
  DEFAULT_RECENT_TOOL_EXCHANGES,
  DEFAULT_SINGLE_TOOL_RESULT_TOKENS,
  DEFAULT_TOOL_RESULT_GROUP_TOKENS,
  DEFAULT_OPERATIONAL_COMPACTION_TOKENS,
} from "@/core/context/types";
import { EMPTY_SETTINGS, SettingsError, type ManagedMcpServer, type ManagedProvider, type ManagedSettings, type ManagedWorkspace, type PublicSettings, type StoredCredential } from "@/runtime/settings-types";

import { isReasoningEffort, type ModelReasoningEffort } from "@/models/reasoning-effort";

type ProviderAdvancedSettings = {
  readonly maxOutputTokens?: number | null;
  readonly thinking?: ModelThinkingConfig | null;
  readonly reasoningEffort?: ModelReasoningEffort | null;
};

export type SettingsAction =
  | { readonly type: "command-security-set"; readonly config: unknown }
  | { readonly type: "knowledge-set"; readonly id: string; readonly config: unknown }
  | ({ readonly type: "provider-add"; readonly displayName: string; readonly model: string; readonly baseUrl: string; readonly windowTokens: number; readonly credential: StoredCredential } & ProviderAdvancedSettings)
  | ({ readonly type: "provider-edit"; readonly id: string; readonly displayName?: string; readonly model?: string; readonly baseUrl?: string; readonly windowTokens?: number; readonly credential?: StoredCredential } & ProviderAdvancedSettings)
  | { readonly type: "provider-enable"; readonly id: string; readonly enabled: boolean }
  | { readonly type: "provider-default"; readonly id: string }
  | { readonly type: "workspace-add"; readonly name: string; readonly rootPath: string }
  | { readonly type: "workspace-rename"; readonly id: string; readonly name: string }
  | { readonly type: "workspace-enable"; readonly id: string; readonly enabled: boolean }
  | { readonly type: "workspace-remove"; readonly id: string }
  | { readonly type: "workspace-default"; readonly id: string }
  | { readonly type: "mcp-upsert"; readonly name: string; readonly scope: "user" | "workspace"; readonly workspaceId?: string; readonly config: McpServerConfig }
  | { readonly type: "mcp-enable"; readonly name: string; readonly scope: "user" | "workspace"; readonly workspaceId?: string; readonly enabled: boolean }
  | { readonly type: "mcp-remove"; readonly name: string; readonly scope: "user" | "workspace"; readonly workspaceId?: string }
  | { readonly type: "preferences-set"; readonly toolFailurePolicy?: ToolFailurePolicy; readonly subAgents?: SubAgentLimits; readonly maxIterations: AgentIterationLimit; readonly maxRuntimeMinutes: number; readonly defaultPermissionMode: "strict" | "default" | "permissive" };

export class SettingsService {
  constructor(readonly store = new LocalSettingsStore()) {}

  async load(): Promise<ManagedSettings | null> { return this.store.load(); }

  async view(): Promise<PublicSettings> {
    const stored = await this.store.load();
    const settings = stored ?? EMPTY_SETTINGS;
    return {
      ...settings,
      source: stored ? "managed" : "empty",
      workspaces: settings.workspaces.map(({knowledge,...workspace})=>({...workspace,...(knowledge?{knowledge:publicKnowledgeConfig(knowledge)}:{})})),
      providers: settings.providers.map(({ credential, ...provider }) => ({
        ...provider,
        credential: credential.kind === "environment"
          ? { kind: "environment" as const, configured: true, variable: credential.variable }
          : credential.kind === "local" ? { kind: "local" as const, configured: true }
          : { kind: "none" as const, configured: false },
      })),
      mcpServers: settings.mcpServers.map(({ name, scope, workspaceId, enabled, config }) => ({
        name, scope, ...(workspaceId ? { workspaceId } : {}), enabled,
        type: config.type,
        endpoint: config.type === "http" ? safeEndpoint(config.url) : "本地命令",
      })),
    };
  }

  async apply(expectedRevision: number, action: SettingsAction): Promise<PublicSettings> {
    const settings = await this.store.load() ?? EMPTY_SETTINGS;
    if (settings.revision !== expectedRevision) throw new SettingsError("conflict", "设置已更新，请刷新后重试。");
    let next: ManagedSettings;
    switch (action.type) {
      case "command-security-set": {
        try {
          const commandSecurity = parseCommandSecurity(action.config);
          await resolveSandboxReadRoots(commandSecurity.readOnlyRoots, this.store.directory);
          await resolveSandboxWritableRoots(commandSecurity.writableRoots, this.store.directory, commandSecurity.readOnlyRoots);
          for (const workspace of settings.workspaces) {
            await resolveSandboxReadRoots(commandSecurity.readOnlyRoots, workspace.rootPath);
            await resolveSandboxWritableRoots(commandSecurity.writableRoots, workspace.rootPath, commandSecurity.readOnlyRoots);
          }
          next = { ...settings, commandSecurity };
        }
        catch (error) { throw new SettingsError("invalid", error instanceof Error ? error.message : "命令安全配置无效。"); }
        break;
      }
      case "knowledge-set": {
        if (!settings.workspaces.some(item=>item.id===action.id && item.enabled)) throw missing();
        const previous=settings.workspaces.find(item=>item.id===action.id)?.knowledge;
        const input=typeof action.config==="object" && action.config!==null && !Array.isArray(action.config)?action.config:undefined;
        const knowledge=parseKnowledgeConfig(input && !("credential" in input) && previous ? {...input,credential:previous.credential} : action.config);
        next={...settings,workspaces:settings.workspaces.map(item=>item.id===action.id?{...item,knowledge}:item)}; break;
      }
      case "provider-add": {
        if (action.credential.kind === "none") throw new SettingsError("invalid", "新增模型需要凭据。");
        const provider = { ...providerFromInput(action), ...advancedSettings(action, action.windowTokens) };
        next = { ...settings, providers: [...settings.providers, provider], defaultProviderId: settings.defaultProviderId ?? provider.id };
        break;
      }
      case "provider-edit": {
        const previous = settings.providers.find((item) => item.id === action.id);
        if (!previous) throw missing();
        const changed = providerFromInput({
          displayName: action.displayName ?? previous.displayName,
          model: action.model ?? previous.model,
          baseUrl: action.baseUrl ?? previous.baseUrl,
          windowTokens: action.windowTokens ?? previous.context.windowTokens,
          credential: action.credential ?? previous.credential,
        }, previous.id);
        const clearing = action.credential?.kind === "none";
        next = { ...settings, providers: settings.providers.map((item) => item.id === action.id
          ? { ...changed, context: { ...item.context, windowTokens: changed.context.windowTokens },
            ...advancedSettings({ maxOutputTokens: action.maxOutputTokens === undefined ? item.maxOutputTokens : action.maxOutputTokens,
              reasoningEffort: action.reasoningEffort === undefined ? item.reasoningEffort : action.reasoningEffort,
              thinking: action.thinking === undefined ? item.thinking : action.thinking }, changed.context.windowTokens), ...(item.transport ? { transport: item.transport } : {}), enabled: clearing ? false : item.enabled }
          : item), defaultProviderId: clearing && settings.defaultProviderId === action.id
          ? settings.providers.find((item) => item.id !== action.id && item.enabled)?.id : settings.defaultProviderId };
        break;
      }
      case "provider-enable": {
        if (!settings.providers.some((item) => item.id === action.id && (!action.enabled || item.credential.kind !== "none"))) throw missing();
        next = { ...settings, providers: settings.providers.map((item) => item.id === action.id ? { ...item, enabled: action.enabled } : item),
          defaultProviderId: !action.enabled && settings.defaultProviderId === action.id ? settings.providers.find((item) => item.id !== action.id && item.enabled)?.id : settings.defaultProviderId };
        break;
      }
      case "provider-default": {
        if (!settings.providers.some((item) => item.id === action.id && item.enabled)) throw missing();
        next = { ...settings, defaultProviderId: action.id };
        break;
      }
      case "workspace-add": {
        const workspace = await workspaceFromInput(action);
        next = { ...settings, workspaces: [...settings.workspaces, workspace], defaultWorkspaceId: settings.defaultWorkspaceId ?? workspace.id };
        break;
      }
      case "workspace-rename": {
        if (!settings.workspaces.some((item) => item.id === action.id)) throw missing();
        validateName(action.name);
        next = { ...settings, workspaces: settings.workspaces.map((item) => item.id === action.id ? { ...item, name: action.name.trim() } : item) };
        break;
      }
      case "workspace-enable": {
        if (!settings.workspaces.some((item) => item.id === action.id)) throw missing();
        next = { ...settings, workspaces: settings.workspaces.map((item) => item.id === action.id ? { ...item, enabled: action.enabled } : item),
          defaultWorkspaceId: !action.enabled && settings.defaultWorkspaceId === action.id ? settings.workspaces.find((item) => item.id !== action.id && item.enabled)?.id : settings.defaultWorkspaceId };
        break;
      }
      case "workspace-remove": {
        if (!settings.workspaces.some((item) => item.id === action.id)) throw missing();
        const remaining = settings.workspaces.filter((item) => item.id !== action.id);
        next = { ...settings, workspaces: remaining,
          mcpServers: settings.mcpServers.filter((item) => item.workspaceId !== action.id),
          defaultWorkspaceId: settings.defaultWorkspaceId === action.id ? remaining.find((item) => item.enabled)?.id : settings.defaultWorkspaceId };
        break;
      }
      case "workspace-default": {
        if (!settings.workspaces.some((item) => item.id === action.id && item.enabled)) throw missing();
        next = { ...settings, defaultWorkspaceId: action.id };
        break;
      }
      case "mcp-upsert": {
        const server = validateMcpAction(action, settings);
        const matches = (item: ManagedMcpServer) => item.name === action.name && item.scope === action.scope && item.workspaceId === action.workspaceId;
        const previous = settings.mcpServers.find(matches);
        next = { ...settings, mcpServers: [...settings.mcpServers.filter((item) => !matches(item)), { ...server, enabled: previous?.enabled ?? true }] };
        break;
      }
      case "mcp-enable": case "mcp-remove": {
        const matches = (item: ManagedMcpServer) => item.name === action.name && item.scope === action.scope && item.workspaceId === action.workspaceId;
        if (!settings.mcpServers.some(matches)) throw missing();
        next = { ...settings, mcpServers: action.type === "mcp-remove"
          ? settings.mcpServers.filter((item) => !matches(item))
          : settings.mcpServers.map((item) => matches(item) ? { ...item, enabled: action.enabled } : item) };
        break;
      }
      case "preferences-set": {
        if (action.toolFailurePolicy !== undefined && !isToolFailurePolicy(action.toolFailurePolicy)) throw new SettingsError("invalid", "工具失败策略无效。");
        if ((action.maxIterations !== "unlimited" && (!Number.isSafeInteger(action.maxIterations) || action.maxIterations < 1 || action.maxIterations > 32)) ||
          !Number.isSafeInteger(action.maxRuntimeMinutes) || action.maxRuntimeMinutes < 1 || action.maxRuntimeMinutes > 1440 ||
          !["strict", "default", "permissive"].includes(action.defaultPermissionMode))
          throw new SettingsError("invalid", "运行偏好超出允许范围。");
        let subAgents: SubAgentLimits | undefined;
        try { subAgents=action.subAgents===undefined?undefined:parseSubAgentLimits(action.subAgents); } catch { throw new SettingsError("invalid","子 Agent 预算配置无效。"); }
        next = { ...settings, maxIterations: action.maxIterations, maxRuntimeMinutes: action.maxRuntimeMinutes,
          defaultPermissionMode: action.defaultPermissionMode, ...(action.toolFailurePolicy === undefined ? {} : { toolFailurePolicy: action.toolFailurePolicy }), ...(subAgents ? { subAgents } : {}) };
        break;
      }
    }
    await this.store.save(expectedRevision, next);
    for (const previous of settings.workspaces) {
      const current=next.workspaces.find(item=>item.id===previous.id);
      if(previous.knowledge?.enabled && (!current?.enabled || !current.knowledge?.enabled)) {
        const {KnowledgeStore}=await import("@/runtime/knowledge/store");
        const {cancelBuild}=await import("@/runtime/knowledge/lifecycle");
        const store=new KnowledgeStore(this.store.directory,previous.rootPath,previous.id);
        const control=await store.control();
        if(control.version || control.operation) await cancelBuild(store);
      }
    }
    return this.view();
  }
}

function validateMcpAction(action: Extract<SettingsAction, { type: "mcp-upsert" }>, settings: ManagedSettings): ManagedMcpServer {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(action.name)) throw new SettingsError("invalid", "MCP Server 名称无效。");
  if (action.scope === "workspace" ? !action.workspaceId || !settings.workspaces.some((item) => item.id === action.workspaceId && item.enabled) : action.workspaceId !== undefined) throw new SettingsError("invalid", "MCP 作用域或工作区无效。");
  const config = action.config;
  if (config.type === "http") {
    let url: URL;
    try { url = new URL(config.url); } catch { throw new SettingsError("invalid", "MCP URL 无效。"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new SettingsError("invalid", "MCP URL 必须是无凭据的 HTTP(S) 地址。");
    const reserved = new Set(["host", "content-length", "connection", "accept", "content-type", "mcp-session-id", "mcp-protocol-version"]);
    if (Object.keys(config.headers).length > 32 || Object.entries(config.headers).some(([key, value]) =>
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || reserved.has(key.toLowerCase()) || typeof value !== "string" || Buffer.byteLength(value) > 16 * 1024 || /[\r\n\0]/.test(value))) throw new SettingsError("invalid", "MCP headers 无效。");
  } else {
    if (!nonempty(config.command, 4096) || config.args.length > 128 || config.args.some((arg) => typeof arg !== "string" || Buffer.byteLength(arg) > 4096 || arg.includes("\0")) ||
      Object.keys(config.env).length > 32 || Object.entries(config.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || Buffer.byteLength(value) > 16 * 1024 || /[\r\n\0]/.test(value)))
      throw new SettingsError("invalid", "MCP 命令参数无效。");
  }
  return { name: action.name, scope: action.scope, ...(action.workspaceId ? { workspaceId: action.workspaceId } : {}), enabled: true, config };
}

function providerFromInput(input: { readonly displayName: string; readonly model: string; readonly baseUrl: string; readonly windowTokens: number; readonly credential: StoredCredential }, id: string = randomUUID()): ManagedProvider {
  validateName(input.displayName);
  if (!nonempty(input.model, 256)) throw new SettingsError("invalid", "模型名称无效。");
  let url: URL;
  try { url = new URL(input.baseUrl); }
  catch { throw new SettingsError("invalid", "模型 API 地址无效。"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new SettingsError("invalid", "模型 API 地址只接受无凭据的 HTTP(S) 地址。");
  if (!Number.isSafeInteger(input.windowTokens) || input.windowTokens < 16_000 || input.windowTokens > 10_000_000) throw new SettingsError("invalid", "上下文窗口必须为 16000 到 10000000。");
  if (input.credential.kind === "environment") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.credential.variable)) throw new SettingsError("invalid", "凭据环境变量名无效。");
  } else if (input.credential.kind === "local") {
    if (!nonempty(input.credential.value, 8192)) throw new SettingsError("invalid", "模型密钥不能为空。");
  } else if (input.credential.kind === "none") {
    // 清除凭据时停用模型，避免后续轮次隐式复用旧密钥。
  } else throw new SettingsError("invalid", "凭据类型无效。");
  const context: ContextPolicyConfig = {
    windowTokens: input.windowTokens,
    singleToolResultTokens: DEFAULT_SINGLE_TOOL_RESULT_TOKENS,
    toolResultGroupTokens: DEFAULT_TOOL_RESULT_GROUP_TOKENS,
    recentMessagesTokens: DEFAULT_RECENT_MESSAGES_TOKENS,
    automaticReserveTokens: DEFAULT_AUTOMATIC_RESERVE_TOKENS,
    manualReserveTokens: DEFAULT_MANUAL_RESERVE_TOKENS,
    previewChars: DEFAULT_CONTEXT_PREVIEW_CHARS,
    operationalCompactionTokens: DEFAULT_OPERATIONAL_COMPACTION_TOKENS,
    recentToolExchanges: DEFAULT_RECENT_TOOL_EXCHANGES,
  };
  return { id, displayName: input.displayName.trim(), model: input.model.trim(), baseUrl: url.toString().replace(/\/$/, ""), credential: input.credential, context, enabled: true };
}

async function workspaceFromInput(input: { readonly name: string; readonly rootPath: string }): Promise<ManagedWorkspace> {
  validateName(input.name);
  if (!path.isAbsolute(input.rootPath) || input.rootPath.length > 4096) throw new SettingsError("invalid", "工作区必须是有效绝对路径。");
  let rootPath: string;
  try { rootPath = await realpath(input.rootPath); if (!(await stat(rootPath)).isDirectory()) throw new Error("not-directory"); }
  catch { throw new SettingsError("unavailable", "工作区目录不可访问。"); }
  return { id: randomUUID(), name: input.name.trim(), rootPath, enabled: true };
}
function validateName(value: string): void { if (!nonempty(value, 80)) throw new SettingsError("invalid", "名称不能为空且不能超过 80 字节。"); }
function nonempty(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value) <= max && !value.includes("\0"); }
function missing(): SettingsError { return new SettingsError("unavailable", "所选配置不存在或已停用。"); }
function safeEndpoint(source: string): string { try { const url = new URL(source); return `${url.protocol}//${url.host}`; } catch { return "地址无效"; } }

function advancedSettings(input: ProviderAdvancedSettings, windowTokens: number): Pick<ManagedProvider, "maxOutputTokens" | "thinking" | "reasoningEffort"> {
  const maxOutputTokens = input.maxOutputTokens ?? undefined;
  const thinking = input.thinking ?? undefined;
  const reasoningEffort = input.reasoningEffort ?? undefined;
  if (reasoningEffort !== undefined && !isReasoningEffort(reasoningEffort))
    throw new SettingsError("invalid", "推理深度只支持 low、high 或 max。");
  if (maxOutputTokens !== undefined && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > Math.min(MAX_MODEL_OUTPUT_TOKENS, windowTokens)))
    throw new SettingsError("invalid", "最大输出 Tokens 必须为正整数，且不超过上下文窗口和 1048576。");
  if (thinking !== undefined && (typeof thinking.enabled !== "boolean" ||
    Object.keys(thinking).some(key => !["enabled", "apiStyle", "budgetTokens"].includes(key)) ||
    (thinking.apiStyle !== undefined && thinking.apiStyle !== "siliconflow" && thinking.apiStyle !== "deepseek") ||
    (thinking.budgetTokens !== undefined && (!thinking.enabled || thinking.apiStyle === "deepseek" || !Number.isSafeInteger(thinking.budgetTokens) || thinking.budgetTokens < 128 || thinking.budgetTokens > 32768))))
    throw new SettingsError("invalid", "思考模式或思考预算无效；DeepSeek 不支持单独的思考预算。");
  return { maxOutputTokens, thinking, reasoningEffort };
}
