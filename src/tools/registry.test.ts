import assert from "node:assert/strict";
import test from "node:test";

import type { CommandSandbox } from "@/tools/command-sandbox";
import { createDefaultToolRegistry } from "@/tools/default-registry";
import { objectSchema, stringSchema } from "@/tools/schema";
import {
  defineTool,
  successfulToolResult,
  ToolRegistry,
} from "@/tools/registry";
import { createWorkspaceBoundary } from "@/tools/workspace";
import type { WorkspaceBoundary } from "@/tools/types";

let workspace: WorkspaceBoundary | undefined;
test.before(async () => {
  workspace = await createWorkspaceBoundary(process.cwd());
});

function context(signal = new AbortController().signal, timeoutMs = 1_000) {
  if (!workspace) throw new Error("测试工作区尚未初始化。");
  return { workspace, signal, deadlineMs: Date.now() + timeoutMs };
}

test("注册中心按登记顺序生成定义并拒绝重复名称", () => {
  const tool = fakeTool();
  const registry = new ToolRegistry([tool]);
  assert.deepEqual(registry.definitions(), [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "测试工具",
        parameters: tool.inputSchema.jsonSchema,
      },
    },
  ]);
  assert.throws(() => new ToolRegistry([tool, tool]), /工具名称重复/);
});

test("默认注册中心恰好公开六个核心工具", () => {
  const sandbox: CommandSandbox = {
    async probe() {
      return { available: false, message: "测试不执行命令" };
    },
    async run() {
      throw new Error("测试不应执行命令");
    },
  };
  const registry = createDefaultToolRegistry(sandbox);
  const first = registry.definitions();
  const second = registry.definitions();
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.map((definition) => definition.function.name),
    [
      "read_file",
      "write_file",
      "edit_file",
      "run_command",
      "find_files",
      "search_code",
    ],
  );
  assert.equal(first.every(
    (definition) => definition.function.parameters.additionalProperties === false,
  ), true);

  const descriptions = new Map(
    first.map((definition) => [
      definition.function.name,
      definition.function.description,
    ]),
  );
  assert.match(descriptions.get("read_file") ?? "", /优先使用本工具/u);
  assert.match(descriptions.get("write_file") ?? "", /覆盖已有文件前必须先用 read_file/u);
  assert.match(descriptions.get("edit_file") ?? "", /调用前必须先用 read_file/u);
  assert.match(descriptions.get("run_command") ?? "", /不得用本工具替代/u);
  assert.match(descriptions.get("find_files") ?? "", /优先于 shell/u);
  assert.match(descriptions.get("search_code") ?? "", /优先于 shell/u);
});

test("默认工具定义明确要求 Workspace 相对路径", () => {
  const sandbox: CommandSandbox = {
    async probe() {
      return { available: true };
    },
    async run() {
      throw new Error("本测试不执行命令");
    },
  };
  const registry = createDefaultToolRegistry(sandbox);

  for (const definition of registry.definitions()) {
    assert.match(
      JSON.stringify(definition.function.parameters),
      /相对当前 Workspace 根目录的 POSIX 路径/u,
      definition.function.name,
    );
  }
});

test("非法参数和未知工具不会触发副作用", async () => {
  let executions = 0;
  const registry = new ToolRegistry([fakeTool(() => executions++)]);

  const invalid = await registry.execute("read_file", { path: "", extra: 1 }, context());
  const unknown = await registry.execute("not_a_tool", {}, context());

  assert.equal(invalid.ok, false);
  assert.equal(invalid.ok ? undefined : invalid.error.kind, "invalid-arguments");
  assert.equal(unknown.ok, false);
  assert.equal(executions, 0);
});

test("执行异常、超时和调用方取消被结构化收敛", async () => {
  const throwing = new ToolRegistry([
    fakeTool(() => {
      throw new Error("secret internal failure");
    }),
  ]);
  const failure = await throwing.execute("read_file", { path: "ok" }, context());
  assert.equal(failure.ok ? undefined : failure.error.kind, "execution-failed");
  assert.equal(JSON.stringify(failure).includes("secret internal failure"), false);

  const hanging = new ToolRegistry([
    fakeTool(() => new Promise<void>(() => undefined)),
  ]);
  const timeout = await hanging.execute("read_file", { path: "ok" }, context(undefined, 5));
  assert.equal(timeout.ok ? undefined : timeout.error.kind, "timeout");

  const controller = new AbortController();
  controller.abort();
  const cancelled = await throwing.execute("read_file", { path: "ok" }, context(controller.signal));
  assert.equal(cancelled.ok ? undefined : cancelled.error.kind, "cancelled");
});

function fakeTool(onExecute: () => unknown = () => undefined) {
  return defineTool({
    name: "read_file",
    description: "测试工具",
    inputSchema: objectSchema({ path: stringSchema({ minLength: 1 }) }),
    mutability: "read-only",
    async execute(input) {
      await onExecute();
      return successfulToolResult({ path: input.path });
    },
  });
}
