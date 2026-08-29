import type { AgentMode } from "@/core/agent-events";
import type {
  PermissionApprovalBroker,
  PermissionPrompt,
} from "@/core/permissions/approval";
import { evaluatePermission } from "@/core/permissions/evaluator";
import { formatExactPermissionExpression } from "@/core/permissions/rules";
import {
  permissionTargetValue,
  type PermissionMode,
  type PermissionRule,
  type PermissionSubject,
} from "@/core/permissions/types";
import { analyzeDangerousCommand } from "@/tools/dangerous-command";
import {
  permissionTargetFailure,
  resolvePermissionSubject,
  summarizePermissionSubject,
} from "@/tools/permission-target";
import type { PreparedToolCall } from "@/tools/registry";
import {
  toolFailure,
  type ToolExecutionResult,
  type WorkspaceBoundary,
} from "@/tools/types";

export type PermissionGatewayOptions = {
  readonly agentMode: AgentMode;
  readonly permissionMode: PermissionMode | (() => PermissionMode);
  readonly workspace: WorkspaceBoundary;
  readonly broker: PermissionApprovalBroker;
  readonly loadRules: () => Promise<readonly PermissionRule[]>;
  readonly persistAllow?: (expression: string) => Promise<void>;
};

export type PermissionExecutable = {
  readonly kind: "allowed";
  readonly call: PreparedToolCall;
  readonly subject: PermissionSubject;
  readonly approvalScope?: "once" | "session" | "permanent";
  revalidate(signal: AbortSignal): Promise<ToolExecutionResult | undefined>;
};

export type PermissionAwaiting = {
  readonly kind: "awaiting";
  readonly prompt: PermissionPrompt;
  resolve(): Promise<PermissionAuthorization>;
};

export type PermissionAuthorization =
  | PermissionExecutable
  | PermissionAwaiting
  | {
      readonly kind: "denied";
      readonly result: ToolExecutionResult;
      readonly approvalStatus?: "denied" | "expired" | "cancelled" | "invalid";
    };

type Confirmation = "policy" | "session" | "human";

export class PermissionGateway {
  constructor(private readonly options: PermissionGatewayOptions) {}

  async authorize(
    call: PreparedToolCall,
    toolCallId: string,
    signal: AbortSignal,
  ): Promise<PermissionAuthorization> {
    if (signal.aborted) return denied(cancelledFailure());
    if (this.options.agentMode === "plan" && call.mutability !== "read-only") {
      return denied(
        toolFailure(
          "permission-denied",
          "Plan 模式不允许写入 Workspace 或执行命令。",
          { retryable: true },
        ),
      );
    }
    const preliminaryHardFailure = preliminaryDangerousFailure(call);
    if (preliminaryHardFailure) return denied(preliminaryHardFailure);

    const subject = await this.#resolveSubject(call);
    if (!subject.ok) return denied(subject.result);
    const hardFailure = dangerousFailure(subject.value);
    if (hardFailure) return denied(hardFailure);

    const evaluation = await this.#evaluate(subject.value);
    if (!evaluation.ok) return denied(evaluation.result);
    if (evaluation.value.kind === "deny") {
      return denied(permissionDenied(evaluation.value.reason.message));
    }
    if (evaluation.value.kind === "allow") {
      return this.#allowed(call, subject.value, "policy");
    }
    if (this.options.broker.hasSessionGrant(subject.value)) {
      return this.#allowed(call, subject.value, "session");
    }

    const handle = this.options.broker.request(
      {
        toolCallId,
        subject: subject.value,
        fingerprint: call.fingerprint,
        reason: evaluation.value.reason,
        summary: summarizePermissionSubject(subject.value, call.permissionTarget),
      },
      signal,
    );
    const expectedFingerprint = call.fingerprint;
    let resolution: Promise<PermissionAuthorization> | undefined;
    return {
      kind: "awaiting",
      prompt: handle.prompt,
      resolve: () => {
        resolution ??= this.#resolveApproval(
          call,
          subject.value,
          expectedFingerprint,
          handle.outcome,
          signal,
        );
        return resolution;
      },
    };
  }

  #allowed(
    call: PreparedToolCall,
    subject: PermissionSubject,
    confirmation: Confirmation,
    approvalScope?: PermissionExecutable["approvalScope"],
  ): PermissionExecutable {
    const expectedFingerprint = call.fingerprint;
    return {
      kind: "allowed",
      call,
      subject,
      approvalScope,
      revalidate: (signal) =>
        this.#revalidate(call, subject, expectedFingerprint, confirmation, signal),
    };
  }

  async #resolveApproval(
    call: PreparedToolCall,
    subject: PermissionSubject,
    expectedFingerprint: string,
    outcomePromise: ReturnType<PermissionApprovalBroker["request"]>["outcome"],
    signal: AbortSignal,
  ): Promise<PermissionAuthorization> {
    const outcome = await outcomePromise;
    if (outcome.kind === "cancelled" || signal.aborted) {
      return denied(cancelledFailure(), "cancelled");
    }
    if (outcome.kind === "denied") {
      return denied(
        toolFailure("user-denied", "用户拒绝了这次工具调用。", {
          retryable: true,
        }),
        "denied",
      );
    }
    if (outcome.kind === "expired" || outcome.kind === "invalid") {
      return denied(
        toolFailure("approval-invalid", "授权请求已失效，请重新评估工具调用。", {
          retryable: true,
        }),
        outcome.kind,
      );
    }
    if (outcome.scope === "permanent") {
      if (!this.options.persistAllow) {
        return denied(permissionConfigFailure(), "invalid");
      }
      try {
        await this.options.persistAllow(
          formatExactPermissionExpression(
            subject.toolName,
            permissionTargetValue(subject),
          ),
        );
      } catch {
        return denied(permissionConfigFailure(), "invalid");
      }
    }

    const failure = await this.#revalidate(
      call,
      subject,
      expectedFingerprint,
      "human",
      signal,
    );
    return failure
      ? denied(failure, failure.ok ? undefined : "invalid")
      : this.#allowed(call, subject, "human", outcome.scope);
  }

  async #revalidate(
    call: PreparedToolCall,
    expectedSubject: PermissionSubject,
    expectedFingerprint: string,
    confirmation: Confirmation,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult | undefined> {
    if (signal.aborted) return cancelledFailure();
    if (this.options.agentMode === "plan" && call.mutability !== "read-only") {
      return approvalInvalid("Agent 模式已不再允许这次工具调用。");
    }
    const current = await this.#resolveSubject(call);
    if (!current.ok) return current.result;
    if (
      call.fingerprint.length === 0 ||
      call.fingerprint !== expectedFingerprint ||
      !sameSubject(expectedSubject, current.value)
    ) {
      return approvalInvalid("工具参数或规范目标在授权后发生变化。");
    }
    const hardFailure = dangerousFailure(current.value);
    if (hardFailure) return hardFailure;
    const evaluation = await this.#evaluate(current.value);
    if (!evaluation.ok) return evaluation.result;
    if (evaluation.value.kind === "deny") {
      return approvalInvalid("权限复检发现新的拒绝规则。");
    }
    if (
      evaluation.value.kind === "ask" &&
      confirmation === "policy" &&
      !this.options.broker.hasSessionGrant(current.value)
    ) {
      return approvalInvalid("权限复检要求重新取得人工确认。");
    }
    return undefined;
  }

  async #resolveSubject(
    call: PreparedToolCall,
  ): Promise<
    | { readonly ok: true; readonly value: PermissionSubject }
    | { readonly ok: false; readonly result: ToolExecutionResult }
  > {
    try {
      return {
        ok: true,
        value: await resolvePermissionSubject(call, this.options.workspace),
      };
    } catch (error) {
      return { ok: false, result: permissionTargetFailure(error) };
    }
  }

  async #evaluate(
    subject: PermissionSubject,
  ): Promise<
    | { readonly ok: true; readonly value: ReturnType<typeof evaluatePermission> }
    | { readonly ok: false; readonly result: ToolExecutionResult }
  > {
    try {
      const rules = await this.options.loadRules();
      return {
        ok: true,
        value: evaluatePermission({
          subject,
          rules,
          mode: this.#permissionMode(),
        }),
      };
    } catch {
      return { ok: false, result: permissionConfigFailure() };
    }
  }

  #permissionMode(): PermissionMode {
    return typeof this.options.permissionMode === "function"
      ? this.options.permissionMode()
      : this.options.permissionMode;
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
  call: PreparedToolCall,
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

function denied(
  result: ToolExecutionResult,
  approvalStatus?: Extract<PermissionAuthorization, { readonly kind: "denied" }>["approvalStatus"],
): Extract<PermissionAuthorization, { readonly kind: "denied" }> {
  return { kind: "denied", result, approvalStatus };
}

function permissionDenied(message: string): ToolExecutionResult {
  return toolFailure("permission-denied", message, { retryable: true });
}

function approvalInvalid(message: string): ToolExecutionResult {
  return toolFailure("approval-invalid", message, { retryable: true });
}

function permissionConfigFailure(): ToolExecutionResult {
  return toolFailure(
    "permission-config",
    "权限配置无法安全读取或更新，工具未执行。",
    { retryable: true },
  );
}

function cancelledFailure(): ToolExecutionResult {
  return toolFailure("cancelled", "工具授权等待已取消。");
}
