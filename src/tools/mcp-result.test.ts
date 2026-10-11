import assert from "node:assert/strict";
import test from "node:test";
import { isJsonObject } from "@/mcp/messages";
import { convertMcpResult, mcpResultForModel } from "./mcp-result";
test("MCP 结果保留错误和结构化内容，媒体只留占位", () => {
  const result = convertMcpResult({ isError: true, content: [{ type: "text", text: "failed" }, { type: "image", data: "abc", mimeType: "image/png" }], structuredContent: { n: 1 } }, "server", "tool", (v) => v);
  assert.equal(result.ok, false);
  assert.equal(result.sideEffect, "possible");
  assert.ok(!JSON.stringify(result).includes('"data"'));
  assert.ok(JSON.stringify(result).includes("structuredContent"));
});

test("输出 Schema 的验证失败和不支持状态区分，返回链接不被读取", () => {
  const raw = { content: [{ type: "resource_link", uri: "https://example.invalid/resource" }], structuredContent: { n: 1 } };
  const valid = convertMcpResult(raw, "s", "t", v => v, { type: "object", properties: { n: { type: "integer" } }, required: ["n"] });
  assert.match(JSON.stringify(valid), /validated/); assert.ok(!JSON.stringify(valid).includes("https://example.invalid"));
  assert.equal(convertMcpResult(raw, "s", "t", v => v, { type: "object", properties: { n: { type: "string" } } }).ok, false);
  assert.match(JSON.stringify(convertMcpResult(raw, "s", "t", v => v, { type: "object", pattern: "x" })), /unsupported-schema/);
});

test("MCP 文本 JSON 标出本次返回数组长度，不把分页标记当成总数", () => {
  const result = convertMcpResult({ content: [{ type: "text", text: JSON.stringify({ items: Array.from({ length: 20 }, (_, index) => ({ id: index })), page: 1, hasMore: true }) }] }, "paotong", "search_articles", (value) => value);
  assert.equal(result.ok, true);
  assert.ok(isJsonObject(result.output));
  assert.deepEqual(result.output.arrayCounts, [{ source: "content[0].text", path: '$["items"]', count: 20 }]);
  assert.ok(JSON.stringify(result).includes("不代表服务端结果总数"));
});

test("仅完全重复的 MCP 文本从模型视图移除，独有文本和原始结果保留", () => {
  const structuredContent = { results: [{ url: "https://example.invalid/a", title: "A", text: "正文" }] };
  const duplicate = `<result>\n<url>https://example.invalid/a</url>\n<title>A</title>\n<text>\n正文\n</text>\n</result>`;
  const raw = convertMcpResult({ content: [{ type: "text", text: duplicate }, { type: "text", text: "额外说明" }], structuredContent }, "server", "search", (value) => value);
  const model = mcpResultForModel(raw);
  assert.ok(isJsonObject(raw.output));
  assert.ok(isJsonObject(model.output));
  assert.ok(Array.isArray(raw.output.content));
  assert.equal(raw.output.content.length, 2);
  assert.deepEqual(model.output.content, [{ type: "text", text: "额外说明" }]);
  assert.deepEqual(model.output.structuredContent, structuredContent);
});
