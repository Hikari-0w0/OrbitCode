import type { CommandSandbox } from "@/tools/command-sandbox";
import { SandboxUnavailableError } from "@/tools/macos-seatbelt-sandbox";
import { defineTool, successfulToolResult } from "@/tools/registry";
import {
  integerSchema,
  objectSchema,
  optionalSchema,
  stringSchema,
} from "@/tools/schema";
import { emptyResultMeta, toolFailure } from "@/tools/types";

const DEFAULT_TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT_BYTES = 128 * 1024;

export function createRunCommandTool(sandbox: CommandSandbox) {
  return defineTool({
    name: "run_command",
    description: "在严格隔离的授权工作目录内执行 shell 命令。",
    inputSchema: objectSchema({
      command: stringSchema({ minLength: 1, maxLength: 8 * 1024 }),
      cwd: optionalSchema(stringSchema({ minLength: 1, maxLength: 1_024 })),
      timeout_ms: optionalSchema(integerSchema({ minimum: 100, maximum: 120_000 })),
    }),
    mutability: "command",
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
        const availability = await sandbox.probe(context.workspace);
        if (!availability.available) {
          return toolFailure("sandbox-unavailable", "严格命令沙箱不可用。");
        }
        const execution = await sandbox.run(
          {
            command: input.command,
            cwd,
            timeoutMs: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
            outputLimitBytes: OUTPUT_LIMIT_BYTES,
          },
          { workspace: context.workspace, signal: context.signal },
        );
        const output = { ...execution };
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
