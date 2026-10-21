import type { AgentMode } from "@/core/agent-events";
import type { PermissionMode } from "@/core/permissions/types";
import type { AgentStart, TaskScope } from "./types";

export type ChildContextManifest = {
  readonly policy: "none" | "admission-snapshot";
  readonly messages: number;
  readonly serializedBytes: number;
  readonly sha256: string;
  readonly offloadedReferences: number;
  readonly containsSummary: boolean;
  readonly promptContextSha256: string;
  readonly skills: readonly { readonly name: string; readonly definitionHash: string; readonly activationSha256: string }[];
};

// 只记录可审阅的执行约束；凭据、完整历史和权限审批通道由运行时单独持有。
export type ChildTaskSpecification = {
  readonly version: 1;
  readonly task: AgentStart;
  readonly requestBudget: { readonly id: string; readonly limit: number; readonly tokenLimit?: number };
  readonly output?: import("./output-contract").ChildOutputContract;
  readonly provider: { readonly id: string; readonly model: string };
  readonly workspace: { readonly id: string; readonly access: "read-only" | "exclusive" };
  readonly mode: AgentMode;
  readonly permissions: { readonly parentMode: PermissionMode; readonly roleMode: PermissionMode; readonly rulesSha256: string; readonly dynamicRevocation: true };
  readonly tools: readonly string[];
  readonly requiredExternalTools: readonly string[];
  readonly role?: { readonly name: string; readonly sha256: string };
  readonly context: ChildContextManifest;
  readonly limits: { readonly maxIterations: number; readonly maxRuntimeMs: number };
  readonly delivery: { readonly kind: "reply-and-tool-facts"; readonly acceptance: "independent-verification" };
};

export type ChildTaskContract = {
  readonly version: 1;
  readonly taskId: string;
  readonly scope: TaskScope;
  readonly turnId: string;
  readonly callId: string;
  readonly createdAt: number;
  readonly deadlineAt: number;
  readonly specification: ChildTaskSpecification;
};

export type ChildTaskAdmissionSummary = Omit<ChildTaskSpecification, "task">;

export type PreparedChildContextManifest = {
  readonly version: 1;
  readonly sourceSha256: string;
  readonly messages: number;
  readonly serializedBytes: number;
  readonly sha256: string;
  readonly copiedReferences: number;
  readonly copiedBytes: number;
  readonly references: readonly { readonly source: string; readonly destination: string; readonly byteLength: number; readonly sha256: string }[];
  readonly referencesOmitted: number;
};
