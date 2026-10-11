import { isJsonObject } from "@/mcp/messages";
import { isDeepStrictEqual } from "node:util";
import { redactMcpJson } from "@/lib/mcp-redaction";
import type { McpCallResult } from "@/mcp/types";
import { emptyResultMeta, type JsonValue, type ToolExecutionResult } from "@/tools/types";
import { compileMcpSchema } from "@/tools/mcp-json-schema";

export function convertMcpResult(result: McpCallResult, serverName: string, toolName: string, redact: (text: string) => string, outputSchema?: unknown): ToolExecutionResult {
  const content: JsonValue[] = result.content.map((item): JsonValue => {
    if (item.type === "text" && typeof item.text === "string") return { type: "text", text: redact(item.text) };
    if (item.type === "resource" && isJsonObject(item.resource) && typeof item.resource.text === "string") return { type: "text", text: redact(item.resource.text), source: "embedded-resource" };
    return { type: typeof item.type === "string" ? redact(item.type) : "unknown", mimeType: typeof item.mimeType === "string" ? redact(item.mimeType) : null, size: typeof item.data === "string" ? item.data.length : 0, detail: "此内容未展示，也未自动读取链接。" };
  });
  let outputValidation = "not-provided";
  if (outputSchema !== undefined) {
    try {
      const schema = compileMcpSchema(outputSchema);
      if (!schema.parse(result.structuredContent).ok) return { ok: false, error: { kind: "mcp-protocol", message: "MCP 结构化结果不符合输出 Schema。", retryable: false }, sideEffect: "possible", meta: emptyResultMeta() };
      outputValidation = "validated";
    } catch { outputValidation = "unsupported-schema"; }
  }
  const arrayCounts = countJsonArrays(content);
  const output = { serverName, toolName: redact(toolName),
    ...(arrayCounts.length ? { arrayCounts, arrayCountsNote: "仅表示本次返回的数组长度，不代表服务端结果总数。" } : {}),
    content,
    ...(result.structuredContent ? { structuredContent: redactMcpJson(result.structuredContent, redact) } : {}), outputValidation };
  return result.isError
    ? { ok: false, error: { kind: "mcp-tool-error", message: "MCP 工具返回执行错误，请根据结果调整请求。", retryable: true }, output, sideEffect: "possible", meta: emptyResultMeta() }
    : { ok: true, output, sideEffect: "possible", meta: emptyResultMeta() };
}

export function mcpResultForModel(result: ToolExecutionResult): ToolExecutionResult {
  // 原始事件保留两种表示；仅缩减发给模型的可证明重复内容。
  if (!isJsonObject(result.output) || !Array.isArray(result.output.content) || !isJsonObject(result.output.structuredContent)) return result;
  const structured = result.output.structuredContent;
  const content = result.output.content.filter((item) =>
    !isJsonObject(item) || item.type !== "text" || typeof item.text !== "string" || !duplicatesStructuredContent(item.text, structured));
  if (content.length === result.output.content.length) return result;
  return { ...result, output: { ...result.output, content } };
}

function duplicatesStructuredContent(text: string, structured: Record<string, unknown>): boolean {
  try {
    if (isDeepStrictEqual(JSON.parse(text), structured)) return true;
  } catch { /* 文本结果不一定是 JSON。 */ }
  if (!Array.isArray(structured.results) || structured.results.length === 0) return false;
  const rendered: string[] = [];
  for (const item of structured.results) {
    if (!isJsonObject(item) || typeof item.url !== "string" || typeof item.title !== "string" || typeof item.text !== "string") return false;
    rendered.push(`<result>\n<url>${item.url}</url>\n<title>${item.title}</title>\n<text>\n${item.text}\n</text>\n</result>`);
  }
  return text === rendered.join("\n");
}

function countJsonArrays(content: readonly JsonValue[]): { source: string; path: string; count: number }[] {
  const counts: { source: string; path: string; count: number }[] = [];
  for (const [index, item] of content.entries()) {
    if (!isJsonObject(item) || item.type !== "text" || typeof item.text !== "string" || item.text.length > 256 * 1024) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(item.text); } catch { continue; }
    const visit = (value: unknown, path: string, depth: number): void => {
      if (counts.length >= 16) return;
      if (Array.isArray(value)) { counts.push({ source: `content[${index}].text`, path, count: value.length }); return; }
      if (depth >= 2 || !isJsonObject(value)) return;
      for (const [key, child] of Object.entries(value)) {
        if (counts.length >= 16) break;
        if (Array.isArray(child) || isJsonObject(child)) visit(child, `${path}[${JSON.stringify(key)}]`, depth + 1);
      }
    };
    visit(parsed, "$", 0);
  }
  return counts;
}
