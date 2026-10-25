import type {
  PermissionPromptSummary,
} from "@/core/permissions/approval";
import type { PermissionSubject } from "@/core/permissions/types";
import type { PreparedToolCall, PermissionOperation } from "@/tools/registry";
import {
  toolFailure,
  type ToolExecutionResult,
  type ToolPermissionTarget,
  type WorkspaceBoundary,
} from "@/tools/types";
import { WorkspaceError } from "@/tools/workspace";

const MAX_COMMAND_SUMMARY_LENGTH = 512;
const SENSITIVE_ASSIGNMENT = /\b((?=[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH))[A-Za-z_][A-Za-z0-9_]*)\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;&|]+)/giu;
const SENSITIVE_FLAG = /(--?(?:api[-_]?key|token|secret|password|passwd|authorization))(?:=|\s+)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;&|]+)/giu;
// 参数可以由多个引号片段拼接，也可以转义空格；不完整引号保守遮蔽至末尾。
const SHELL_ARGUMENT = String.raw`(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'[^']*(?:'|$)|\\[\s\S]|[^\s;&|()"'\\])+`;
const BASIC_AUTH_ARGUMENT = new RegExp(String.raw`(^|[\s;&|()])(--(?:proxy-)?user(?:=|\s+)|-u\s*)(${SHELL_ARGUMENT})`, "giu");
const SENSITIVE_HEADER = /(\b(?:authorization|x-api-key|api-key)\s*:\s*)[^"'\r\n]+/giu;
const SENSITIVE_JSON = /(["'](?:api[_-]?key|access[_-]?token|token|secret|password|passwd|authorization)["']\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/giu;
const URL_CREDENTIAL = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/giu;
const BEARER_TOKEN = /\bBearer\s+[^\s"']+/giu;

export async function resolvePermissionSubject(
  call: PermissionOperation,
  workspace: WorkspaceBoundary,
): Promise<PermissionSubject> {
  const target = call.permissionTarget;
  if (target.kind === "mcp") {
    return { kind: "mcp", toolName: call.name, toolKind: "external", operation: target.operation, serverName: target.serverName, configurationId: target.configurationId, toolIdentity: target.toolIdentity };
  }
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
  if (target.kind === "context") {
    throw new WorkspaceError("invalid-path", "内部上下文引用不能作为 Workspace 权限目标。");
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
  if (subject.kind === "mcp") return target?.kind === "mcp" ? target.summary : { serverName: subject.serverName, operation: subject.operation };
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
  const reason = error instanceof WorkspaceError ? error.kind : "unresolved";
  const result = error instanceof WorkspaceError && (error.kind === "not-directory" || error.kind === "not-file")
    ? toolFailure("invalid-arguments", error.kind === "not-directory"
      ? "工具目标要求目录，但收到文件；search_code.path 只能传目录，单文件使用 file_pattern。"
      : "工具目标要求文件，但收到目录；先用 find_files 查找文件。", { retryable: true })
    : error instanceof WorkspaceError && error.kind === "protected-path"
      ? toolFailure("protected-path", "工具不能访问受保护的配置或凭据路径。", { retryable: true })
      : error instanceof WorkspaceError && error.kind === "not-found"
        ? toolFailure("not-found", "目标在当前 Workspace 根目录下不可见；请核对根目录内的相对路径。这不能证明工作区外的同名文件不存在、已删除或属于旧副本。若原失败测试位于工作区外，请用户提供 import 与原始断言，不要猜测被测入口。", { retryable: true })
        : toolFailure("workspace-boundary", "无法验证目标位于授权 Workspace；请使用合法相对路径。", { retryable: true });
  return { ...result, output: { targetFailureReason: reason } };
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

export function redactCommand(command: string, maxLength = MAX_COMMAND_SUMMARY_LENGTH): string {
  const redacted = command
    .replace(BASIC_AUTH_ARGUMENT, (match: string, prefix: string, flag: string, _argument: string, offset: number, original: string) => {
      // -u 也可表示 Python 无缓冲输出；短参仅在 curl 调用后视为认证参数。
      if (flag.startsWith("-u") && !flag.startsWith("--") && !/\bcurl(?:\s|$)/iu.test(original.slice(0, offset))) return match;
      return `${prefix}${flag}<redacted>`;
    })
    .replace(SENSITIVE_ASSIGNMENT, "$1=<redacted>")
    .replace(SENSITIVE_FLAG, "$1=<redacted>")
    .replace(SENSITIVE_HEADER, "$1<redacted>")
    .replace(SENSITIVE_JSON, '$1"<redacted>"')
    .replace(URL_CREDENTIAL, "$1<redacted>@")
    .replace(BEARER_TOKEN, "Bearer <redacted>");
  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, maxLength)}…`;
}
