import type { PromptSystemMessage } from "@/core/system-prompt/types";
import type { AgentIterationLimit } from "@/core/agent-events";

export function iterationReviewMessages(iteration: number, limit: AgentIterationLimit = "unlimited"): readonly PromptSystemMessage[] {
  if (Number.isSafeInteger(iteration) && iteration > 0 && limit !== "unlimited" && iteration <= limit && limit - iteration < 3) {
    const remaining = limit - iteration + 1;
    return [{ role: "system", content: `运行时预算：本次 ${iteration}/${limit}，含本轮还剩 ${remaining} 次。直接证据足够时立即回答并引用来源，只补关键缺口，避免重复阅读。${remaining === 1 ? "本轮请停止调用工具，直接基于已有证据给出最终回答，列明未完成项；新工具不会执行，不能猜测或宣称通过。" : "预算提示不代表完成。"}` }];
  }
  if (!Number.isSafeInteger(iteration) || iteration < 16 || iteration % 16 !== 0) return [];
  return [{ role: "system", content: `本轮已进入第 ${iteration} 次模型请求。请复核仍未解决的具体事项和已有证据，再决定下一步；任务仍可继续。针对同一假设反复改写探针时，先核对公式、被测入口和实际断言，将独立边界合并为可重复的确定性检查；原失败不可复验时明确说明，不用新增通过数量替代原验收。已有证据足够时直接汇总结果。` }];
}
