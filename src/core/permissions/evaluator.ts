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
      message: `匹配 ${merged.matches.length} 条权限规则，合并结果为 ${merged.decision}。`,
    };
    return toEvaluation(merged.decision, reason);
  }
  const decision = defaultDecision(options.mode, options.subject.toolKind);
  const reason = {
    source: "mode" as const,
    risk: permissionRisk(options.subject),
    mode: options.mode,
    message: `没有匹配规则，使用 ${options.mode} 权限模式的默认结果 ${decision}。`,
  };
  return toEvaluation(decision, reason);
}

function defaultDecision(
  mode: PermissionMode,
  toolKind: PermissionSubject["toolKind"],
): PermissionDecision {
  if (mode === "strict") return "ask";
  if (mode === "permissive") return "allow";
  return toolKind === "read" ? "allow" : "ask";
}

function toEvaluation(
  decision: PermissionDecision,
  reason: PermissionEvaluation["reason"],
): PermissionEvaluation {
  if (decision === "allow") return { kind: "allow", reason };
  if (decision === "ask") return { kind: "ask", reason };
  return { kind: "deny", reason, errorKind: "permission-denied" };
}
