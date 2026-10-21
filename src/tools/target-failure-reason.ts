import type { ToolExecutionResult } from "./types";

export const TARGET_FAILURE_REASONS = ["not-directory", "not-file", "not-found", "invalid-path", "permission-denied", "protected-path", "execution-failed", "unresolved"] as const;
export type TargetFailureReason = typeof TARGET_FAILURE_REASONS[number];
export function isTargetFailureReason(value: unknown): value is TargetFailureReason {
  return typeof value === "string" && TARGET_FAILURE_REASONS.some(reason => reason === value);
}
// 只允许固定原因进入日志，不收集模型参数、命令、错误正文或凭据路径。
export function targetFailureReason(result: ToolExecutionResult): TargetFailureReason | undefined {
  if (result.ok || !result.output || typeof result.output !== "object" || Array.isArray(result.output) || !("targetFailureReason" in result.output)) return;
  const reason = result.output.targetFailureReason;
  return isTargetFailureReason(reason) ? reason : undefined;
}
