import { createHash } from "node:crypto";
import type { AgentMode } from "@/core/agent-events";
import type { ManagedContextMessage } from "@/core/context/types";
import type { PermissionMode, PermissionRule } from "@/core/permissions/types";
import type { ActivatedSkill } from "@/core/skills/types";
import type { OptionalPromptContext, PromptEnvironment } from "@/core/system-prompt/types";
import type { ChildTaskSpecification } from "@/core/sub-agents/task-contract";
import type { AgentRole, AgentStart, SubAgentLimits } from "@/core/sub-agents/types";
import type { ResolvedProviderConfig } from "@/models/config";
import type { ToolDescriptor } from "@/tools/registry";
import type { WorkspaceBoundary } from "@/tools/types";
import { childWorkspaceAccess } from "./workspace-policy";
import { childToolNames } from "@/tools/child-tool-policy";
import { immutableSnapshot } from "@/lib/immutable-snapshot";

export function createChildTaskPlan(input: {
  readonly task: AgentStart;
  readonly requestBudget: { readonly id: string; readonly limit: number; readonly tokenLimit?: number };
  readonly role?: AgentRole;
  readonly config: ResolvedProviderConfig;
  readonly workspace: Pick<WorkspaceBoundary, "root">;
  readonly parentTools: ReadonlySet<string>;
  readonly descriptors: readonly ToolDescriptor[];
  readonly history: readonly ManagedContextMessage[];
  readonly activeSkills: readonly ActivatedSkill[];
  readonly limits: SubAgentLimits;
  readonly parentIterations: number;
  readonly parentRuntimeMs: number;
  readonly mode: AgentMode;
  readonly parentPermissionMode: PermissionMode;
  readonly rules: readonly PermissionRule[];
  readonly optional: OptionalPromptContext;
  readonly environment: PromptEnvironment;
}) {
  for (const name of input.role?.allowedTools ?? []) {
    if (name.startsWith("mcp__") && !input.role?.disallowedTools.includes(name) && !input.parentTools.has(name)) throw new Error("角色所需 MCP 工具未发现或父级不允许。");
  }
  const tools = [...childToolNames(input.parentTools, input.role)].sort();
  const history = input.task.kind === "fork" ? input.history : [];
  const inheritedSkills = input.task.kind === "fork" ? input.activeSkills : [];
  const serialized = JSON.stringify(history);
  const specification: ChildTaskSpecification = {
    version: 1, task: input.task, requestBudget: { id: input.requestBudget.id, limit: input.requestBudget.limit, ...(input.requestBudget.tokenLimit ? { tokenLimit: input.requestBudget.tokenLimit } : {}) },
    ...(input.task.output ? { output: input.task.output } : {}),
    provider: { id: input.config.name, model: input.config.model },
    workspace: { id: input.environment.workspace.id, access: childWorkspaceAccess(new Set(tools), input.descriptors) },
    mode: input.mode, permissions: { parentMode: input.parentPermissionMode, roleMode: input.role?.permissionMode ?? input.parentPermissionMode, rulesSha256: digest(JSON.stringify(input.rules)), dynamicRevocation: true }, tools,
    requiredExternalTools: input.role ? tools.filter(name => name.startsWith("mcp__")) : [],
    ...(input.role ? { role: { name: input.role.name, sha256: digest(JSON.stringify(input.role)) } } : {}),
    context: { policy: input.task.kind === "fork" ? "admission-snapshot" : "none", messages: history.length,
      serializedBytes: Buffer.byteLength(serialized), sha256: digest(serialized),
      offloadedReferences: new Set(history.flatMap(message => message.kind === "tool-result" && message.payload.storage === "offloaded" ? [message.payload.reference] : [])).size,
      containsSummary: history.some(message => message.kind === "summary"),
      promptContextSha256: digest(JSON.stringify({ optional: input.optional, environment: input.environment })),
      skills: inheritedSkills.map(skill => ({ name: skill.definition.name, definitionHash: skill.definitionHash, activationSha256: digest(JSON.stringify(skill)) })) },
    limits: { maxIterations: Math.min(input.limits.maxIterations, input.parentIterations, input.role?.maxIterations ?? 32),
      maxRuntimeMs: Math.min(input.limits.maxRuntimeMinutes * 60000, input.parentRuntimeMs) },
    delivery: { kind: "reply-and-tool-facts", acceptance: "independent-verification" },
  };
  // 集合转为数据数组后再复制冻结，避免 ReadonlySet 仅提供类型约束、底层仍可变。
  return immutableSnapshot({ specification, config: input.config, workspaceRoot: input.workspace.root,
    role: input.role, history, inheritedSkills, rules: input.rules,
    optional: input.optional, environment: input.environment });
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
