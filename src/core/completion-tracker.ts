import { createHash, randomUUID } from "node:crypto";
import type { ModelToolCall } from "@/models/provider";
import type { ToolExecutionResult, ToolMutability } from "@/tools/types";
import type { PromptSystemMessage } from "./system-prompt/types";

import { unverifiedCompletionAssessment, type CompletionAssessment } from "./completion-assessment";
export { unverifiedCompletionAssessment, isCompletionAssessment } from "./completion-assessment";
export type { CompletionAssessment, CompletionCheck, VerificationStatus } from "./completion-assessment";

type EvidenceRecord = {
  readonly ok: boolean;
  readonly mutability: ToolMutability;
  readonly toolName: string;
  readonly iteration: number;
  readonly sequence: number;
  readonly detail: string;
};

// 被动记录工具事实；不要求模型提交报告，不据调用成功推导任务验收通过。
export class CompletionTracker {
  readonly #evidence = new Map<string, EvidenceRecord>();
  readonly #evidenceIdByCallId = new Map<string, string>();
  readonly #createRunId: () => string;
  #runId: string;
  #nextEvidenceId = 1;
  readonly #repeatedFailures = new Map<string, { count: number; iteration: number }>();

  constructor(options: { readonly createRunId?: () => string } = {}) {
    this.#createRunId = options.createRunId ?? (() => randomUUID().replaceAll("-", ""));
    this.#runId = createEvidenceRunId(this.#createRunId);
  }

  beginRun(): void {
    this.#evidence.clear();
    this.#evidenceIdByCallId.clear();
    this.#runId = createEvidenceRunId(this.#createRunId);
    this.#nextEvidenceId = 1;
    this.#repeatedFailures.clear();
  }

  record(input: { readonly call: ModelToolCall; readonly result: ToolExecutionResult; readonly iteration: number; readonly sequence: number; readonly mutability: ToolMutability }): string {
    // 只提示可见的重复失败，不阻止重试，也不假定失败命令没有副作用。
    if (input.result.ok && (input.mutability === "workspace-write" || input.mutability === "command")) this.#repeatedFailures.clear();
    if (!input.result.ok && input.call.name !== "agent" && input.call.name !== "load_skill") {
      const fingerprint = createHash("sha256").update(input.call.name).update(input.call.argumentsJson).update(JSON.stringify({ error: input.result.error, output: input.result.output })).digest("hex");
      const previous = this.#repeatedFailures.get(fingerprint);
      this.#repeatedFailures.delete(fingerprint);
      this.#repeatedFailures.set(fingerprint, { count: (previous?.count ?? 0) + 1, iteration: input.iteration });
      const oldest = this.#repeatedFailures.keys().next().value;
      if (this.#repeatedFailures.size > 64 && oldest !== undefined) this.#repeatedFailures.delete(oldest);
    }
    const id = this.#evidenceIdByCallId.get(input.call.id) ?? `e_${this.#runId}_${this.#nextEvidenceId++}`;
    this.#evidenceIdByCallId.set(input.call.id, id);
    this.#evidence.set(id, {
      ok: input.result.ok, mutability: input.mutability, toolName: input.call.name,
      iteration: input.iteration, sequence: input.sequence, detail: executionDetail(input.result),
    });
    return id;
  }

  evidenceId(callId: string): string | undefined { return this.#evidenceIdByCallId.get(callId); }

  reviewMessages(): readonly PromptSystemMessage[] {
    const local = [...this.#evidence.entries()]
      .filter(([, record]) => record.mutability === "workspace-write" || record.mutability === "command")
      .sort((a, b) => a[1].iteration - b[1].iteration || a[1].sequence - b[1].sequence);
    const repeated = [...this.#repeatedFailures.values()].filter(record => record.count >= 3);
    const reminder: readonly PromptSystemMessage[] = repeated.length ? [{ role: "system", content: `重复失败提示：有 ${repeated.length} 种相同工具参数与失败结果已出现至少3次，最近发生在第${Math.max(...repeated.map(record => record.iteration))}轮。核对已有错误、路径和执行条件，选择能提供新证据的诊断或说明阻塞；依赖、文件或外部状态改变后可合理重试。此提示不证明工作区状态未变，不要求停止或跳过必要验证。` }] : [];
    if (!local.length) return reminder;
    const recent = local.slice(-8);
    return [...reminder, { role: "system", content: `本轮执行证据摘要（仅工具事实，共 ${local.length} 项，显示最近 ${recent.length} 项；不是任务验收）：\n${recent.map(([id, record]) => `${id} 第${record.iteration}轮/${record.sequence} ${record.mutability === "command" ? "命令" : "文件写入"}：${record.detail}`).join("\n")}\n命令可能改写文件，退出0仅表示命令返回成功。若任务涉及变更，收尾前核对最新差异（含暂存、新增与已提交改动）、修改后的原复现及相关原有测试；修改测试或mock后，不能只凭修改后的自测宣称兼容。按实际结果说明已验证、失败和未验证项；历史失败可能已恢复，不必为消除摘要中的失败重复运行。` }];
  }

  assessment(): CompletionAssessment {
    const evidence = [...this.#evidence.entries()];
    const external = evidence.filter(([, record]) => record.mutability === "external");
    if (external.length > 0 && evidence.every(([, record]) => record.mutability === "external" || record.toolName === "read_context")) {
      return { status: "observed", checks: external.slice(-20).map(([id, record]) => ({ scope: "external-call", criterion: `外部工具调用结果：${record.toolName.slice(0, 120)}（仅记录调用返回，不验证答复内容）`, status: record.ok ? "passed" : "failed", evidenceCallIds: [id] })), blockers: [] };
    }
    return unverifiedCompletionAssessment();
  }
}

// 不从任意 stdout 猜测测试语义，也不把原始命令、路径或输出复制进 system 消息。
function executionDetail(result: ToolExecutionResult): string {
  const output = result.output;
  const facts = [result.ok ? "工具返回成功" : `工具失败(${result.error.kind})`];
  if (typeof output === "object" && output !== null && !Array.isArray(output)) {
    if ("exitCode" in output && (output.exitCode === null || (typeof output.exitCode === "number" && Number.isSafeInteger(output.exitCode)))) facts.push(`exitCode=${output.exitCode}`);
    if ("timedOut" in output && output.timedOut === true) facts.push("超时");
    if ("cancelled" in output && output.cancelled === true) facts.push("取消");
  }
  if (result.meta.truncated) facts.push("输出已截断，失败细节可能缺失");
  return facts.join("；");
}

function createEvidenceRunId(factory: () => string): string {
  const id = factory();
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(id)) throw new Error("完成证据运行 ID 必须由 1 到 64 个字母、数字、下划线或连字符组成。");
  return id;
}
