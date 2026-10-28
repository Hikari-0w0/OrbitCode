export const REASONING_EFFORTS = ["low", "high", "max"] as const;
export type ModelReasoningEffort = typeof REASONING_EFFORTS[number];

export function isReasoningEffort(value: unknown): value is ModelReasoningEffort {
  return value === "low" || value === "high" || value === "max";
}

export function defaultReasoningEffort(model: string): ModelReasoningEffort | undefined {
  // 仅给强制思考的 GLM-5.3 系列默认值，避免向其他兼容接口发送未知参数。
  return /(?:^|\/)glm-5\.3(?:-flash)?$/i.test(model) ? "high" : undefined;
}
