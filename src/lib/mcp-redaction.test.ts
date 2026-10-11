import assert from "node:assert/strict";
import test from "node:test";
import { createMcpRedactor, mcpDigest } from "./mcp-redaction";
test("MCP 已知秘密脱敏和稳定摘要", () => {
  const redact = createMcpRedactor(["fake-token"]);
  assert.equal(redact("Bearer fake-token / fake-token"), "Bearer <redacted> / <redacted>");
  assert.equal(mcpDigest({ a: 1, b: 2 }), mcpDigest({ b: 2, a: 1 }));
});
