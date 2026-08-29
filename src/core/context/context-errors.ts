import type { ContextFailure, ContextFailureKind } from "@/core/context/types";

export class ContextManagementError extends Error {
  constructor(
    readonly kind: ContextFailureKind,
    message: string,
    options: { readonly cause?: unknown; readonly summaryFailure?: boolean } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ContextManagementError";
    this.summaryFailure = options.summaryFailure ?? false;
  }

  readonly summaryFailure: boolean;
}

export function contextFailure(error: unknown): ContextFailure {
  if (error instanceof ContextManagementError) {
    return { kind: error.kind, message: error.message };
  }
  return {
    kind: "storage",
    message: "上下文管理发生未知错误，请重试。",
  };
}
