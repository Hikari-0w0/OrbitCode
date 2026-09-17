import { preflightCommand } from "@/tools/command-preflight";
import {
  ManagedProcessController,
  ManagedProcessError,
} from "@/tools/managed-process";
import { defineTool, successfulToolResult } from "@/tools/registry";
import {
  integerSchema,
  objectSchema,
  optionalSchema,
  stringSchema,
} from "@/tools/schema";
import { toolFailure, type ToolExecutionResult, type ToolInputSchema } from "@/tools/types";
import { WORKSPACE_RELATIVE_PATH_DESCRIPTION } from "@/tools/workspace-path";

type StartProcessInput = {
  readonly command: string;
  readonly cwd?: string;
  readonly ready_port?: number;
  readonly ready_timeout_ms?: number;
};

const baseStartProcessSchema = objectSchema({
  command: stringSchema({ minLength: 1, maxLength: 8 * 1024 }),
  cwd: optionalSchema(stringSchema({
    minLength: 1,
    maxLength: 1_024,
    description: WORKSPACE_RELATIVE_PATH_DESCRIPTION,
  })),
  ready_port: optionalSchema(integerSchema({ minimum: 1, maximum: 65_535 })),
  ready_timeout_ms: optionalSchema(integerSchema({ minimum: 100, maximum: 30_000 })),
});

const startProcessSchema: ToolInputSchema<StartProcessInput> = {
  jsonSchema: baseStartProcessSchema.jsonSchema,
  parse(value) {
    const parsed = baseStartProcessSchema.parse(value);
    if (!parsed.ok) return parsed;
    const issues = preflightCommand(parsed.value);
    return issues.length === 0
      ? { ok: true, value: parsed.value }
      : { ok: false, issues };
  },
};

export function createProcessTools(controller: ManagedProcessController) {
  const startProcessTool = defineTool({
    name: "start_process",
    description:
      "在严格沙箱中启动本轮临时进程；本轮完成、取消或失败后会自动关闭，不能承诺最终回复后预览仍可访问。ready_port 在启动前已被占用时拒绝启动；启动后的端口探测仅证明 loopback TCP 可连接，不证明进程归属、HTTP 内容或应用功能。应根据实际任务选择后续验证。仅成功返回的 processId 可用于 process_status/stop_process，调用或证据 ID 不是 process_id。",
    inputSchema: startProcessSchema,
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
      try {
        const snapshot = await controller.start({
          command: input.command,
          cwd: input.cwd,
          readyPort: input.ready_port,
          readyTimeoutMs: input.ready_timeout_ms,
          signal: context.signal,
        });
        return successfulToolResult(snapshot, "possible");
      } catch (error) {
        return processFailure(error);
      }
    },
  });

  const processStatusTool = defineTool({
    name: "process_status",
    description:
      "读取本轮受管进程的状态和 cursor 之后的增量 stdout/stderr；不会访问其他运行或系统进程。",
    inputSchema: objectSchema({
      process_id: stringSchema({ minLength: 1, maxLength: 128 }),
      cursor: optionalSchema(integerSchema({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    }),
    mutability: "read-only",
    permission: {
      targetKind: "context",
      resolve: (input) => ({ kind: "context", reference: input.process_id }),
    },
    async execute(input) {
      try {
        return successfulToolResult(controller.status(input.process_id, input.cursor));
      } catch (error) {
        return processFailure(error);
      }
    },
  });

  const stopProcessTool = defineTool({
    name: "stop_process",
    description: "停止本轮由 start_process 创建的受管进程并返回最终状态。",
    inputSchema: objectSchema({
      process_id: stringSchema({ minLength: 1, maxLength: 128 }),
    }),
    mutability: "command",
    permission: {
      targetKind: "context",
      resolve: (input) => ({ kind: "context", reference: input.process_id }),
    },
    async execute(input) {
      try {
        return successfulToolResult(await controller.stop(input.process_id), "possible");
      } catch (error) {
        return processFailure(error);
      }
    },
  });

  return [startProcessTool, processStatusTool, stopProcessTool] as const;
}

function processFailure(error: unknown): ToolExecutionResult {
  if (!(error instanceof ManagedProcessError)) {
    return toolFailure("execution-failed", "受管进程操作失败。", {
      sideEffect: "possible",
    });
  }
  if (error.kind === "unavailable") {
    return toolFailure("sandbox-unavailable", error.message);
  }
  if (error.kind === "cancelled") {
    return toolFailure("cancelled", error.message);
  }
  if (error.kind === "port-in-use") {
    return {
      ...toolFailure("execution-failed", error.message, { retryable: true, sideEffect: "none" }),
      output: { processAvailable: false, reason: "port-in-use" },
    };
  }
  if (error.kind === "limit") {
    return toolFailure("limit-exceeded", error.message, { retryable: true });
  }
  if (error.kind === "invalid-id") {
    return toolFailure("invalid-arguments", error.message, { retryable: true });
  }
  if (error.kind === "not-ready") {
    const message = error.processAvailable === false
      ? `${error.message} 进程已回收，没有可用 process_id；请根据日志修复后重新调用 start_process。`
      : error.message;
    const failure = toolFailure("timeout", message, {
      retryable: true,
      sideEffect: "possible",
    });
    return error.processAvailable === false
      ? {
          ...failure,
          output: {
            processAvailable: false,
            logs: error.logs,
          },
        }
      : failure;
  }
  return toolFailure("execution-failed", error.message, { sideEffect: "possible" });
}
