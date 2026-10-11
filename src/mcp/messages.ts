import { McpError, MCP_MAX_BYTES, type McpMessage, type McpJsonValue, type McpJsonObject } from "./types";

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function isJson(value: unknown, depth = 0, budget = { remaining: 100_000 }): value is McpJsonValue {
  if (--budget.remaining < 0 || depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJson(item, depth + 1, budget));
  return isObject(value) && Object.values(value).every((item) => isJson(item, depth + 1, budget));
}
export function isJsonObject(value: unknown): value is McpJsonObject {
  return isObject(value) && isJson(value);
}
export function protocolError(): McpError {
  return new McpError("mcp-protocol", "MCP 消息格式或能力不受支持。", true);
}
export function parseMessage(source: string): McpMessage {
  if (Buffer.byteLength(source) > MCP_MAX_BYTES) throw new McpError("limit-exceeded", "MCP 消息超过大小上限。", true);
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw protocolError(); }
  if (!isJsonObject(value) || value.jsonrpc !== "2.0") throw protocolError();
  const id = value.id;
  const validId = typeof id === "string" || (typeof id === "number" && Number.isSafeInteger(id));
  if (typeof value.method === "string" && value.method.length > 0) {
    if ("result" in value || "error" in value || ("params" in value && !isJsonObject(value.params))) throw protocolError();
    const params = isJsonObject(value.params) ? value.params : undefined;
    if (!("id" in value)) return { jsonrpc: "2.0", method: value.method, ...(params ? { params } : {}) };
    if (validId) return { jsonrpc: "2.0", id, method: value.method, ...(params ? { params } : {}) };
  }
  if (!validId || "method" in value || ("result" in value) === ("error" in value)) throw protocolError();
  if ("result" in value) return { jsonrpc: "2.0", id, result: value.result };
  if (!isObject(value.error) || !Number.isInteger(value.error.code) || typeof value.error.code !== "number" || typeof value.error.message !== "string") throw protocolError();
  return { jsonrpc: "2.0", id, error: { code: value.error.code, message: "MCP Server 返回协议错误。" } };
}
