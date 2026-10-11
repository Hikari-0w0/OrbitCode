import { createInterface } from "node:readline";
import { appendFileSync, writeFileSync } from "node:fs";
if (process.env.MCP_MARKER) writeFileSync(process.env.MCP_MARKER, String(process.pid));
if (process.env.MCP_IGNORE_TERM) process.on("SIGTERM", () => {});
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
createInterface({ input: process.stdin }).on("line", (source) => {
  const message = JSON.parse(source);
  if (process.env.MCP_CALL_LOG) appendFileSync(process.env.MCP_CALL_LOG, JSON.stringify({ method: message.method, id: message.id }) + "\n");
  if (message.method === "initialize") send(message.id, { protocolVersion: "2025-11-25", serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: { listChanged: true } } });
  if (message.method === "tools/list") send(message.id, { tools: [{ name: "echo", description: "Return supplied text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } }] });
  if (message.method === "tools/call") {
    const text = message.params.arguments.text;
    if (text === "hang") return;
    if (text === "exit") process.exit(1);
    if (text === "malformed") { process.stdout.write("not-json\n"); return; }
    if (text === "duplicate-structured") {
      const result = { url: "https://example.invalid/doc", title: "Example", text: "UNIQUE_BODY_MARKER" };
      send(message.id, {
        content: [{ type: "text", text: `<result>\n<url>${result.url}</url>\n<title>${result.title}</title>\n<text>\n${result.text}\n</text>\n</result>` }],
        structuredContent: { results: [result] },
      });
      return;
    }
    send(message.id, { content: [{ type: "text", text: text === "large-secret" ? `${process.env.MCP_TEST_SECRET} SAFE_MARKER ${"x".repeat(20000)}` : text }], ...(text === "fail" ? { isError: true } : {}) });
  }
});
