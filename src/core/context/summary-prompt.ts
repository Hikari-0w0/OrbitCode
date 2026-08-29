import type { ManagedContextMessage } from "@/core/context/types";
import { toConversationMessage } from "@/core/context/types";

export const SUMMARY_SYSTEM_PROMPT = [
  "你是 OrbitCode 的上下文压缩器。只能依据给定历史整理事实，不得补写或猜测代码。",
  "先在 analysisDraft 中生成仅供本次压缩使用的分析草稿，再在 summary 中生成正式摘要。",
  "输出必须是单个 JSON 对象，不要使用 Markdown 代码围栏，不要输出额外文字。",
  "summary 必须且只能包含 taskGoals、completedWork、keyDecisions、fileChanges、toolResults、errors、nextSteps 七个字符串数组。",
].join("\n");

export function buildSummaryInput(
  messages: readonly ManagedContextMessage[],
): string {
  return JSON.stringify({
    instruction:
      "压缩以下较早历史。保留不确定性；涉及具体文件时记录需要重新读取，不能把摘要当作代码事实。",
    history: messages.map(toConversationMessage),
  });
}
