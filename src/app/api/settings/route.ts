import { parseSubAgentLimits } from "@/core/sub-agents/types";
import type { ModelThinkingConfig } from "@/models/provider";
import { reconcileWebMcpSettings } from "@/web/settings-mcp";
import { webSettingsStore } from "@/web/storage-paths";
import { access } from "node:fs/promises";
import path from "node:path";
import { SettingsService, type SettingsAction } from "@/runtime/settings-service";
import { SettingsError } from "@/runtime/settings-types";
import { LocalManagementError, openSettingsSession, assertSettingsMutation } from "@/web/local-management-guard";
import { readBoundedJsonBody, WebRequestSecurityError } from "@/web/request-security";

export const dynamic = "force-dynamic";

const service = new SettingsService(webSettingsStore);

export async function GET(request: Request): Promise<Response> {
  let headers: Headers | undefined;
  try {
    headers = openSettingsSession(request);
    const view = await service.view();
    if (view.source === "empty") {
      try { await access(path.join(process.cwd(), "orbitcode.yaml")); return Response.json({ ...view, source: "legacy" }, { headers }); }
      catch { /* 无旧模型配置，进入首次设置。 */ }
    }
    return Response.json(view, { headers });
  } catch (error) { return failure(error, headers); }
}

export async function PATCH(request: Request): Promise<Response> {
  try {
    assertSettingsMutation(request);
    const value = await readBoundedJsonBody(request, 256 * 1024);
    const payload = parsePayload(value);
    const previous = await service.load();
    const view = await service.apply(payload.expectedRevision, payload.action);
    try {
      const current = await service.load();
      if (current) await reconcileWebMcpSettings(previous, current);
    }
    catch {
      return Response.json({ ...view, warning: "设置已保存，但旧 MCP 连接清理未完成；请停止相关运行后重试断开。" }, { headers: { "cache-control": "no-store" } });
    }
    return Response.json(view, { headers: { "cache-control": "no-store" } });
  } catch (error) { return failure(error); }
}

function parsePayload(value: unknown): { expectedRevision: number; action: SettingsAction } {
  if (!record(value) || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0 || !record(value.action)) throw new SettingsError("invalid", "设置请求字段无效。");
  if (Object.keys(value).some((key) => !["expectedRevision", "action"].includes(key))) throw new SettingsError("invalid", "设置请求含未知字段。");
  const action = value.action;
  const fields: Readonly<Record<string, readonly string[]>> = {
    "provider-add": ["displayName", "model", "baseUrl", "windowTokens", "credential", "maxOutputTokens", "thinking"],
    "provider-edit": ["id", "displayName", "model", "baseUrl", "windowTokens", "credential", "maxOutputTokens", "thinking"],
    "provider-enable": ["id", "enabled"], "provider-default": ["id"],
    "workspace-add": ["name", "rootPath"], "workspace-rename": ["id", "name"], "workspace-enable": ["id", "enabled"],
    "workspace-default": ["id"], "workspace-remove": ["id"],
    "mcp-upsert": ["name", "scope", "workspaceId", "config"], "mcp-enable": ["name", "scope", "workspaceId", "enabled"],
    "mcp-remove": ["name", "scope", "workspaceId"], "preferences-set": ["maxIterations", "maxRuntimeMinutes", "defaultPermissionMode", "subAgents"],
  };
  if (typeof action.type !== "string" || !Object.hasOwn(fields, action.type) || Object.keys(action).some((key) => key !== "type" && !fields[String(action.type)].includes(key)))
    throw new SettingsError("invalid", "设置操作含未知字段。");
  switch (action.type) {
    case "provider-add":
      if (typeof action.displayName === "string" && typeof action.model === "string" && typeof action.baseUrl === "string" && typeof action.windowTokens === "number")
        return { expectedRevision: Number(value.expectedRevision), action: { type: "provider-add", displayName: action.displayName, model: action.model, baseUrl: action.baseUrl, windowTokens: action.windowTokens, credential: credential(action.credential), ...advanced(action) } };
      break;
    case "provider-edit":
      if (["displayName", "model", "baseUrl"].some((key) => action[key] !== undefined && typeof action[key] !== "string") ||
        (action.windowTokens !== undefined && typeof action.windowTokens !== "number")) throw new SettingsError("invalid", "模型编辑字段类型无效。");
      if (typeof action.id === "string") return { expectedRevision: Number(value.expectedRevision), action: {
        type: "provider-edit", id: action.id, ...advanced(action),
        ...(typeof action.displayName === "string" ? { displayName: action.displayName } : {}),
        ...(typeof action.model === "string" ? { model: action.model } : {}),
        ...(typeof action.baseUrl === "string" ? { baseUrl: action.baseUrl } : {}),
        ...(typeof action.windowTokens === "number" ? { windowTokens: action.windowTokens } : {}),
        ...(action.credential !== undefined ? { credential: credential(action.credential) } : {}),
      } };
      break;
    case "provider-enable": case "workspace-enable":
      if (typeof action.id === "string" && typeof action.enabled === "boolean") return { expectedRevision: Number(value.expectedRevision), action: { type: action.type, id: action.id, enabled: action.enabled } };
      break;
    case "provider-default": case "workspace-default": case "workspace-remove":
      if (typeof action.id === "string") return { expectedRevision: Number(value.expectedRevision), action: { type: action.type, id: action.id } };
      break;
    case "workspace-add":
      if (typeof action.name === "string" && typeof action.rootPath === "string") return { expectedRevision: Number(value.expectedRevision), action: { type: "workspace-add", name: action.name, rootPath: action.rootPath } };
      break;
    case "workspace-rename":
      if (typeof action.id === "string" && typeof action.name === "string") return { expectedRevision: Number(value.expectedRevision), action: { type: "workspace-rename", id: action.id, name: action.name } };
      break;
    case "mcp-upsert":
      if (typeof action.name === "string" && (action.scope === "user" || action.scope === "workspace") && (action.workspaceId === undefined || typeof action.workspaceId === "string") && record(action.config)) {
        const configFields = action.config.type === "http" ? ["type", "url", "headers"] : ["type", "command", "args", "env"];
        if (Object.keys(action.config).some((key) => !configFields.includes(key))) throw new SettingsError("invalid", "MCP 配置含未知字段。");
        const scope = action.scope;
        const workspaceId = typeof action.workspaceId === "string" ? action.workspaceId : undefined;
        if (action.config.type === "http" && typeof action.config.url === "string" && record(action.config.headers) && Object.values(action.config.headers).every((item) => typeof item === "string"))
          return { expectedRevision: Number(value.expectedRevision), action: { type: "mcp-upsert", name: action.name, scope, ...(workspaceId ? { workspaceId } : {}), config: { type: "http", url: action.config.url, headers: action.config.headers as Record<string, string> } } };
        if (action.config.type === "stdio" && typeof action.config.command === "string" && Array.isArray(action.config.args) && action.config.args.every((item: unknown) => typeof item === "string") && record(action.config.env) && Object.values(action.config.env).every((item) => typeof item === "string"))
          return { expectedRevision: Number(value.expectedRevision), action: { type: "mcp-upsert", name: action.name, scope, ...(workspaceId ? { workspaceId } : {}), config: { type: "stdio", command: action.config.command, args: action.config.args as string[], env: action.config.env as Record<string, string> } } };
      }
      break;
    case "mcp-enable": case "mcp-remove":
      if (typeof action.name === "string" && (action.scope === "user" || action.scope === "workspace") && (action.workspaceId === undefined || typeof action.workspaceId === "string") && (action.type === "mcp-remove" || typeof action.enabled === "boolean"))
        return { expectedRevision: Number(value.expectedRevision), action: action.type === "mcp-remove"
          ? { type: "mcp-remove", name: action.name, scope: action.scope, ...(action.workspaceId ? { workspaceId: action.workspaceId } : {}) }
          : { type: "mcp-enable", name: action.name, scope: action.scope, ...(action.workspaceId ? { workspaceId: action.workspaceId } : {}), enabled: action.enabled as boolean } };
      break;
    case "preferences-set":
      if (typeof action.maxIterations === "number" && typeof action.maxRuntimeMinutes === "number" &&
        (action.defaultPermissionMode === "strict" || action.defaultPermissionMode === "default" || action.defaultPermissionMode === "permissive"))
        return { expectedRevision: Number(value.expectedRevision), action: { type: "preferences-set", maxIterations: action.maxIterations,
          maxRuntimeMinutes: action.maxRuntimeMinutes, defaultPermissionMode: action.defaultPermissionMode, ...(action.subAgents===undefined?{}:{subAgents:parseWebSubAgentLimits(action.subAgents)}) } };
      break;
  }
  throw new SettingsError("invalid", "设置操作或字段无效。");
}

function credential(value: unknown): { kind: "environment"; variable: string } | { kind: "local"; value: string } | { kind: "none" } {
  if (!record(value)) throw new SettingsError("invalid", "凭据字段无效。");
  if (Object.keys(value).some((key) => !["kind", ...(value.kind === "local" ? ["value"] : value.kind === "environment" ? ["variable"] : [])].includes(key))) throw new SettingsError("invalid", "凭据含未知字段。");
  if (value.kind === "environment" && typeof value.variable === "string") return { kind: "environment", variable: value.variable };
  if (value.kind === "local" && typeof value.value === "string") return { kind: "local", value: value.value };
  if (value.kind === "none" && Object.keys(value).length === 1) return { kind: "none" };
  throw new SettingsError("invalid", "凭据字段无效。");
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function failure(error: unknown, headers?: Headers): Response {
  const status = error instanceof LocalManagementError ? 403 : error instanceof WebRequestSecurityError ? error.kind === "body-too-large" ? 413 : 400
    : error instanceof SettingsError ? error.code === "conflict" ? 409 : error.code === "unavailable" ? 404 : 400 : 500;
  const message = error instanceof LocalManagementError || error instanceof SettingsError || error instanceof WebRequestSecurityError ? error.message : "设置操作失败。";
  return Response.json({ error: message, code: error instanceof SettingsError ? error.code : undefined },
    { status, headers: headers ?? { "cache-control": "no-store" } });
}

function advanced(action: Record<string, unknown>): { maxOutputTokens?: number | null; thinking?: ModelThinkingConfig | null } {
  if (action.maxOutputTokens !== undefined && action.maxOutputTokens !== null && typeof action.maxOutputTokens !== "number")
    throw new SettingsError("invalid", "最大输出 Tokens 类型无效。");
  const value = action.thinking;
  let thinking: ModelThinkingConfig | null | undefined;
  if (value === null) thinking = null;
  else if (value !== undefined) {
    if (!record(value) || typeof value.enabled !== "boolean" ||
      Object.keys(value).some(key => !["enabled", "apiStyle", "budgetTokens"].includes(key)) ||
      (value.apiStyle !== undefined && value.apiStyle !== "deepseek" && value.apiStyle !== "siliconflow") ||
      (value.budgetTokens !== undefined && typeof value.budgetTokens !== "number"))
      throw new SettingsError("invalid", "思考模式字段无效。");
    thinking = { enabled: value.enabled, ...(value.apiStyle === undefined ? {} : { apiStyle: value.apiStyle }),
      ...(typeof value.budgetTokens === "number" ? { budgetTokens: value.budgetTokens } : {}) };
  }
  return { ...(typeof action.maxOutputTokens === "number" || action.maxOutputTokens === null ? { maxOutputTokens: action.maxOutputTokens } : {}),
    ...(thinking === undefined ? {} : { thinking }) };
}

function parseWebSubAgentLimits(value:unknown) { try { return parseSubAgentLimits(value); } catch { throw new SettingsError("invalid","子 Agent 预算无效。"); } }
