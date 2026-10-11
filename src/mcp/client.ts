import { isJsonObject, isObject, protocolError } from "./messages";
import { McpRpcPeer } from "./rpc-peer";
import { MCP_VERSION, McpError, type McpCallResult, type McpJsonObject, type McpRequestOptions, type McpToolDefinition, type McpTransport } from "./types";

export class McpClient {
  readonly peer: McpRpcPeer;
  dirty = false;
  private initialized = false;
  constructor(transport: McpTransport) {
    this.peer = new McpRpcPeer(transport);
    this.peer.onNotification = (method) => { if (method === "notifications/tools/list_changed") this.dirty = true; };
  }
  get failed(): boolean { return this.peer.failed; }
  async initialize(options: McpRequestOptions): Promise<void> {
    await this.peer.start(options.signal);
    const result = await this.peer.request("initialize", { protocolVersion: MCP_VERSION, capabilities: {}, clientInfo: { name: "OrbitCode", version: "0.1.0" } }, options);
    if (!isObject(result) || result.protocolVersion !== MCP_VERSION || !isObject(result.capabilities) || !isObject(result.capabilities.tools) || !isObject(result.serverInfo) || typeof result.serverInfo.name !== "string" || typeof result.serverInfo.version !== "string") throw protocolError();
    await this.peer.notify("notifications/initialized");
    await this.peer.transport.openNotifications?.(options);
    this.initialized = true;
  }
  async listTools(options: McpRequestOptions): Promise<readonly McpToolDefinition[]> {
    if (!this.initialized) throw protocolError();
    const tools: McpToolDefinition[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    this.dirty = false;
    for (let page = 0; page < 32; page++) {
      const result = await this.peer.request("tools/list", cursor === undefined ? {} : { cursor }, options);
      if (!isObject(result) || !Array.isArray(result.tools)) throw protocolError();
      for (const raw of result.tools) {
        if (!isObject(raw) || typeof raw.name !== "string" || !raw.name || raw.name.length > 1024 || !isJsonObject(raw.inputSchema) || (raw.description !== undefined && typeof raw.description !== "string") || (raw.outputSchema !== undefined && !isJsonObject(raw.outputSchema))) throw protocolError();
        if (names.has(raw.name)) throw protocolError();
        names.add(raw.name);
        tools.push(Object.freeze({ name: raw.name, inputSchema: raw.inputSchema, ...(typeof raw.description === "string" ? { description: raw.description } : {}), ...(isJsonObject(raw.outputSchema) ? { outputSchema: raw.outputSchema } : {}), ...(isJsonObject(raw.annotations) ? { annotations: raw.annotations } : {}), ...(isJsonObject(raw.execution) ? { execution: raw.execution } : {}) }));
        if (tools.length > 128) throw new McpError("limit-exceeded", "MCP 工具数量超过上限。", true);
      }
      if (result.nextCursor === undefined) return Object.freeze(tools);
      if (typeof result.nextCursor !== "string" || !result.nextCursor || cursors.has(result.nextCursor)) throw protocolError();
      cursor = result.nextCursor; cursors.add(cursor);
    }
    throw new McpError("limit-exceeded", "MCP 工具分页超过上限。", true);
  }
  async callTool(name: string, argumentsValue: McpJsonObject, options: McpRequestOptions): Promise<McpCallResult> {
    if (!this.initialized) throw protocolError();
    const result = await this.peer.request("tools/call", { name, arguments: argumentsValue }, options);
    if (!isObject(result) || !Array.isArray(result.content) || !result.content.every(isJsonObject) || (result.isError !== undefined && typeof result.isError !== "boolean") || (result.structuredContent !== undefined && !isJsonObject(result.structuredContent))) {
      await this.close();
      throw protocolError();
    }
    return { content: result.content, ...(typeof result.isError === "boolean" ? { isError: result.isError } : {}), ...(isJsonObject(result.structuredContent) ? { structuredContent: result.structuredContent } : {}) };
  }
  close(): Promise<void> { return this.peer.close(); }
}
