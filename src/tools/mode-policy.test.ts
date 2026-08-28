import assert from "node:assert/strict";
import test from "node:test";

import { createModeToolPolicy } from "@/tools/mode-policy";
import { defineTool, successfulToolResult, ToolRegistry } from "@/tools/registry";
import { objectSchema, stringSchema } from "@/tools/schema";
import { createWorkspaceBoundary } from "@/tools/workspace";
import type { WorkspaceBoundary } from "@/tools/types";

let workspace: WorkspaceBoundary | undefined;
test.before(async () => {
  workspace = await createWorkspaceBoundary(process.cwd());
});

test("Plan 只公开三个只读工具，Do 恢复全部工具", () => {
  const registry = new ToolRegistry([
    fakeTool("read_file", "read-only"),
    fakeTool("find_files", "read-only"),
    fakeTool("search_code", "read-only"),
    fakeTool("write_file", "workspace-write"),
    fakeTool("edit_file", "workspace-write"),
    fakeTool("run_command", "command"),
  ]);

  assert.deepEqual(
    createModeToolPolicy(registry, "plan").definitions().map(
      (definition) => definition.function.name,
    ),
    ["read_file", "find_files", "search_code"],
  );
  assert.deepEqual(
    createModeToolPolicy(registry, "do").definitions().map(
      (definition) => definition.function.name,
    ),
    [
      "read_file",
      "find_files",
      "search_code",
      "write_file",
      "edit_file",
      "run_command",
    ],
  );
});

test("Plan 在执行入口拒绝副作用工具且不进入底层执行", async () => {
  let executions = 0;
  const registry = new ToolRegistry([
    fakeTool("write_file", "workspace-write", () => executions++),
  ]);
  const plan = createModeToolPolicy(registry, "plan");
  const result = await plan.execute("write_file", { path: "a" }, context());

  assert.equal(result.ok, false);
  assert.equal(result.ok ? undefined : result.error.kind, "permission-denied");
  assert.equal(result.sideEffect, "none");
  assert.equal(executions, 0);

  const allowed = await createModeToolPolicy(registry, "do").execute(
    "write_file",
    { path: "a" },
    context(),
  );
  assert.equal(allowed.ok, true);
  assert.equal(executions, 1);
});

test("未知工具与模式拒绝使用不同分类", async () => {
  const registry = new ToolRegistry([fakeTool("write_file", "workspace-write")]);
  const plan = createModeToolPolicy(registry, "plan");

  assert.deepEqual(plan.classify("write_file"), { kind: "denied" });
  assert.deepEqual(plan.classify("invented"), { kind: "unknown" });
  const unknown = await plan.execute("invented", {}, context());
  assert.equal(unknown.ok ? undefined : unknown.error.kind, "unknown-tool");
});

function fakeTool(
  name: "read_file" | "find_files" | "search_code" | "write_file" | "edit_file" | "run_command",
  mutability: "read-only" | "workspace-write" | "command",
  onExecute: () => void = () => undefined,
) {
  return defineTool({
    name,
    description: "测试工具",
    inputSchema: objectSchema({ path: stringSchema({ minLength: 1 }) }),
    mutability,
    async execute() {
      onExecute();
      return successfulToolResult({ ok: true });
    },
  });
}

function context() {
  if (!workspace) throw new Error("测试工作区尚未初始化。");
  return {
    workspace,
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 1_000,
  };
}
