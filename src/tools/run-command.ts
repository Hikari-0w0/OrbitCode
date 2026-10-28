import { redactCommand } from "./permission-target";
import type { CommandSandbox } from "@/tools/command-sandbox";
import { preflightCommand } from "@/tools/command-preflight";
import { SandboxPreparationError, SandboxUnavailableError } from "@/tools/sandbox-error";
import { runWithSandboxDeadline, waitForSandboxProbe } from "@/tools/sandbox-deadline";
import { defineTool, successfulToolResult } from "@/tools/registry";
import {
  integerSchema,
  objectSchema,
  optionalSchema,
  stringSchema,
  unwrapSingleJsonObjectField,
} from "@/tools/schema";
import { emptyResultMeta, toolFailure } from "@/tools/types";
import type { ToolInputSchema } from "@/tools/types";
import { WORKSPACE_RELATIVE_PATH_DESCRIPTION } from "@/tools/workspace-path";
import { DEFAULT_COMMAND_SECURITY, type CommandSecuritySettings } from "@/tools/command-security";


type RunCommandInput = {
  readonly command: string;
  readonly cwd?: string;
  readonly timeout_ms?: number;
};

function createRunCommandSchema(security: CommandSecuritySettings): ToolInputSchema<RunCommandInput> {
  const baseRunCommandSchema = objectSchema({
    command: stringSchema({ minLength: 1, maxLength: security.maxCommandChars,
      description: "工具返回 shell 的 exitCode、stdout 和 stderr，内置后端使用 Bash pipefail 传播管道失败。exitCode=0 不等于测试通过；分号后的成功命令、|| true、嵌套 shell 或测试脚本仍可掩盖失败。测试或复现请直接运行检查命令，不追加 echo。输出截断时将完整输出重定向到工作区日志并读取失败正文，同时保留检查退出码。",
    }),
    cwd: optionalSchema(stringSchema({
      minLength: 1,
      maxLength: 1024,
      description: WORKSPACE_RELATIVE_PATH_DESCRIPTION,
    })),
    timeout_ms: optionalSchema(integerSchema({ minimum: 100, maximum: security.maxTimeoutMs })),
  });

  return {
    jsonSchema: baseRunCommandSchema.jsonSchema,
    parse(value) {
      const parsed = baseRunCommandSchema.parse(
        unwrapSingleJsonObjectField(value, "command"),
      );
      if (!parsed.ok) return parsed;
      const issues = preflightCommand(parsed.value, security.commandPreflight);
      return issues.length === 0
        ? { ok: true, value: parsed.value }
        : { ok: false, issues };
    },
  };
}

export function createRunCommandTool(sandbox: CommandSandbox) {
  const security = sandbox.security ?? DEFAULT_COMMAND_SECURITY;
  const environmentFiles = security.environmentFileAccess === "allow" ? "命令可读写授权目录内 .env 与 .env.*，仅用于已授权的测试配置" : ".env 与 .env.* 保持保护";
  return defineTool({
    name: "run_command",
    description:
      `在授权 Workspace 内执行必要的 shell 命令。本轮${security.network === "allow" ? "允许联网安装依赖或访问开发服务，无预设域名白名单" : "命令网络已关闭，不要尝试在线安装依赖"}。默认时限${security.defaultTimeoutMs}ms，最长${security.maxTimeoutMs}ms，仍受本轮总时限约束。临时文件请使用 $TMPDIR（${security.temporaryDirectory === "short" ? "工作区专属短路径，跨命令保留，支持Unix socket与依赖缓存" : security.temporaryDirectory === "workspace" ? "工作区 .orbitcode-tmp，跨命令保留" : "每条命令独立，结束后清理"}）。格式预检${security.commandPreflight === "off" ? "关闭，直接交给shell处理" : "启用"}；输出每路最多${security.outputLimitBytes}字节。.npmrc${security.npmrcAccess === "public-only" ? "可读取不含认证信息的公开配置" : "保持保护"}；可写扩展目录：${security.writableRoots.length ? security.writableRoots.join("、") : "无"}。${environmentFiles}；其他凭据文件及未授权目录保持隔离。macOS祖先目录${security.macosAncestorDirectoryAccess === "read" ? "允许打开以兼容运行时，不开放子树文件" : "仅可读取元信息"}。${security.preferFileTools ? "不得用本工具替代 read_file、find_files、search_code、write_file 或 edit_file；仅在专用工具无法合理完成任务时使用。" : "可根据任务选择专用文件工具或shell读取、搜索与修改文件。"}`,
    inputSchema: createRunCommandSchema(security),
    mutability: "command",
    permission: {
      targetKind: "command",
      resolve: (input) => ({
        kind: "command",
        command: input.command,
        cwd: input.cwd,
      }),
    },
    async execute(input, context) {
      let cwd;
      try {
        cwd = await context.workspace.resolveExistingDirectory(input.cwd);
      } catch {
        return toolFailure("permission-denied", "命令工作目录无效。", {
          retryable: true,
        });
      }
      try {
        const remainingMs = context.deadlineMs - Date.now();
        if (remainingMs <= 0) return toolFailure("timeout", "本轮总时限已用尽。");
        const timeoutMs = Math.min(input.timeout_ms ?? security.defaultTimeoutMs, remainingMs);
        const execution = await runWithSandboxDeadline(timeoutMs, context.signal, async signal => {
          const availability = await waitForSandboxProbe(sandbox.probe(context.workspace), signal);
          if (!availability.available) throw new SandboxUnavailableError(availability.message);
          return sandbox.run(
            {
              command: input.command,
              cwd,
              timeoutMs,
              outputLimitBytes: security.outputLimitBytes,
            },
            { workspace: context.workspace, signal },
          );
        });
        const output = { ...execution, command: redactCommand(input.command, 8192), cwd: cwd.relativePath || "." };
        const meta = {
          ...emptyResultMeta(),
          truncated: execution.stdoutTruncated || execution.stderrTruncated,
          truncatedFields: [
            ...(execution.stdoutTruncated ? ["stdout"] : []),
            ...(execution.stderrTruncated ? ["stderr"] : []),
          ],
        };
        if (execution.cancelled) {
          return {
            ...toolFailure("cancelled", "命令执行已取消。", { sideEffect: "possible" }),
            output,
            meta,
          };
        }
        if (execution.timedOut) {
          return {
            ...toolFailure("timeout", "命令执行超时。", {
              retryable: true,
              sideEffect: "possible",
            }),
            output,
            meta,
          };
        }
        if (execution.exitCode !== 0) {
          return {
            ...toolFailure("command-failed", "命令以非零状态结束。", {
              retryable: true,
              sideEffect: "possible",
            }),
            output,
            meta,
          };
        }
        return successfulToolResult(output, "possible", meta);
      } catch (error) {
        if (error instanceof SandboxUnavailableError) {
          return toolFailure("sandbox-unavailable", error.message);
        }
        if (error instanceof SandboxPreparationError) return toolFailure("execution-failed", error.message, { retryable: true });
        return toolFailure("execution-failed", "无法启动隔离命令。", {
          sideEffect: "possible",
        });
      }
    },
  });
}
