import { McpClient } from "@/mcp/client";
import { McpStdioTransport } from "@/mcp/stdio-transport";
import { McpHttpTransport } from "@/mcp/http-transport";
import { McpError, type McpJsonObject, type McpRequestOptions, type McpToolDefinition } from "@/mcp/types";
import type { ResolvedMcpServer } from "@/runtime/mcp-config";

type Entry = {
  server: ResolvedMcpServer;
  state: "connecting" | "ready" | "failed" | "draining" | "closed";
  client: McpClient;
  controller: AbortController;
  references: number;
  initialized: Promise<void>;
  tools: readonly McpToolDefinition[];
  refresh?: Promise<void>;
};
export type AuthorizedMcpConnectionInput = {
  readonly server: ResolvedMcpServer;
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
  readonly revalidate: (signal: AbortSignal) => Promise<void>;
};
export type McpConnectionLease = {
  readonly tools: readonly McpToolDefinition[];
  call(name: string, args: McpJsonObject, options: McpRequestOptions): ReturnType<McpClient["callTool"]>;
  release(): Promise<void>;
};
export class McpConnectionManager {
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  constructor(private readonly createClient = (server: ResolvedMcpServer) => new McpClient(server.config.type === "stdio"
    ? new McpStdioTransport({ ...server.config, cwd: server.workspaceRoot })
    : new McpHttpTransport(server.config))) {}
  async acquire(input: AuthorizedMcpConnectionInput): Promise<McpConnectionLease> {
    await input.revalidate(input.signal);
    if (input.signal.aborted || this.closed) throw new McpError("cancelled", "MCP 连接申请已取消。");
    const key = JSON.stringify([input.server.workspaceRoot, input.server.name, input.server.configurationId]);
    for (const [oldKey, old] of this.entries) {
      if (oldKey !== key && old.server.workspaceRoot === input.server.workspaceRoot && old.server.name === input.server.name) {
        old.state = "draining";
        if (!old.references) { await this.closeEntry(old); this.entries.delete(oldKey); }
      }
    }
    let entry = this.entries.get(key);
    if (entry?.state === "failed" || entry?.client.failed || entry?.state === "draining") throw new McpError("mcp-transport", "MCP Server 已不可用；修改配置或重新初始化应用后再试。");
    if (!entry) {
      if (this.entries.size >= 128) {
        const idle = [...this.entries].find(([, e]) => e.references === 0 && e.state === "ready");
        if (!idle) throw new McpError("limit-exceeded", "MCP 连接缓存已满。");
        await this.closeEntry(idle[1]); this.entries.delete(idle[0]);
      }
      const client = this.createClient(input.server);
      entry = { server: input.server, state: "connecting", client, controller: new AbortController(), references: 0, initialized: Promise.resolve(), tools: [] };
      const created = entry;
      created.initialized = (async () => {
        try {
          await client.initialize({ signal: created.controller.signal, deadlineMs: Math.min(input.deadlineMs, Date.now() + 10_000) });
          created.tools = await client.listTools({ signal: created.controller.signal, deadlineMs: Math.min(input.deadlineMs, Date.now() + 10_000) });
          if (created.state === "connecting") created.state = "ready";
        } catch {
          if (created.state !== "closed") created.state = "failed";
          await client.close();
          throw new McpError("mcp-transport", "MCP 握手或工具发现失败。");
        }
      })();
      this.entries.set(key, created);
    }
    const current = entry;
    current.references++;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      current.references--;
      if (!current.references && current.state === "draining") {
        await this.closeEntry(current);
        if (this.entries.get(key) === current) this.entries.delete(key);
      } else if (!current.references && current.state === "connecting") await this.closeEntry(current);
      if (!current.references && current.state === "failed") await current.client.close();
    };
    try {
      await waitFor(current.initialized, input.signal);
      await input.revalidate(input.signal);
      if (current.refresh || current.client.dirty) {
        current.refresh ??= (async () => {
          try { current.tools = await current.client.listTools({ signal: current.controller.signal, deadlineMs: Date.now() + 10_000 }); }
          catch { current.state = "failed"; throw new McpError("mcp-transport", "MCP 工具目录刷新失败。"); }
          finally { current.refresh = undefined; }
        })();
        await waitFor(current.refresh, input.signal);
      }
      if (current.state !== "ready") throw new McpError("mcp-transport", "MCP 连接不可用。");
      return {
        tools: current.tools,
        async call(name, args, options) {
          if (released || current.state !== "ready" || current.client.failed) throw new McpError("mcp-transport", "MCP 授权租约或连接已失效。");
          await input.revalidate(options.signal);
          return current.client.callTool(name, args, options);
        },
        release,
      };
    } catch (error) { await release(); throw error; }
  }
  async invalidate(workspaceRoot: string, serverName: string): Promise<void> {
    for (const entry of this.entries.values()) if (entry.server.workspaceRoot === workspaceRoot && entry.server.name === serverName) {
      entry.state = "draining";
      if (!entry.references) await this.closeEntry(entry);
    }
  }
  async reconcile(workspaceRoot: string, servers: readonly ResolvedMcpServer[]): Promise<void> {
    const configured = new Map(servers.map((server) => [server.name, server.configurationId]));
    for (const [key, entry] of this.entries) {
      if (entry.server.workspaceRoot !== workspaceRoot || configured.get(entry.server.name) === entry.server.configurationId) continue;
      entry.state = "draining";
      if (!entry.references) { await this.closeEntry(entry); this.entries.delete(key); }
    }
  }
  private async closeEntry(entry: Entry): Promise<void> {
    entry.state = "closed";
    entry.controller.abort();
    await entry.client.close();
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.entries.values()].map((entry) => this.closeEntry(entry)));
    this.entries.clear();
  }
}
async function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new McpError("cancelled", "MCP 等待已取消。");
  let abort = () => {};
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      abort = () => reject(new McpError("cancelled", "MCP 等待已取消。"));
      signal.addEventListener("abort", abort, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}
