import { McpError, type McpId, type McpJsonObject, type McpJsonValue, type McpMessage, type McpRequestOptions, type McpTransport } from "./types";

type Pending = { resolve(value: McpJsonValue): void; reject(error: McpError): void };
export class McpRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<McpId, Pending>();
  private failure?: McpError;
  onNotification: (method: string, params?: McpJsonObject) => void = () => {};
  constructor(readonly transport: McpTransport) {}
  get failed(): boolean { return this.failure !== undefined; }
  get pendingCount(): number { return this.pending.size; }
  async start(signal: AbortSignal): Promise<void> {
    try { await this.transport.start({ message: (m) => this.receive(m), closed: (e) => this.fail(e) }, signal); }
    catch { this.fail(new McpError("mcp-transport", "无法启动 MCP 连接。")); throw this.failure; }
  }
  request(method: string, params: McpJsonObject, options: McpRequestOptions): Promise<McpJsonValue> {
    if (this.failure) return Promise.reject(this.failure);
    if (options.signal.aborted) return Promise.reject(new McpError("cancelled", "MCP 请求已取消。"));
    if (options.deadlineMs <= Date.now()) return Promise.reject(new McpError("timeout", "MCP 请求超时。"));
    if (this.pending.size >= 32 || !Number.isSafeInteger(this.nextId)) return Promise.reject(new McpError("limit-exceeded", "MCP 待处理请求达到上限。"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let sent = false;
      const finish = (value?: McpJsonValue, error?: McpError) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        options.signal.removeEventListener("abort", cancel);
        controller.abort();
        if (error) reject(error); else resolve(value ?? null);
      };
      const interrupt = (kind: "timeout" | "cancelled") => {
        if (!this.pending.has(id)) return;
        finish(undefined, new McpError(kind, kind === "timeout" ? "MCP 请求超时。" : "MCP 请求已取消。", sent));
        if (method === "initialize") { void this.close(); }
        else if (sent) void this.notify("notifications/cancelled", { requestId: id }).catch(() => undefined);
      };
      const cancel = () => interrupt("cancelled");
      const timer = setTimeout(() => interrupt("timeout"), options.deadlineMs - Date.now());
      this.pending.set(id, { resolve: (value) => finish(value), reject: (error) => finish(undefined, error) });
      options.signal.addEventListener("abort", cancel, { once: true });
      if (options.signal.aborted) { cancel(); return; }
      sent = true;
      void this.transport.send({ jsonrpc: "2.0", id, method, params }, controller.signal).catch((error: unknown) => {
        if (this.pending.has(id)) this.fail(error instanceof McpError ? error : new McpError("mcp-transport", "MCP 传输失败。", true));
      });
    });
  }
  async notify(method: string, params?: McpJsonObject): Promise<void> {
    if (this.failure) throw this.failure;
    await this.transport.send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }, AbortSignal.timeout(1000));
  }
  private receive(message: McpMessage): void {
    if (this.failure) return;
    if ("method" in message) {
      if (!("id" in message)) { this.onNotification(message.method, message.params); return; }
      const response: McpMessage = message.method === "ping"
        ? { jsonrpc: "2.0", id: message.id, result: {} }
        : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } };
      void this.transport.send(response, AbortSignal.timeout(1000)).catch(() => this.fail(new McpError("mcp-transport", "MCP 响应发送失败。", true)));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if ("error" in message) pending.reject(new McpError("mcp-protocol", "MCP Server 返回协议错误。", true));
    else pending.resolve(message.result);
  }
  private fail(error: McpError): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    void this.transport.close();
  }
  async close(): Promise<void> {
    this.fail(new McpError("mcp-transport", "MCP 连接已关闭。", true));
    await this.transport.close();
  }
}
