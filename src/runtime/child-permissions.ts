import type { AgentMode } from "@/core/agent-events";
import type { PermissionMode, PermissionRule } from "@/core/permissions/types";
import { evaluatePermission } from "@/core/permissions/evaluator";
import { PermissionGateway } from "@/tools/permission-gateway";
import type { WorkspaceBoundary } from "@/tools/types";

export function createChildPermissions(input: {
  readonly workspace: WorkspaceBoundary;
  readonly mode: AgentMode;
  readonly parentMode: PermissionMode;
  readonly roleMode: PermissionMode;
  readonly rules: readonly PermissionRule[];
  readonly current: () => Promise<{ mode: PermissionMode; rules: readonly PermissionRule[]; agentMode?: AgentMode }>;
}) {
  const gateway = new PermissionGateway({
    agentMode: input.mode,
    permissionMode: input.roleMode,
    workspace: input.workspace,
    loadRules: async () => [],
    additionalEvaluations: async subject => {
      const current = await input.current();
      const parent = [
        evaluatePermission({ subject, mode: input.parentMode, rules: input.rules }),
        evaluatePermission({ subject, mode: current.mode, rules: current.rules }),
      ];
      if (current.agentMode === "plan" && subject.toolKind !== "read") parent.push({
        kind: "deny", errorKind: "permission-denied",
        reason: { source: "mode", risk: "low", mode: "strict", message: "父会话已进入 Plan，子操作被拒绝。" },
      });
      return parent;
    },
  });
  return { gateway };
}
