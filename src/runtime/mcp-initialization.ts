import { randomUUID } from "node:crypto";
import type { AgentMode } from "@/core/agent-events";
import type { RuntimeInitializationEvent } from "@/core/mcp-events";
import { createMcpRedactor } from "@/lib/mcp-redaction";
import { McpError } from "@/mcp/types";
import type { McpConfigSnapshot, ResolvedMcpServer } from "@/runtime/mcp-config";
import type { McpConnectionLease, McpConnectionManager } from "@/runtime/mcp-connections";
import { createMcpTool } from "@/tools/mcp-tool";
import type { PermissionGateway } from "@/tools/permission-gateway";
import type { PermissionOperation, RegisteredTool } from "@/tools/registry";
import { toolFailure, type ToolExecutionResult } from "@/tools/types";

export async function* initializeMcpWorkspace(options: {
  readonly workspaceRoot: string;
  readonly mode: AgentMode;
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
  readonly load: () => Promise<McpConfigSnapshot>;
  readonly manager: McpConnectionManager;
  readonly gateway: PermissionGateway;
  readonly leases: McpConnectionLease[];
}): AsyncGenerator<RuntimeInitializationEvent, readonly RegisteredTool[]> {
  if (options.mode === "plan") return [];
  const snapshot = await options.load();
  await options.manager.reconcile(options.workspaceRoot, snapshot.servers);
  for (const item of snapshot.diagnostics) yield { type: "mcp-status", ...item, phase: "unavailable", durationMs: 0 };
  const tools: RegisteredTool[] = [];
  const names = new Set<string>();
  let definitionBytes = 0;
  for (const server of snapshot.servers) {
    if (options.signal.aborted) break;
    const started = Date.now();
    const redact = createMcpRedactor(server.secrets);
    const revalidate = async (signal: AbortSignal): Promise<ToolExecutionResult | undefined> => {
      if (signal.aborted) return toolFailure("cancelled", "MCP 操作已取消。");
      const current = (await options.load()).servers.find((item) => item.name === server.name);
      if (current?.configurationId !== server.configurationId) return toolFailure("approval-invalid", "MCP 配置已变化，需重新取得授权。");
      return undefined;
    };
    const operation: PermissionOperation = {
      name: "mcp_connect", mutability: "external", fingerprint: server.configurationId,
      permissionTarget: { kind: "mcp", operation: "connect", serverName: server.name, configurationId: server.configurationId, summary: connectionSummary(server, redact) },
      revalidate,
    };
    let authorization = await options.gateway.authorizeConnection(operation, `mcp-start-${randomUUID()}`, options.signal);
    if (authorization.kind === "awaiting") {
      const { prompt } = authorization;
      yield { type: "runtime-permission-requested", serverName: server.name, prompt };
      authorization = await authorization.resolve();
      yield { type: "runtime-permission-resolved", serverName: server.name, requestId: prompt.requestId, status: authorization.kind === "allowed" ? "allowed" : authorization.kind === "denied" ? authorization.approvalStatus ?? "invalid" : "invalid", ...(authorization.kind === "allowed" && authorization.approvalScope ? { scope: authorization.approvalScope } : {}) };
    }
    if (authorization.kind !== "allowed") {
      yield { type: "mcp-status", serverName: server.name, phase: "unavailable", detail: "MCP 连接未获授权。", durationMs: Date.now() - started, authorization: authorization.kind === "denied" ? authorization.approvalStatus ?? "denied" : "invalid" };
      continue;
    }
    const allowed = authorization;
    let lease: McpConnectionLease | undefined;
    try {
      const failure = await allowed.revalidate(options.signal);
      if (failure) throw new McpError("cancelled", "MCP 连接授权已失效。");
      yield { type: "mcp-status", serverName: server.name, phase: "connecting", detail: "正在初始化 MCP Server。", durationMs: Date.now() - started, authorization: "allowed" };
      lease = await options.manager.acquire({ server, signal: options.signal, deadlineMs: options.deadlineMs, revalidate: async (signal) => {
        const denied = await allowed.revalidate(signal);
        if (denied) throw new McpError("cancelled", "MCP 连接授权已失效。");
      } });
      const acquired = lease;
      const additions: RegisteredTool[] = [];
      let skipped = 0;
      const skipReasons: string[] = [];
      for (const definition of acquired.tools) {
        try {
          const tool = createMcpTool(definition, { serverName: server.name, configurationId: server.configurationId, redact, revalidate, call: (name, args, request) => acquired.call(name, args, request) });
          if (names.has(tool.name) || additions.some((item) => item.name === tool.name)) throw new McpError("mcp-protocol", "MCP 工具名称冲突。");
          additions.push(tool);
        } catch (error) {
          if (error instanceof McpError) throw error;
          skipped++;
          if (skipReasons.length < 3) skipReasons.push(`${redact(definition.name).slice(0, 80)}：${redact(error instanceof Error ? error.message : "不支持的工具定义").slice(0, 160)}`);
        }
      }
      const bytes = additions.reduce((sum, t) => sum + Buffer.byteLength(JSON.stringify(t.inputSchema.jsonSchema)) + Buffer.byteLength(t.description), 0);
      if (tools.length + additions.length > 256 || definitionBytes + bytes > 512 * 1024) throw new McpError("limit-exceeded", "工作区 MCP 工具目录超过上限。");
      tools.push(...additions); definitionBytes += bytes;
      for (const t of additions) names.add(t.name);
      options.leases.push(acquired);
      lease = undefined;
      yield { type: "mcp-status", serverName: server.name, phase: "ready", durationMs: Date.now() - started, authorization: "allowed", detail: `已注册 ${additions.length} 个工具。${skipped ? ` ${skipped} 个工具未注册。${skipReasons.join("；")}` : ""}` };
    } catch (error) {
      await lease?.release();
      yield { type: "mcp-status", serverName: server.name, phase: "unavailable", durationMs: Date.now() - started, authorization: "allowed", detail: error instanceof McpError ? error.message : "MCP Server 初始化失败。" };
    }
  }
  return tools;
}
function connectionSummary(server: ResolvedMcpServer, redact: (text: string) => string) {
  const config = server.config;
  const target = config.type === "stdio" ? `${config.command} ${config.args.join(" ")}` : `${new URL(config.url).origin}${new URL(config.url).pathname}`;
  return { operation: "连接外部 Server", serverName: server.name, transport: config.type, target: redact(target).slice(0, 4096), boundary: "启动／连接授权不等于工具调用授权；外部 Server 不受本地文件沙箱保证" };
}
