import assert from "node:assert/strict";
import test from "node:test";
import { createMcpTool, mcpToolName } from "./mcp-tool";
test("命名隔离且参数无效时不产生可执行调用", () => {
  assert.notEqual(mcpToolName("a", "echo"), mcpToolName("b", "echo"));
  assert.ok(mcpToolName("a".repeat(100), "b".repeat(100)).length <= 64);
  const tool = createMcpTool({ name: "echo", inputSchema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] } }, { serverName: "test", configurationId: "c", redact: (v) => v, revalidate: async () => undefined, call: async () => { throw new Error("未授权不应执行"); } });
  assert.equal(tool.mutability, "external");
  assert.equal(tool.prepareUnknown({ n: "1" }).kind, "failure");
  assert.equal(tool.prepareUnknown({ n: 1 }).kind, "ready");
});

test("包含 JSON 转义字符的秘密不会进入 Schema 或审批摘要", async () => {
  const { createMcpRedactor } = await import("@/lib/mcp-redaction");
  const secret = 'quoted"secret\nvalue';
  const binding = { serverName: "s", configurationId: "c", redact: createMcpRedactor([secret]), revalidate: async () => undefined, call: async () => ({content:[]}) };
  assert.throws(() => createMcpTool({name:"echo",inputSchema:{type:"object",description:secret}},binding),/秘密/);
  const tool=createMcpTool({name:"echo",inputSchema:{type:"object"}},binding);
  const prepared=tool.prepareUnknown({text:secret});assert.equal(prepared.kind,"ready");
  if(prepared.kind==="ready" && prepared.call.permissionTarget.kind==="mcp") {
    assert.deepEqual(JSON.parse(String(prepared.call.permissionTarget.summary.arguments)), {text:"<redacted>"});
  }
});
