import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import { startOpenAIMockServer } from "./openai-mock";
import { isObject } from "@/mcp/messages";

export async function configureMcpFixture(root: string, transport: "stdio" | "http") {
  const marker = path.join(root, "mcp-started");
  const callLog = path.join(root, "mcp-calls");
  const methods: string[] = [];
  const http = transport === "http" ? await startOpenAIMockServer((request) => {
    if (request.method === "GET" || request.method === "DELETE") return { status: 405 };
    const m = request.body;
    if (!isObject(m) || typeof m.method !== "string") return { status: 400 };
    methods.push(m.method);
    if (!("id" in m)) return { status: 202, chunks: [] };
    const text = isObject(m.params) && isObject(m.params.arguments) ? m.params.arguments.text : undefined;
    const result = m.method === "initialize"
      ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : m.method === "tools/list" ? { tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } }] }
      : { content: [{ type: "text", text: typeof text === "string" ? text : "http-result" }], ...(text === "fail" ? { isError: true } : {}) };
    return { headers: { "content-type": "application/json" }, chunks: [{ data: JSON.stringify({ jsonrpc: "2.0", id: m.id, result }), ...(text === "hang" ? { delayMs: 1000 } : {}) }] };
  }) : undefined;
  await mkdir(path.join(root, ".orbitcode"), { recursive: true });
  await writeFile(path.join(root, ".orbitcode/mcp.yaml"), stringify({ mcpServers: { demo: http
    ? { type: "http", url: http.baseUrl }
    : { type: "stdio", command: process.execPath, args: [path.resolve("tests/fixtures/mcp/stdio-server.mjs")], env: { MCP_MARKER: marker, MCP_CALL_LOG: callLog, MCP_TEST_SECRET: "MCP_SYNTHETIC_SECRET_9821" } } } }));
  return { marker, callLog, methods, httpUrl: http?.baseUrl, async close() { await http?.close(); } };
}
