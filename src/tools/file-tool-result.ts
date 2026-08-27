import { toolFailure, type SideEffectState, type ToolExecutionResult } from "@/tools/types";
import { WorkspaceError } from "@/tools/workspace";

export function fileToolFailure(
  error: unknown,
  signal: AbortSignal,
  sideEffect: SideEffectState = "none",
): ToolExecutionResult {
  if (signal.aborted) {
    return toolFailure("cancelled", "工具执行已取消。", { sideEffect });
  }
  if (!(error instanceof WorkspaceError)) {
    return toolFailure("execution-failed", "文件工具执行失败。", { sideEffect });
  }
  switch (error.kind) {
    case "invalid-path":
    case "permission-denied":
      return toolFailure("permission-denied", error.message, { retryable: true, sideEffect });
    case "protected-path":
      return toolFailure("protected-path", error.message, { retryable: true, sideEffect });
    case "not-found":
    case "not-file":
    case "not-directory":
      return toolFailure("not-found", error.message, { retryable: true, sideEffect });
    case "unsupported-content":
      return toolFailure("unsupported-content", error.message, { retryable: true, sideEffect });
    case "limit-exceeded":
      return toolFailure("limit-exceeded", error.message, { retryable: true, sideEffect });
    case "conflict":
      return toolFailure("conflict", error.message, { retryable: true, sideEffect });
    case "execution-failed":
      return toolFailure("execution-failed", error.message, { sideEffect });
  }
}
