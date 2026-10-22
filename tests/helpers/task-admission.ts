import type { AgentStart, TaskScope, TaskView } from "@/core/sub-agents/types";
import type { ChildTaskSpecification } from "@/core/sub-agents/task-contract";
import type { BackgroundTaskManager, TaskExecution } from "@/runtime/background-task-manager";

export function testTaskSpecification(task: AgentStart, maxIterations: number, maxRuntimeMs: number, access: "read-only" | "exclusive" = "exclusive"): ChildTaskSpecification {
  return { version: 1, task, requestBudget: { id: "test-group", limit: 128 }, provider: { id: "test", model: "test" }, workspace: { id: "test", access }, mode: "do",
    permissions: { parentMode: "default", roleMode: "default", rulesSha256: "test", dynamicRevocation: true }, tools: [], requiredExternalTools: [],
    context: { policy: task.kind === "fork" ? "admission-snapshot" : "none", messages: 0, serializedBytes: 2,
      sha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945", offloadedReferences: 0, containsSummary: false, promptContextSha256: "test", skills: [] },
    limits: { maxIterations, maxRuntimeMs }, delivery: { kind: "reply-and-tool-facts", acceptance: "independent-verification" } };
}

// 生命周期测试只关心准备/执行行为，统一在夹具边界构造完整规格。
export function startTestTask(manager: BackgroundTaskManager, input: {
  scope: TaskScope; turnId: string; callId: string; task: AgentStart; workspaceAccess?: TaskView["workspaceAccess"];
  maxIterations: number; maxRuntimeMs: number; signal: AbortSignal;
  prepare(id: string, deadlineAt: number, signal: AbortSignal): Promise<TaskExecution>;
}) {
  return manager.start({ scope: input.scope, turnId: input.turnId, callId: input.callId, signal: input.signal,
    specification: testTaskSpecification(input.task, input.maxIterations, input.maxRuntimeMs, input.workspaceAccess),
    prepare: (contract, signal) => input.prepare(contract.taskId, contract.deadlineAt, signal) });
}
