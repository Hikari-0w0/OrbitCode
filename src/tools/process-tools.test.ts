import assert from "node:assert/strict";
import test from "node:test";

import type { CommandSandbox } from "@/tools/command-sandbox";
import { ManagedProcessController, ManagedProcessError } from "@/tools/managed-process";
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

test("进程启动失败时直接返回可诊断日志且不返回进程 ID", async () => {
  const workspace = await createWorkspaceBoundary(process.cwd());
  const sandbox: CommandSandbox = {
    async probe() { return { available: true }; },
    async run() { throw new Error("unused"); },
  };
  const controller = new ManagedProcessController(sandbox, workspace);
  const [start] = createProcessTools(controller);
  const originalStart = controller.start.bind(controller);
  controller.start = async () => {
    throw new ManagedProcessError(
      "not-ready",
      "进程在端口就绪前已经退出。",
      { processAvailable: false, logs: [{ cursor: 1, stream: "stdout", text: "config-broken" }] },
    );
  };
  try {
    const result = await start.execute(
      { command: "npm run dev", ready_port: 3000 },
      {
        workspace,
        signal: new AbortController().signal,
        deadlineMs: Date.now() + 1_000,
      },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(result.output, {
      processAvailable: false,
      logs: [{ cursor: 1, stream: "stdout", text: "config-broken" }],
    });
    assert.equal(JSON.stringify(result.output).includes("processId"), false);
  } finally {
    controller.start = originalStart;
  }
});
