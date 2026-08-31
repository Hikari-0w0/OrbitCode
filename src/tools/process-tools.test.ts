import assert from "node:assert/strict";
import test from "node:test";

import type { CommandSandbox } from "@/tools/command-sandbox";
import { ManagedProcessController } from "@/tools/managed-process";
import { createProcessTools } from "@/tools/process-tools";
import { createWorkspaceBoundary } from "@/tools/workspace";

test("进程工具拒绝畸形命令和不属于本轮的进程 ID", async () => {
  const workspace = await createWorkspaceBoundary(process.cwd());
  const sandbox: CommandSandbox = {
    async probe() { return { available: true }; },
    async run() { throw new Error("unused"); },
  };
  const controller = new ManagedProcessController(sandbox, workspace);
  const [start, status, stop] = createProcessTools(controller);
  assert.equal(start.prepareUnknown({ command: '"npm dev"' }).kind, "failure");
  const context = {
    workspace,
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 1_000,
  };
  const statusResult = await status.execute({ process_id: "foreign" }, context);
  const stopResult = await stop.execute({ process_id: "foreign" }, context);
  assert.equal(statusResult.ok ? undefined : statusResult.error.kind, "invalid-arguments");
  assert.equal(stopResult.ok ? undefined : stopResult.error.kind, "invalid-arguments");
});
