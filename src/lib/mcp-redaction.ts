import { createHash } from "node:crypto";
import { isJsonObject } from "@/mcp/messages";
import type { McpJsonValue } from "@/mcp/types";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export function mcpDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
export function createMcpRedactor(secrets: readonly string[]): (text: string) => string {
  const values = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  return (text) => {
    for (const value of values) text = text.split(value).join("<redacted>");
    return text.replace(/\bBearer\s+[^\s"<>]+/giu, "Bearer <redacted>");
  };
}

export function redactMcpJson(value: McpJsonValue, redact: (text: string) => string): McpJsonValue {
  // 在 JSON 转义前处理字符串及键，避免带引号、换行的凭据逃过文本匹配。
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactMcpJson(item, redact));
  if (isJsonObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redactMcpJson(item, redact)]));
  return value;
}
