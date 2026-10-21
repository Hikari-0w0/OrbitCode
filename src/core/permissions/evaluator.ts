import {
  permissionRisk,
  type PermissionDecision,
  type PermissionEvaluation,
  type PermissionMode,
  type PermissionSubject,
} from "@/core/permissions/types";
import {
  findMatchingPermissionRules,
  mergePermissionRuleDecisions,
} from "@/core/permissions/rules";
import type { PermissionRule } from "@/core/permissions/types";

export function evaluatePermission(options: {
  readonly subject: PermissionSubject;
  readonly rules: readonly PermissionRule[];
  readonly mode: PermissionMode;
}): PermissionEvaluation {
  const matched = findMatchingPermissionRules(options.subject, options.rules);
  const merged = mergePermissionRuleDecisions(matched);
  if (merged) {
    const reason = {
      source: "rules" as const,
      risk: permissionRisk(options.subject),
      matches: merged.matches,
      message: `匹配 ${merged.matches.length} 条权限规则，结果为 ${merged.decision === "deny" ? "拒绝" : "允许"}${merged.decision === "ask" ? "（旧 ask 规则兼容为直接允许）" : ""}。`,
    };
    return toEvaluation(merged.decision, reason);
  }
  const decision = "allow";
  const reason = {
    source: "mode" as const,
    risk: permissionRisk(options.subject),
    mode: options.mode,
    message: "没有匹配拒绝规则，按自主执行策略直接允许。",
  };
  return toEvaluation(decision, reason);
}

function toEvaluation(
  decision: PermissionDecision,
  reason: PermissionEvaluation["reason"],
): PermissionEvaluation {
  // 旧 ask 配置继续可读，但运行时不再建立审批等待。
  if (decision !== "deny") return { kind: "allow", reason };
  return { kind: "deny", reason, errorKind: "permission-denied" };
}
