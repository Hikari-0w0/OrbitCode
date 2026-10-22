import type { AgentMode } from "@/core/agent-events";
import { evaluatePermission } from "@/core/permissions/evaluator";
import { permissionTargetValue, type PermissionMode, type PermissionRule, type PermissionSubject } from "@/core/permissions/types";
import { analyzeDangerousCommand } from "@/tools/dangerous-command";
import { permissionTargetFailure, resolvePermissionSubject } from "@/tools/permission-target";
import type { PermissionOperation } from "@/tools/registry";
import { toolFailure, type ToolExecutionResult, type WorkspaceBoundary } from "@/tools/types";

export type PermissionGatewayOptions = {
  readonly agentMode: AgentMode;
  // 兼容既有会话模式；旧模式不再触发人工审批。
  readonly permissionMode?: PermissionMode | (() => PermissionMode);
  readonly workspace: WorkspaceBoundary;
  readonly loadRules: () => Promise<readonly PermissionRule[]>;
  readonly additionalEvaluations?: (subject: PermissionSubject) => Promise<readonly ReturnType<typeof evaluatePermission>[]>;
};

export type PermissionExecutable = {
  readonly kind: "allowed";
  readonly call: PermissionOperation;
  readonly subject: PermissionSubject;
  revalidate(signal: AbortSignal): Promise<ToolExecutionResult | undefined>;
};
export type PermissionAuthorization = PermissionExecutable | { readonly kind: "denied"; readonly result: ToolExecutionResult };

export class PermissionGateway {
  constructor(private readonly options: PermissionGatewayOptions) {}

  async authorizeConnection(call: PermissionOperation, requestId: string, signal: AbortSignal): Promise<PermissionAuthorization> {
    if (call.permissionTarget.kind !== "mcp" || call.permissionTarget.operation !== "connect") return denied(approvalInvalid("连接授权目标无效。"));
    return this.authorize(call, requestId, signal);
  }

  async authorize(call: PermissionOperation, _toolCallId: string, signal: AbortSignal, permissionTarget = call.permissionTarget): Promise<PermissionAuthorization> {
    const scopedCall = permissionTarget === call.permissionTarget ? call : { ...call, permissionTarget, permissionTargets: [permissionTarget] };
    if (signal.aborted) return denied(cancelledFailure());
    if (this.options.agentMode === "plan" && scopedCall.mutability !== "read-only") return denied(toolFailure("permission-denied", "Plan 模式不允许写入 Workspace、执行命令或调用外部 MCP。", { retryable: true }));
    const preliminary = preliminaryDangerousFailure(scopedCall);
    if (preliminary) return denied(preliminary);
    const subject = await this.#resolveSubject(scopedCall);
    if (!subject.ok) return denied(subject.result);
    const hardFailure = dangerousFailure(subject.value);
    if (hardFailure) return denied(hardFailure);
    const evaluation = await this.#evaluate(subject.value);
    if (!evaluation.ok) return denied(evaluation.result);
    if (evaluation.value.kind === "deny") return denied(permissionDenied(evaluation.value.reason.message));
    const expectedFingerprint = scopedCall.fingerprint;
    return { kind: "allowed", call: scopedCall, subject: subject.value, revalidate: signal => this.#revalidate(scopedCall, subject.value, expectedFingerprint, signal) };
  }

  async #revalidate(call: PermissionOperation, expectedSubject: PermissionSubject, expectedFingerprint: string, signal: AbortSignal): Promise<ToolExecutionResult | undefined> {
    if (signal.aborted) return cancelledFailure();
    const externalFailure = await call.revalidate?.(signal);
    if (externalFailure) return externalFailure;
    if (this.options.agentMode === "plan" && call.mutability !== "read-only") return approvalInvalid("Agent 模式已不再允许这次工具调用。");
    const current = await this.#resolveSubject(call);
    if (!current.ok) return current.result;
    if (!call.fingerprint.length || call.fingerprint !== expectedFingerprint || !sameSubject(expectedSubject, current.value)) return approvalInvalid("工具参数或规范目标在权限检查后发生变化。");
    const hardFailure = dangerousFailure(current.value);
    if (hardFailure) return hardFailure;
    const evaluation = await this.#evaluate(current.value);
    if (!evaluation.ok) return evaluation.result;
    if (evaluation.value.kind === "deny") return approvalInvalid("权限复检发现新的拒绝规则。");
    return undefined;
  }

  async #resolveSubject(call: PermissionOperation): Promise<{ readonly ok: true; readonly value: PermissionSubject } | { readonly ok: false; readonly result: ToolExecutionResult }> {
    try { return { ok: true, value: await resolvePermissionSubject(call, this.options.workspace) }; }
    catch (error) { return { ok: false, result: permissionTargetFailure(error) }; }
  }

  async #evaluate(subject: PermissionSubject): Promise<{ readonly ok: true; readonly value: ReturnType<typeof evaluatePermission> } | { readonly ok: false; readonly result: ToolExecutionResult }> {
    try {
      const rules = await this.options.loadRules();
      const mode = typeof this.options.permissionMode === "function" ? this.options.permissionMode() : this.options.permissionMode ?? "permissive";
      const evaluations = [evaluatePermission({ subject, rules, mode }), ...(await this.options.additionalEvaluations?.(subject) ?? [])];
      return { ok: true, value: evaluations.find(item => item.kind === "deny") ?? evaluations[0] };
    } catch { return { ok: false, result: permissionConfigFailure() }; }
  }
}

function dangerousFailure(
  subject: PermissionSubject,
): ToolExecutionResult | undefined {
  if (subject.kind !== "command") return undefined;
  const analysis = analyzeDangerousCommand(subject.command, subject.canonicalCwd);
  if (analysis.safe) return undefined;
  return toolFailure("dangerous-operation", analysis.message, {
    retryable: true,
  });
}

function preliminaryDangerousFailure(
  call: PermissionOperation,
): ToolExecutionResult | undefined {
  const target = call.permissionTarget;
  if (target.kind !== "command") return undefined;
  const cwd = target.cwd === undefined || target.cwd === "." || target.cwd === "./"
    ? "."
    : "<workspace-subdirectory>";
  const analysis = analyzeDangerousCommand(target.command.trim(), cwd);
  if (analysis.safe) return undefined;
  return toolFailure("dangerous-operation", analysis.message, {
    retryable: true,
  });
}

function sameSubject(
  left: PermissionSubject,
  right: PermissionSubject,
): boolean {
  if (
    left.kind !== right.kind ||
    left.toolName !== right.toolName ||
    left.toolKind !== right.toolKind
  ) {
    return false;
  }
  if (left.kind === "mcp" && right.kind === "mcp") return permissionTargetValue(left) === permissionTargetValue(right) && left.operation === right.operation;
  if (left.kind === "path" && right.kind === "path") {
    return left.canonicalRelativePath === right.canonicalRelativePath;
  }
  return (
    left.kind === "command" &&
    right.kind === "command" &&
    left.command === right.command &&
    left.canonicalCwd === right.canonicalCwd
  );
}

function denied(result: ToolExecutionResult): Extract<PermissionAuthorization, { readonly kind: "denied" }> {
  return { kind: "denied", result };
}

function permissionDenied(message: string): ToolExecutionResult {
  return toolFailure("permission-denied", message, { retryable: true });
}

function approvalInvalid(message: string): ToolExecutionResult {
  return toolFailure("approval-invalid", message, { retryable: true });
}

function permissionConfigFailure(): ToolExecutionResult {
  return toolFailure("permission-config", "权限配置无法安全读取，工具未执行。", { retryable: true });
}

function cancelledFailure(): ToolExecutionResult {
  return toolFailure("cancelled", "工具权限检查已取消。");
}
