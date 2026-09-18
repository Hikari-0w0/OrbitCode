import type { AgentMode, AgentStopReason } from "@/core/agent-events";

export const PLAN_EXECUTION_PROMPT = "请按照上述计划开始执行。";
export function executablePlanId(mode: AgentMode, reason: AgentStopReason, messageId: string): string | undefined {
  return mode === "plan" && reason === "final-response" ? messageId : undefined;
}
export function matchesExecutablePlan(current: string | undefined, requested: string): boolean {
  return current !== undefined && current === requested;
}
