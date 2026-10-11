import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixture, waitUntil } from "../../tests/helpers/runtime-fixture";
import { configureMcpFixture } from "../../tests/helpers/mcp-fixture";
import { DONE_EVENT, TOOL_FINISH_EVENT, TRANSPORT_DONE_EVENT, textDelta, toolCallDelta } from "../../tests/helpers/openai-mock";
import { mcpToolName } from "@/tools/mcp-tool";

test("CLI 连接和工具审批复用终端 approve，完整结果保存", async () => {
  let requests = 0;
  const fixture = await runtimeFixture(() => ({ chunks: [{ data: ++requests === 1
    ? toolCallDelta({ id: "mcp_cli", name: mcpToolName("demo", "echo"), argumentsJson: '{"text":"cli-ok"}' }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT
    : textDelta("CLI_MCP_DONE") + DONE_EVENT }] }), { terminal: true });
  const mcp = await configureMcpFixture(fixture.root, "stdio");
  try {
    const running = fixture.controller.handleLine("调用 MCP echo");
    for (let count = 1; count <= 2; count++) {
      await waitUntil(() => [...fixture.output().matchAll(/\/approve ([\w-]+) </g)].length >= count);
      const id = [...fixture.output().matchAll(/\/approve ([\w-]+) </g)][count - 1][1];
      await fixture.controller.handleLine(`/approve ${id} once`);
    }
    await running;
    assert.match(fixture.output(), /CLI_MCP_DONE/);
    assert.match(fixture.output(), /cli-ok/);
    assert.equal(fixture.errors(), "");
  } finally { await fixture.close(); await mcp.close(); }
});
