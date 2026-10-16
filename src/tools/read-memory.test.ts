import { test } from "node:test";
import assert from "node:assert/strict";
import { createReadMemoryTool } from "./read-memory";
import { ToolRegistry } from "./registry";
import { createModeToolPolicy } from "./mode-policy";
test("记忆读取仅暴露只读工具，参数运行时校验", () => {
    const registry = new ToolRegistry([createReadMemoryTool(async () => { throw new Error("expired"); })]);
    const policy = createModeToolPolicy(registry, "plan");
    assert.equal(policy.classify("read_memory").kind, "allowed");
    assert.equal(policy.prepare("read_memory", { reference: "x", offset: -1, limit: 8001 }).kind, "failure");
    assert.equal(policy.prepare("read_memory", { reference: "memory://test", offset: 0, limit: 100 }).kind, "ready");
});
