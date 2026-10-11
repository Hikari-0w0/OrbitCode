import { parseMessage } from "./messages";
import { readSse } from "./sse";
import { MCP_MAX_BYTES, MCP_VERSION, McpError, type McpMessage, type McpRequestOptions, type McpTransport, type McpTransportHandlers } from "./types";

export class McpHttpTransport implements McpTransport {
  private handlers?: McpTransportHandlers;
  private sessionId?: string;
  private readonly controller = new AbortController();
  private closing?: Promise<void>;
  private notificationTask?: Promise<void>;
  constructor(private readonly options: { url: string; headers: Readonly<Record<string, string>> }) {}
  async start(handlers: McpTransportHandlers, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.controller.signal.aborted) throw new McpError("cancelled", "MCP 连接已取消。");
    this.handlers = handlers;
  }
  private headers(accept = "application/json, text/event-stream"): Headers {
    const headers = new Headers(this.options.headers);
    headers.set("Accept", accept);
    headers.set("Content-Type", "application/json");
    headers.set("MCP-Protocol-Version", MCP_VERSION);
    if (this.sessionId) headers.set("MCP-Session-Id", this.sessionId);
    return headers;
  }
  async send(message: McpMessage, signal: AbortSignal): Promise<void> {
    const combined = AbortSignal.any([signal, this.controller.signal]);
    const payload = JSON.stringify(message);
    if (Buffer.byteLength(payload) > MCP_MAX_BYTES) throw new McpError("limit-exceeded", "MCP 消息超过大小上限。");
    const response = await fetch(this.options.url, { method: "POST", headers: this.headers(), body: payload, signal: combined, redirect: "error" });
    const isRequest = "method" in message && "id" in message;
    if (!isRequest) {
      await response.body?.cancel();
      if (response.status !== 202) throw new McpError("mcp-transport", "MCP 通知未被接受。", true);
      return;
    }
    if (!response.ok) { await response.body?.cancel(); throw new McpError("mcp-transport", "MCP HTTP 请求失败或会话已失效。", true); }
    if (message.method === "initialize") {
      const id = response.headers.get("mcp-session-id");
      if (id !== null && (!/^[\x21-\x7e]+$/.test(id) || id.length > 4096)) {
        await response.body?.cancel(); throw new McpError("mcp-protocol", "MCP 会话标识无效。", true);
      }
      this.sessionId = id ?? undefined;
    }
    const contentType = response.headers.get("content-type")?.split(";")[0].trim();
    if (contentType === "application/json") {
      const parsed = parseMessage(await readJsonBody(response));
      if (!("id" in parsed) || "method" in parsed || parsed.id !== message.id) throw new McpError("mcp-protocol", "MCP HTTP 响应 id 不匹配。", true);
      this.handlers?.message(parsed);
      return;
    }
    if (contentType !== "text/event-stream" || !response.body) { await response.body?.cancel(); throw new McpError("mcp-protocol", "MCP HTTP 响应类型无效。", true); }
    for await (const source of readSse(response.body, combined)) {
      const parsed = parseMessage(source);
      if (!("method" in parsed)) {
        if (parsed.id !== message.id) continue;
        this.handlers?.message(parsed);
        return;
      }
      this.handlers?.message(parsed);
    }
    if (!combined.aborted) throw new McpError("mcp-transport", "MCP 响应流提前结束。", true);
  }
  async openNotifications(options: McpRequestOptions): Promise<void> {
    const establishment = new AbortController();
    const cancel = () => establishment.abort();
    if (options.signal.aborted) cancel();
    options.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, Math.max(0, Math.min(10_000, options.deadlineMs - Date.now())));
    let response: Response;
    try {
      response = await fetch(this.options.url, { method: "GET", headers: this.headers("text/event-stream"), signal: AbortSignal.any([this.controller.signal, establishment.signal]), redirect: "error" });
    } finally { clearTimeout(timer); options.signal.removeEventListener("abort", cancel); }
    if (response.status === 405) { await response.body?.cancel(); return; }
    if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== "text/event-stream" || !response.body) {
      await response.body?.cancel(); throw new McpError("mcp-transport", "MCP 通知流无法建立。", true);
    }
    const body = response.body;
    this.notificationTask = (async () => {
      try {
        for await (const source of readSse(body, this.controller.signal)) {
          const message = parseMessage(source);
          if (!("method" in message)) throw new McpError("mcp-protocol", "MCP 独立通知流包含无关响应。", true);
          this.handlers?.message(message);
        }
        if (!this.controller.signal.aborted) throw new McpError("mcp-transport", "MCP 通知流已断开。", true);
      } catch {
        if (!this.controller.signal.aborted) this.handlers?.closed(new McpError("mcp-transport", "MCP 通知流已断开。", true));
      }
    })();
  }
  close(): Promise<void> {
    this.closing ??= this.dispose();
    return this.closing;
  }
  private async dispose(): Promise<void> {
    this.controller.abort();
    if (this.sessionId) {
      try {
        const response = await fetch(this.options.url, { method: "DELETE", headers: this.headers(), signal: AbortSignal.timeout(1000), redirect: "error" });
        await response.body?.cancel();
      } catch { /* 关闭仍需完成，即使服务端不支持会话终止。 */ }
    }
    await this.notificationTask;
  }
}
async function readJsonBody(response: Response): Promise<string> {
  if (!response.body) throw new McpError("mcp-protocol", "MCP 响应为空。", true);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MCP_MAX_BYTES) throw new McpError("limit-exceeded", "MCP 响应超过大小上限。", true);
      chunks.push(next.value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
