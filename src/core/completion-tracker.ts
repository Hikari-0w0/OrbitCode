import { randomUUID } from "node:crypto";
import type { ModelToolCall } from "@/models/provider";
import type { ToolExecutionResult, ToolMutability } from "@/tools/types";

import { unverifiedCompletionAssessment, type CompletionAssessment } from "./completion-assessment";
export { unverifiedCompletionAssessment, isCompletionAssessment } from "./completion-assessment";
export type { CompletionAssessment, CompletionCheck, VerificationStatus } from "./completion-assessment";

type EvidenceRecord = {
  readonly ok: boolean;
  readonly mutability: ToolMutability;
  readonly toolName: string;
};

// 被动记录工具事实；不要求模型提交报告，不据调用成功推导任务验收通过。
export class CompletionTracker {
  readonly #evidence = new Map<string, EvidenceRecord>();
  readonly #evidenceIdByCallId = new Map<string, string>();
  readonly #createRunId: () => string;
  #runId: string;
  #nextEvidenceId = 1;

  constructor(options: { readonly createRunId?: () => string } = {}) {
    this.#createRunId = options.createRunId ?? (() => randomUUID().replaceAll("-", ""));
    this.#runId = createEvidenceRunId(this.#createRunId);
  }

  beginRun(): void {
    this.#evidence.clear();
    this.#evidenceIdByCallId.clear();
    this.#runId = createEvidenceRunId(this.#createRunId);
    this.#nextEvidenceId = 1;
  }

  record(input: { readonly call: ModelToolCall; readonly result: ToolExecutionResult; readonly iteration: number; readonly sequence: number; readonly mutability: ToolMutability }): string {
    const id = this.#evidenceIdByCallId.get(input.call.id) ?? `e_${this.#runId}_${this.#nextEvidenceId++}`;
    this.#evidenceIdByCallId.set(input.call.id, id);
    this.#evidence.set(id, { ok: input.result.ok, mutability: input.mutability, toolName: input.call.name });
    return id;
  }

  evidenceId(callId: string): string | undefined { return this.#evidenceIdByCallId.get(callId); }

  assessment(): CompletionAssessment {
    const evidence = [...this.#evidence.entries()];
    const external = evidence.filter(([, record]) => record.mutability === "external");
    if (external.length > 0 && evidence.every(([, record]) => record.mutability === "external" || record.toolName === "read_context")) {
      return { status: "observed", checks: external.slice(-20).map(([id, record]) => ({ scope: "external-call", criterion: `外部工具调用结果：${record.toolName.slice(0, 120)}（仅记录调用返回，不验证答复内容）`, status: record.ok ? "passed" : "failed", evidenceCallIds: [id] })), blockers: [] };
    }
    return unverifiedCompletionAssessment();
  }
}

function createEvidenceRunId(factory: () => string): string {
  const id = factory();
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(id)) throw new Error("完成证据运行 ID 必须由 1 到 64 个字母、数字、下划线或连字符组成。");
  return id;
}
