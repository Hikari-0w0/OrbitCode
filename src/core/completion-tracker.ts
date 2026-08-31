import { randomUUID } from "node:crypto";

import type { ModelToolCall } from "@/models/provider";
import type {
  ToolExecutionResult,
  ToolMutability,
} from "@/tools/types";

export type VerificationStatus =
  | "verified"
  | "partial"
  | "unverified"
  | "blocked";

export type CompletionCheck = {
  readonly criterion: string;
  readonly status: "passed" | "failed" | "not-run";
  readonly evidenceCallIds: readonly string[];
};

export type CompletionAssessment = {
  readonly status: VerificationStatus;
  readonly checks: readonly CompletionCheck[];
  readonly blockers: readonly string[];
};

export type CompletionReportInput = {
  readonly status: "complete" | "partial" | "blocked";
  readonly checks: readonly CompletionCheck[];
  readonly blockers: readonly string[];
};

type EvidenceRecord = {
  readonly ok: boolean;
  readonly iteration: number;
  readonly sequence: number;
  readonly mutability: ToolMutability;
  readonly sideEffect: ToolExecutionResult["sideEffect"];
};

export class CompletionTracker {
  readonly #evidence = new Map<string, EvidenceRecord>();
  readonly #evidenceIdByCallId = new Map<string, string>();
  readonly #createRunId: () => string;
  #runId: string;
  #nextEvidenceId = 1;
  #assessment?: CompletionAssessment;

  constructor(options: { readonly createRunId?: () => string } = {}) {
    this.#createRunId = options.createRunId ?? (() => randomUUID().replaceAll("-", ""));
    this.#runId = createEvidenceRunId(this.#createRunId);
  }

  beginRun(): void {
    this.#evidence.clear();
    this.#evidenceIdByCallId.clear();
    this.#runId = createEvidenceRunId(this.#createRunId);
    this.#nextEvidenceId = 1;
    this.#assessment = undefined;
  }

  record(input: {
    readonly call: ModelToolCall;
    readonly result: ToolExecutionResult;
    readonly iteration: number;
    readonly sequence: number;
    readonly mutability: ToolMutability;
  }): string | undefined {
    if (input.call.name === "report_completion") return undefined;
    const evidenceId = this.#evidenceIdByCallId.get(input.call.id) ??
      `e_${this.#runId}_${this.#nextEvidenceId++}`;
    this.#evidenceIdByCallId.set(input.call.id, evidenceId);
    this.#evidence.set(evidenceId, {
      ok: input.result.ok,
      iteration: input.iteration,
      sequence: input.sequence,
      mutability: input.mutability,
      sideEffect: input.result.sideEffect,
    });
    return evidenceId;
  }

  evidenceId(callId: string): string | undefined {
    return this.#evidenceIdByCallId.get(callId);
  }

  accept(report: CompletionReportInput):
    | { readonly ok: true; readonly assessment: CompletionAssessment }
    | { readonly ok: false; readonly message: string } {
    for (const check of report.checks) {
      const records = check.evidenceCallIds.map((id) => this.#resolveEvidence(id));
      if (records.some((record) => record === undefined)) {
        return {
          ok: false,
          message: "完成报告引用了本轮不存在的证据；请复制工具结果中的 evidence_call_id。",
        };
      }
      if (check.status === "passed") {
        if (records.length === 0 || records.some((record) => !record?.ok)) {
          return { ok: false, message: "通过项必须引用至少一个成功工具结果。" };
        }
      }
      if (check.status === "not-run" && records.length > 0) {
        return { ok: false, message: "未运行项不能携带工具证据。" };
      }
    }

    const lastWrite = latest(
      [...this.#evidence.values()].filter((record) =>
        record.mutability !== "read-only" && record.sideEffect === "applied"
      ),
    );
    const passedEvidence = report.checks
      .filter((check) => check.status === "passed")
      .flatMap((check) => check.evidenceCallIds)
      .map((id) => this.#resolveEvidence(id))
      .filter((record): record is EvidenceRecord => record !== undefined);
    const hasPostWriteVerification = lastWrite === undefined || passedEvidence.some(
      (record) => record.ok && isAfter(record, lastWrite) && isVerification(record),
    );
    const hasIncompleteChecks = report.checks.some(
      (check) => check.status !== "passed",
    );
    const status: VerificationStatus = report.blockers.length > 0
      ? "blocked"
      : hasIncompleteChecks
        ? "partial"
        : report.checks.length > 0 && hasPostWriteVerification
          ? "verified"
          : "unverified";
    const expectedClaim = status === "verified"
      ? "complete"
      : status === "blocked"
        ? "blocked"
        : "partial";
    if (report.status !== expectedClaim) {
      return {
        ok: false,
        message: "完成报告的声明状态与检查结果或写入后验证不一致。",
      };
    }
    this.#assessment = {
      status,
      checks: report.checks.map((check) => ({
        criterion: check.criterion,
        status: check.status,
        evidenceCallIds: [...check.evidenceCallIds],
      })),
      blockers: [...report.blockers],
    };
    return { ok: true, assessment: this.#assessment };
  }

  assessment(): CompletionAssessment {
    return this.#assessment ?? unverifiedCompletionAssessment();
  }

  #resolveEvidence(id: string): EvidenceRecord | undefined {
    const direct = this.#evidence.get(id);
    if (direct !== undefined) return direct;
    const evidenceId = this.#evidenceIdByCallId.get(id);
    return evidenceId === undefined ? undefined : this.#evidence.get(evidenceId);
  }
}

function createEvidenceRunId(factory: () => string): string {
  const runId = factory();
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(runId)) {
    throw new Error("完成证据运行 ID 必须由 1 到 64 个字母、数字、下划线或连字符组成。");
  }
  return runId;
}

export function unverifiedCompletionAssessment(): CompletionAssessment {
  return { status: "unverified", checks: [], blockers: [] };
}

export function isCompletionAssessment(value: unknown): value is CompletionAssessment {
  if (!isRecord(value) || !hasExactFields(value, ["status", "checks", "blockers"])) {
    return false;
  }
  if (!["verified", "partial", "unverified", "blocked"].includes(String(value.status))) {
    return false;
  }
  if (
    !Array.isArray(value.checks) ||
    value.checks.length > 20 ||
    !value.checks.every((check) =>
      isRecord(check) &&
      hasExactFields(check, ["criterion", "status", "evidenceCallIds"]) &&
      typeof check.criterion === "string" &&
      check.criterion.length > 0 &&
      check.criterion.length <= 200 &&
      ["passed", "failed", "not-run"].includes(String(check.status)) &&
      Array.isArray(check.evidenceCallIds) &&
      check.evidenceCallIds.length <= 16 &&
      check.evidenceCallIds.every((id) =>
        typeof id === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(id)
      )
    )
  ) return false;
  return Array.isArray(value.blockers) &&
    value.blockers.length <= 10 &&
    value.blockers.every((blocker) =>
      typeof blocker === "string" && blocker.length > 0 && blocker.length <= 300
    );
}

function latest(records: readonly EvidenceRecord[]): EvidenceRecord | undefined {
  return records.reduce<EvidenceRecord | undefined>(
    (current, record) => current === undefined || isAfter(record, current)
      ? record
      : current,
    undefined,
  );
}

function isAfter(left: EvidenceRecord, right: EvidenceRecord): boolean {
  return left.iteration > right.iteration ||
    (left.iteration === right.iteration && left.sequence > right.sequence);
}

function isVerification(record: EvidenceRecord): boolean {
  return record.mutability === "read-only" || record.mutability === "command";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return Object.keys(value).length === fields.length &&
    fields.every((field) => field in value);
}
