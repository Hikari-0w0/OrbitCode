import type {
  PermissionPromptSummary,
} from "@/core/permissions/approval";
import type { PermissionSubject } from "@/core/permissions/types";
import type { PreparedToolCall } from "@/tools/registry";
import {
  toolFailure,
  type ToolExecutionResult,
  type ToolPermissionTarget,
  type WorkspaceBoundary,
} from "@/tools/types";
import { WorkspaceError } from "@/tools/workspace";

const MAX_COMMAND_SUMMARY_LENGTH = 512;
const SENSITIVE_ASSIGNMENT = /\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH)[A-Za-z0-9_]*)=([^\s]+)/giu;
const SENSITIVE_FLAG = /(--?(?:api[-_]?key|token|secret|password|passwd|authorization))(?:=|\s+)([^\s]+)/giu;
const BEARER_TOKEN = /\bBearer\s+[^\s]+/giu;

export async function resolvePermissionSubject(
  call: PreparedToolCall,
  workspace: WorkspaceBoundary,
): Promise<PermissionSubject> {
  const target = call.permissionTarget;
  if (target.kind === "command") {
    const cwd = await workspace.resolveExistingDirectory(target.cwd);
    const command = target.command.trim();
    if (command.length === 0) {
      throw new WorkspaceError("invalid-path", "命令不能为空。");
    }
    return {
      kind: "command",
      toolName: call.name,
      toolKind: "command",
      command,
      canonicalCwd: cwd.relativePath,
    };
  }

  const resolved = await resolvePathTarget(target, workspace);
  return {
    kind: "path",
    toolName: call.name,
    toolKind: call.mutability === "read-only" ? "read" : "write",
    requestedPath: target.requestedPath,
    canonicalRelativePath: resolved.relativePath,
  };
}

export function summarizePermissionSubject(
  subject: PermissionSubject,
  target?: ToolPermissionTarget,
): PermissionPromptSummary {
  if (subject.kind === "path") {
    const summary: PermissionPromptSummary = {
      operation: subject.toolKind === "read" ? "读取" : "写入",
      path: subject.canonicalRelativePath,
    };
    return target?.kind === "path" && target.byteLength !== undefined
      ? { ...summary, bytes: target.byteLength }
      : summary;
  }
  return {
    operation: "执行命令",
    command: redactCommand(subject.command),
    cwd: subject.canonicalCwd,
  };
}

export function permissionTargetFailure(error: unknown): ToolExecutionResult {
  if (!(error instanceof WorkspaceError)) {
    return toolFailure("workspace-boundary", "无法验证工具目标是否位于 Workspace 内。", {
      retryable: true,
    });
  }
  if (error.kind === "protected-path") {
    return toolFailure("protected-path", "工具不能访问受保护的配置或凭据路径。", {
      retryable: true,
    });
  }
  if (error.kind === "not-found") {
    return toolFailure("not-found", "工具目标不存在。", { retryable: true });
  }
  return toolFailure("workspace-boundary", "工具目标超出授权 Workspace 或路径无效。", {
    retryable: true,
  });
}

async function resolvePathTarget(
  target: Extract<PreparedToolCall["permissionTarget"], { readonly kind: "path" }>,
  workspace: WorkspaceBoundary,
) {
  if (target.resolution === "existing-file") {
    return workspace.resolveExistingFile(target.requestedPath);
  }
  if (target.resolution === "existing-directory") {
    return workspace.resolveExistingDirectory(target.requestedPath);
  }
  return workspace.resolveWriteTarget(target.requestedPath);
}

function redactCommand(command: string): string {
  const redacted = command
    .replace(SENSITIVE_ASSIGNMENT, "$1=<redacted>")
    .replace(SENSITIVE_FLAG, "$1=<redacted>")
    .replace(BEARER_TOKEN, "Bearer <redacted>");
  if (redacted.length <= MAX_COMMAND_SUMMARY_LENGTH) return redacted;
  return `${redacted.slice(0, MAX_COMMAND_SUMMARY_LENGTH)}…`;
}
