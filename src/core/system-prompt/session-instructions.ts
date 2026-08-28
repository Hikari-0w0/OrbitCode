import type { AgentMode } from "@/core/agent-events";
import { AgentConfigurationError } from "@/core/errors";
import {
  PROMPT_TAGS,
  taggedMessage,
} from "@/core/system-prompt/dynamic-context";
import type {
  PromptSystemMessage,
  SessionInstructionContext,
} from "@/core/system-prompt/types";

export const FULL_MODE_REMINDER_INTERVAL = 4;
export const MAX_MODE_TURN = 10_000;

const FULL_MODE_INSTRUCTIONS: Readonly<Record<AgentMode, string>> = {
  plan: `当前模式：Plan。
只分析任务并读取形成可靠计划所必需的上下文；已有证据足够时停止探索。必要时先澄清会实质改变方案的问题。输出具体、可执行、可验证的计划，但不要修改文件、执行命令或声称已经实施。`,
  do: `当前模式：Do。
围绕用户目标自主使用可用工具，先读取相关现状，再执行最小必要变更。逐次检查工具结果，可恢复失败时修正后继续；完成后执行与风险相称的验证。最终只报告实际完成、验证或明确停止的内容。`,
};

const COMPACT_MODE_INSTRUCTIONS: Readonly<Record<AgentMode, string>> = {
  plan:
    "当前模式：Plan。只读取必要上下文并形成计划，不执行副作用操作，不声称已经实施。",
  do:
    "当前模式：Do。依据最新上下文行动，检查工具结果并验证完成情况，只报告实际结果。",
};

export type SessionInstructionStrength = "full" | "compact";

export function sessionInstructionStrength(
  modeTurn: number,
): SessionInstructionStrength {
  assertModeTurn(modeTurn);
  return (modeTurn - 1) % FULL_MODE_REMINDER_INTERVAL === 0
    ? "full"
    : "compact";
}

export function buildSessionInstructionMessage(
  context: SessionInstructionContext,
): PromptSystemMessage {
  if (context.mode !== "plan" && context.mode !== "do") {
    throw new AgentConfigurationError("系统提示会话模式无效。");
  }
  const strength = sessionInstructionStrength(context.modeTurn);
  const content = strength === "full"
    ? FULL_MODE_INSTRUCTIONS[context.mode]
    : COMPACT_MODE_INSTRUCTIONS[context.mode];
  return taggedMessage(PROMPT_TAGS.sessionInstructions, content);
}

function assertModeTurn(modeTurn: number): void {
  if (!Number.isInteger(modeTurn) || modeTurn < 1 || modeTurn > MAX_MODE_TURN) {
    throw new AgentConfigurationError(
      `模式连续轮次必须是 1 到 ${MAX_MODE_TURN} 之间的整数。`,
    );
  }
}
