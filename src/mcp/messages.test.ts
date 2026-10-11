import assert from "node:assert/strict";
import test from "node:test";
import { parseMessage } from "./messages";
test("MCP 区分请求、通知、响应和 id 类型", () => {
  for (const message of [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: "1", result: {} },
  ]) assert.deepEqual(parseMessage(JSON.stringify(message)), message);
});
test("MCP 拒绝畸形和过量消息，不回显载荷", () => {
  for (const value of [[], { jsonrpc: "2.0", id: null, result: {} }, { jsonrpc: "2.0", id: 1, result: {}, error: {} }, { jsonrpc: "2.0", id: 1, method: "x", result: {} }]) {
    assert.throws(() => parseMessage(JSON.stringify(value)), /MCP/);
  }
  assert.throws(() => parseMessage("FAKE_SECRET"), (e: Error) => !e.message.includes("FAKE_SECRET"));
  assert.throws(() => parseMessage("x".repeat(2 * 1024 * 1024 + 1)), /上限/);
});
