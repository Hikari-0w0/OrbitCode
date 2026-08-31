import { createHash } from "node:crypto";

import type { ModelToolCall } from "@/models/provider";
import type { ToolExecutionResult } from "@/tools/types";

const EXACT_SWITCH_THRESHOLD = 2;
const EXACT_STOP_THRESHOLD = 4;
const TOOL_KIND_SWITCH_THRESHOLD = 3;
const TOOL_KIND_STOP_THRESHOLD = 5;
const TOTAL_SWITCH_THRESHOLD = 4;
const TOTAL_STOP_THRESHOLD = 7;

export type ToolFailureBudgetDecision =
  | { readonly action: "continue" }
  | { readonly action: "switch"; readonly guidance: string }
  | { readonly action: "stop"; readonly detail: string };

export class ToolFailureBudget {
  readonly #exactFailures = new Map<string, number>();
  readonly #toolKindFailures = new Map<string, number>();
  #consecutiveFailures = 0;

  observe(
    call: ModelToolCall,
    result: ToolExecutionResult,
  ): ToolFailureBudgetDecision {
    if (result.ok) {
      this.#resetTool(call.name);
      this.#consecutiveFailures = 0;
      return { action: "continue" };
    }
    if (isExcludedFailure(result.error.kind)) return { action: "continue" };

    const issuePaths = [...new Set(
      (result.error.issues ?? []).map((issue) => issue.path),
    )].sort();
    const argumentFingerprint = createHash("sha256")
      .update(call.argumentsJson)
      .digest("hex");
    const exactKey = JSON.stringify([
      call.name,
      result.error.kind,
      issuePaths,
      argumentFingerprint,
    ]);
    const toolKindKey = `${call.name}:${result.error.kind}`;
    const exactCount = increment(this.#exactFailures, exactKey);
    const toolKindCount = increment(this.#toolKindFailures, toolKindKey);
    this.#consecutiveFailures += 1;

    if (
      exactCount >= EXACT_STOP_THRESHOLD ||
      toolKindCount >= TOOL_KIND_STOP_THRESHOLD ||
      this.#consecutiveFailures >= TOTAL_STOP_THRESHOLD
    ) {
      return {
        action: "stop",
        detail: `工具 ${safeToolName(call.name)} 连续产生同类失败，Agent 已停止无效重试。`,
      };
    }
    if (
      exactCount === EXACT_SWITCH_THRESHOLD ||
      toolKindCount === TOOL_KIND_SWITCH_THRESHOLD ||
      this.#consecutiveFailures === TOTAL_SWITCH_THRESHOLD
    ) {
      return {
        action: "switch",
        guidance: "失败预算提示：不要原样重试；请检查参数、改用更合适的工具或缩小操作范围。",
      };
    }
    return { action: "continue" };
  }

  #resetTool(toolName: string): void {
    for (const key of this.#toolKindFailures.keys()) {
      if (key.startsWith(`${toolName}:`)) this.#toolKindFailures.delete(key);
    }
    // 精确指纹使用 JSON 数组编码，避免工具名的前缀碰撞。
    const prefix = JSON.stringify([toolName]).slice(0, -1);
    for (const key of this.#exactFailures.keys()) {
      if (key.startsWith(`${prefix},`)) this.#exactFailures.delete(key);
    }
  }
}

function increment(counts: Map<string, number>, key: string): number {
  const next = (counts.get(key) ?? 0) + 1;
  counts.set(key, next);
  return next;
}

function isExcludedFailure(kind: string): boolean {
  return kind === "unknown-tool" ||
    kind === "cancelled" ||
    kind === "user-denied" ||
    kind === "approval-invalid";
}

function safeToolName(name: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(name) ? name : "<invalid>";
}
