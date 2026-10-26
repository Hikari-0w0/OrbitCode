import assert from "node:assert/strict";
import test from "node:test";
import { createCommandSandbox } from "@/tools/platform-sandbox";
import { LinuxBubblewrapCommandSandbox } from "@/tools/linux-bubblewrap-sandbox";
import { MacOsSeatbeltCommandSandbox } from "@/tools/macos-seatbelt-sandbox";
import { createWorkspaceBoundary } from "@/tools/workspace";

test("沙箱工厂按平台选择后端，默认保留联网", () => {
  assert.ok(createCommandSandbox({}, "darwin") instanceof MacOsSeatbeltCommandSandbox);
  assert.ok(createCommandSandbox({}, "linux") instanceof LinuxBubblewrapCommandSandbox);
});

test("不支持的平台与非法沙箱配置拒绝执行，不降级裸进程", async () => {
  const workspace = await createWorkspaceBoundary(process.cwd());
  for (const sandbox of [
    createCommandSandbox({}, "win32"),
    createCommandSandbox({ ORBITCODE_SANDBOX_NETWORK: "maybe" }),
    createCommandSandbox({ ORBITCODE_SANDBOX_READ_ROOTS: '["relative"]' }),
    createCommandSandbox({ ORBITCODE_SANDBOX_READ_ROOTS: "invalid" }),
  ]) {
    assert.equal((await sandbox.probe(workspace)).available, false);
    await assert.rejects(sandbox.run({ command: "echo should-not-run", cwd: await workspace.resolveExistingDirectory(), timeoutMs: 1000, outputLimitBytes: 100 }, { workspace, signal: new AbortController().signal }));
  }
});
