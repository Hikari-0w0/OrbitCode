import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixture } from "../../tests/helpers/runtime-fixture";
import { configureMcpFixture } from "../../tests/helpers/mcp-fixture";
import { DONE_EVENT, TOOL_FINISH_EVENT, TRANSPORT_DONE_EVENT, textDelta, toolCallDelta } from "../../tests/helpers/openai-mock";
import { mcpToolName } from "@/tools/mcp-tool";

test("CLI 连接和工具调用无需审批，完整结果保存", async () => {
  let requests = 0;
  const fixture = await runtimeFixture(() => ({ chunks: [{ data: ++requests === 1
    ? toolCallDelta({ id: "mcp_cli", name: mcpToolName("demo", "echo"), argumentsJson: '{"text":"cli-ok"}' }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT
    : textDelta("CLI_MCP_DONE") + DONE_EVENT }] }), { terminal: true });
  const mcp = await configureMcpFixture(fixture.root, "stdio");
  try {
    await fixture.controller.handleLine("调用 MCP echo");
    assert.match(fixture.output(), /CLI_MCP_DONE/);
    assert.match(fixture.output(), /cli-ok/);
    assert.equal(fixture.errors(), "");
  } finally { await fixture.close(); await mcp.close(); }
});
