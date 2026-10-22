import type { AgentStopReason } from "@/core/agent-events";
import type { CompletionAssessment } from "@/core/completion-tracker";
import type { ModelUsageSummary } from "@/models/usage-tracker";
import type { PermissionMode } from "@/core/permissions/types";
import type { SideEffectState } from "@/tools/types";

export type SubAgentLimits = {
  readonly groupRequests: number;
  readonly groupTokens?: number;
  readonly perTurn: number;
  readonly capacity: number;
  readonly concurrency: number;
  readonly maxIterations: number;
  readonly maxRuntimeMinutes: number;
  readonly waitSeconds: number;
};
export const DEFAULT_SUB_AGENT_LIMITS: SubAgentLimits = Object.freeze({
  groupRequests: 128, groupTokens: 0, perTurn: 4, capacity: 32, concurrency: 2, maxIterations: 16, maxRuntimeMinutes: 5, waitSeconds: 30,
});
export function parseSubAgentLimits(value: unknown): SubAgentLimits {
  if (value === undefined) return DEFAULT_SUB_AGENT_LIMITS;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("子 Agent 配置必须是对象。");
  const limits = { groupRequests: 4096, groupTokens: 1_000_000_000, perTurn: 32, capacity: 256, concurrency: 8, maxIterations: 32, maxRuntimeMinutes: 1440, waitSeconds: 300 };
  const source: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  if (Object.keys(source).some(key => !(key in limits))) throw new Error("子 Agent 配置含未知字段。");
  const read = (key: keyof SubAgentLimits) => {
    const item = source[key] ?? DEFAULT_SUB_AGENT_LIMITS[key];
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item < (key === "groupTokens" ? 0 : 1) || item > limits[key]) throw new Error(`子 Agent 配置 ${key} 超出范围。`);
    return item;
  };
  const result = { groupRequests: read("groupRequests"), groupTokens: read("groupTokens"), perTurn: read("perTurn"), capacity: read("capacity"), concurrency: read("concurrency"), maxIterations: read("maxIterations"), maxRuntimeMinutes: read("maxRuntimeMinutes"), waitSeconds: read("waitSeconds") };
  if (result.concurrency > result.capacity) throw new Error("子并发不能超过任务容量。");
  return Object.freeze(result);
}
export type AgentRole = {
  readonly name: string;
  readonly description: string;
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly model: string;
  readonly maxIterations: number;
  readonly permissionMode: PermissionMode;
  readonly instructions: string;
};
export type AgentStart = (
  | { readonly kind: "defined"; readonly role: string; readonly prompt: string; readonly background: boolean }
  | { readonly kind: "fork"; readonly role?: string; readonly prompt: string; readonly background: true }) & { readonly output?: import("./output-contract").ChildOutputContract };
export type AgentToolRequest =
  | { readonly operation: "start"; readonly task: AgentStart }
  | { readonly operation: "status"; readonly taskId?: string }
  | { readonly operation: "wait"; readonly taskId: string; readonly timeoutMs?: number }
  | { readonly operation: "cancel"; readonly taskId: string }
  | { readonly operation: "verify"; readonly taskId: string }
  | { readonly operation: "result"; readonly taskId: string; readonly offset?: number; readonly limit?: number };
export type ChildReplyStorage =
  | { readonly status: "saved"; readonly byteLength: number; readonly characters: number; readonly sha256: string; readonly expiresAt: number }
  | { readonly status: "unavailable"; readonly reason: "capacity" | "storage" };
export type TaskScope = { readonly conversationId: string; readonly lifecycleEpoch: string };
export type ChildToolFailure = { readonly tool: string; readonly kind: string; readonly exitCode?: number | null; readonly timedOut?: boolean; readonly callId?: string; readonly iteration?: number; readonly targetFailureReason?: import("@/tools/target-failure-reason").TargetFailureReason };
export type ChildExecutionHandoff = {
  readonly reads?: {
    readonly files: readonly { readonly path: string; readonly callId: string; readonly sha256?: string; readonly byteLength?: number }[];
    readonly matches: readonly { readonly path: string; readonly line: number; readonly callId: string }[];
    readonly contextSearches?: readonly {
      readonly reference: string;
      readonly query: string;
      readonly callId: string;
      readonly matchCount: number;
      readonly totalCharacters: number;
      readonly complete: true;
    }[];
    readonly omitted: number;
  };
  // 仅兼容旧运行结果；新子执行不再生成模型报告调用统计。
  readonly completionReports?: {
    readonly attempts: number; readonly accepted: number; readonly rejected: number;
    readonly lastAttempt: "none" | "accepted" | "rejected";
  };
  readonly commandCalls: {
    readonly count: number; readonly succeeded: number; readonly failed: number; readonly omitted: number;
    readonly results: readonly { readonly callId?: string; readonly sequence: number; readonly ok: boolean; readonly errorKind?: string; readonly exitCode?: number | null; readonly timedOut?: boolean; readonly cancelled?: boolean }[];
  };
  readonly fileWrites: { readonly scope: "file-tool-results-only"; readonly paths: readonly string[]; readonly omitted: number };
};
export type ChildExecutionResult = {
  readonly outputContract?: import("./output-contract").ChildOutputContract;
  readonly timing?: import("./task-timing").TaskExecutionTiming;
  readonly replyStorage?: ChildReplyStorage;
  readonly replyTruncated?: boolean;
  readonly taskId: string;
  readonly stopReason: AgentStopReason;
  readonly terminationSource?: "user" | "runtime-close" | "parent-cleared";
  readonly finalReply?: string;
  readonly failureCount?: number;
  readonly handoff?: ChildExecutionHandoff;
  readonly failures: readonly ChildToolFailure[];
  readonly sideEffect: SideEffectState;
  readonly verification: CompletionAssessment;
  readonly usage: ModelUsageSummary;
  readonly cleanup: "complete" | "failed";
  readonly truncated: boolean;
  readonly evidenceRunId: string;
  readonly evidenceLog?: "saved" | "failed" | "unavailable";
};
export type TaskStopRequestReason = "cancelled" | "max-runtime" | "runtime-closed" | "parent-cleared";
export type TaskState =
  | { readonly status: "waiting-resources" }
  | { readonly status: "preparing" }
  | { readonly status: "queued" }
  | { readonly status: "running"; readonly startedAt: number }
  | { readonly status: "stopping"; readonly reason: TaskStopRequestReason }
  | { readonly status: "terminal"; readonly result: ChildExecutionResult };
export type TaskDelivery =
  | { readonly status: "pending" }
  | { readonly status: "staged"; readonly turnId: string }
  | { readonly status: "committed"; readonly revision: number }
  | { readonly status: "invalidated" };
export type TaskActivity = { readonly type: "created"|"started"|"waiting"|"detached"|"cancel-requested"|"terminal"|"staged"|"committed"|"invalidated"; readonly at:number };
export type TaskView = TaskScope & {
  readonly acceptance?: import("./output-contract").ChildOutputAssessment;
  readonly timing?: import("./task-timing").TaskExecutionTiming;
  readonly deliveryTiming?: import("./task-timing").TaskDeliveryTiming;
  readonly admission?: import("./task-contract").ChildTaskAdmissionSummary;
  readonly preparedContext?: import("./task-contract").PreparedChildContextManifest;
  readonly completionSequence?: number;
  readonly activity?: readonly TaskActivity[];
  readonly activityOmitted?: number;
  readonly id: string; readonly kind: AgentStart["kind"]; readonly role?: string;
  readonly createdAt: number; readonly deadlineAt: number; readonly background: boolean;
  readonly workspaceAccess?: "read-only" | "exclusive";
  readonly maxIterations: number; readonly state: TaskState; readonly delivery: TaskDelivery;
};
