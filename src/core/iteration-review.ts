import type { PromptSystemMessage } from "@/core/system-prompt/types";

export function iterationReviewMessages(iteration: number): readonly PromptSystemMessage[] {
  if (!Number.isSafeInteger(iteration) || iteration < 16 || iteration % 16 !== 0) return [];
  return [{ role: "system", content: `本轮已进入第 ${iteration} 次模型请求。请复核仍未解决的具体事项和已有证据，再决定下一步；任务仍可继续。针对同一假设反复改写探针时，先核对公式、被测入口和实际断言，将独立边界合并为可重复的确定性检查；原失败不可复验时明确说明，不用新增通过数量替代原验收。已有证据足够时直接汇总结果。` }];
}
