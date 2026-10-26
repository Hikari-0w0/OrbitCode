import { redactCommand } from "./permission-target";
import type { CommandSandbox } from "@/tools/command-sandbox";
import { preflightCommand } from "@/tools/command-preflight";
import { SandboxUnavailableError } from "@/tools/sandbox-error";
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

const DEFAULT_TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT_BYTES = 128 * 1024;

type RunCommandInput = {
  readonly command: string;
  readonly cwd?: string;
  readonly timeout_ms?: number;
};

const baseRunCommandSchema = objectSchema({
  command: stringSchema({ minLength: 1, maxLength: 8 * 1024,
    description: "工具会自动返回原始 exitCode、stdout 和 stderr。测试或复现时直接运行检查命令；不要为显示退出码追加 echo、|| true 或其他会覆盖失败退出码的命令。",
  }),
  cwd: optionalSchema(stringSchema({
    minLength: 1,
    maxLength: 1_024,
    description: WORKSPACE_RELATIVE_PATH_DESCRIPTION,
  })),
  timeout_ms: optionalSchema(integerSchema({ minimum: 100, maximum: 120_000 })),
});

const runCommandSchema: ToolInputSchema<RunCommandInput> = {
  jsonSchema: baseRunCommandSchema.jsonSchema,
  parse(value) {
    const parsed = baseRunCommandSchema.parse(
      unwrapSingleJsonObjectField(value, "command"),
    );
    if (!parsed.ok) return parsed;
    const issues = preflightCommand(parsed.value);
    return issues.length === 0
      ? { ok: true, value: parsed.value }
      : { ok: false, issues };
  },
};

export function createRunCommandTool(sandbox: CommandSandbox) {
  return defineTool({
    name: "run_command",
    description:
      "在严格文件隔离的授权 Workspace 内执行确有必要的 shell 命令，可联网安装依赖或访问开发服务。不得用本工具替代 read_file、find_files、search_code、write_file 或 edit_file；仅在专用工具无法合理完成任务时使用。",
    inputSchema: runCommandSchema,
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
        const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
        const execution = await runWithSandboxDeadline(timeoutMs, context.signal, async signal => {
          const availability = await waitForSandboxProbe(sandbox.probe(context.workspace), signal);
          if (!availability.available) throw new SandboxUnavailableError(availability.message);
          return sandbox.run(
            {
              command: input.command,
              cwd,
              timeoutMs,
              outputLimitBytes: OUTPUT_LIMIT_BYTES,
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
        return toolFailure("execution-failed", "无法启动隔离命令。", {
          sideEffect: "possible",
        });
      }
    },
  });
}
