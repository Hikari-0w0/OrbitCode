import test from "node:test";
import assert from "node:assert/strict";
import type { AgentStart } from "@/core/sub-agents/types";
import { DEFAULT_SUB_AGENT_LIMITS } from "@/core/sub-agents/types";
import type { ManagedContextMessage } from "@/core/context/types";
import { createChildTaskPlan } from "./task-plan";
import { createDefaultToolRegistry } from "@/tools/default-registry";
const registry = createDefaultToolRegistry({ probe: async () => ({ available: true }), run: async () => { throw new Error("测试不执行命令"); } });

function input(task: AgentStart = { kind: "fork", prompt: "原任务", background: true }) {
  return { task, requestBudget: { id: "test-group", limit: 128 },
    role: { name: "reader", description: "测试角色", instructions: "原角色指令", allowedTools: ["read_file"], disallowedTools: ["agent"], model: "inherit", maxIterations: 3, permissionMode: "default" as const },
    config: { name: "provider", protocol: "openai" as const, model: "test", baseUrl: "http://localhost", apiKeyEnvironmentVariable: "TEST_KEY", apiKey: "synthetic-contract-secret",
      context: { windowTokens: 128000, singleToolResultTokens: 8000, toolResultGroupTokens: 12000, recentMessagesTokens: 10000, automaticReserveTokens: 13000, manualReserveTokens: 3000, previewChars: 2000 } },
    workspace: { root: "/workspace" }, parentTools: new Set(["agent", "read_file", "write_file"]),
    descriptors: registry.descriptors(),
    history: [{ kind: "user", content: "原历史" }] as ManagedContextMessage[], activeSkills: [], limits: DEFAULT_SUB_AGENT_LIMITS,
    parentIterations: 8, parentRuntimeMs: 10000, mode: "do" as const, parentPermissionMode: "permissive" as const, rules: [], optional: { customInstructions: "原系统约束" },
    environment: { workspace: { id: "workspace", name: "test" }, platform: "test", currentDate: "2026-10-21", timeZone: "UTC", pathSemantics: "workspace-relative-posix" as const } };
}

test("接纳计划复制冻结全部数据；源集合、角色、配置和历史变化不会更换执行输入", () => {
  const source = input(), plan = createChildTaskPlan(source);
  const originalHash = plan.specification.context.sha256;
  source.parentTools.add("run_command"); source.role.allowedTools.push("write_file"); source.role.instructions = "新角色";
  source.config.context.windowTokens = 999999; source.config.model = "new-model";
  source.history.push({ kind: "user", content: "后到历史" }); source.optional.customInstructions = "新约束";
  assert.deepEqual(plan.specification.tools, ["read_file"]); assert.equal(plan.specification.workspace.access, "read-only");
  assert.equal(plan.role?.instructions, "原角色指令"); assert.equal(plan.config.model, "test"); assert.equal(plan.config.context.windowTokens, 128000);
  assert.equal(plan.history.length, 1); assert.equal(plan.specification.context.sha256, originalHash); assert.equal(plan.optional.customInstructions, "原系统约束");
  assert.ok(Object.isFrozen(plan.config.context)); assert.ok(Object.isFrozen(plan.role?.allowedTools)); assert.ok(Object.isFrozen(plan.history[0]));
  assert.equal(JSON.stringify(plan.specification).includes(source.config.apiKey), false);
  assert.equal(plan.specification.limits.maxIterations, 3); assert.equal(plan.specification.limits.maxRuntimeMs, 10000);
});

test("defined不继承历史；Fork清单准确标出摘要、引用、字节与角色版本", () => {
  const source = input(); source.history.push({ kind: "summary", summary: { taskGoals: ["旧历史已压缩"], completedWork: [], keyDecisions: [], fileChanges: [], toolResults: [], errors: [], nextSteps: [] } });
  const fork = createChildTaskPlan(source), defined = createChildTaskPlan({ ...source, task: { kind: "defined", role: "reader", prompt: "自包含任务", background: false } });
  assert.equal(fork.specification.context.messages, 2); assert.equal(fork.specification.context.containsSummary, true);
  assert.equal(fork.specification.context.serializedBytes, Buffer.byteLength(JSON.stringify(source.history)));
  assert.equal(defined.history.length, 0); assert.equal(defined.specification.context.policy, "none"); assert.equal(defined.specification.context.messages, 0);
  source.role.instructions = "修订角色";
  assert.notEqual(createChildTaskPlan(source).specification.role?.sha256, fork.specification.role?.sha256);
});

test("有效能力一致决定工具、MCP必需集合与工作区访问，角色禁止优先", () => {
  const source = input(); source.parentTools.add("mcp__missing"); source.role.allowedTools.push("mcp__missing"); source.role.disallowedTools.push("mcp__missing");
  const denied = createChildTaskPlan(source); assert.deepEqual(denied.specification.requiredExternalTools, []); assert.equal(denied.specification.workspace.access, "read-only");
  source.role.disallowedTools.pop(); const required = createChildTaskPlan(source);
  assert.deepEqual(required.specification.requiredExternalTools, ["mcp__missing"]); assert.equal(required.specification.workspace.access, "exclusive");
  const inherited = createChildTaskPlan({ ...source, role: undefined }); assert.deepEqual(inherited.specification.requiredExternalTools, []);
  assert.ok(!inherited.specification.tools.includes("agent"));
  source.parentTools.delete("mcp__missing"); assert.throws(() => createChildTaskPlan(source), /MCP 工具未发现/);
});
