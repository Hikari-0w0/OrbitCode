import type { ToolExecutionResult } from "./types";

// 控制层的停止原因与执行器的观察分开：取消不能抹掉已发生的写入和已返回输出。
export function normalizeToolTermination(
  observed: ToolExecutionResult,
  reason: "cancelled" | "timeout",
): ToolExecutionResult {
  if (!observed.ok && observed.error.kind === reason) return observed;
  return {
    ok: false,
    error: {
      kind: reason,
      message: reason === "cancelled" ? "工具执行已取消。" : "工具执行超时。",
      retryable: reason === "timeout",
    },
    output: observed.output,
    sideEffect: observed.sideEffect,
    meta: observed.meta,
  };
}
