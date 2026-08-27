import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { CommandSandbox } from "@/tools/command-sandbox";
import { createRunCommandTool } from "@/tools/run-command";
import { createWorkspaceBoundary } from "@/tools/workspace";

test("命令工具保留非零退出、输出、超时和取消字段", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-command-tool-"));
  try {
    const workspace = await createWorkspaceBoundary(root);
    const sandbox: CommandSandbox = {
      async probe() {
        return { available: true };
      },
      async run() {
        return {
          stdout: "out",
          stderr: "err",
          exitCode: 7,
          terminationSignal: null,
          timedOut: false,
          cancelled: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      },
    };
    const tool = createRunCommandTool(sandbox);
    const result = await tool.execute(
      { command: "exit 7" },
      { workspace, signal: new AbortController().signal, deadlineMs: Date.now() + 1_000 },
    );
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.error.kind, "command-failed");
    assert.deepEqual(result.ok ? undefined : result.output, {
      stdout: "out",
      stderr: "err",
      exitCode: 7,
      terminationSignal: null,
      timedOut: false,
      cancelled: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("命令工具拒绝非法 cwd 和不可用沙箱", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-command-failure-"));
  try {
    const workspace = await createWorkspaceBoundary(root);
    const sandbox: CommandSandbox = {
      async probe() {
        return { available: false, message: "unavailable" };
      },
      async run() {
        throw new Error("should not run");
      },
    };
    const tool = createRunCommandTool(sandbox);
    const invalidCwd = await tool.execute(
      { command: "pwd", cwd: "../" },
      { workspace, signal: new AbortController().signal, deadlineMs: Date.now() + 1_000 },
    );
    assert.equal(invalidCwd.ok ? undefined : invalidCwd.error.kind, "permission-denied");
    const unavailable = await tool.execute(
      { command: "pwd" },
      { workspace, signal: new AbortController().signal, deadlineMs: Date.now() + 1_000 },
    );
    assert.equal(
      unavailable.ok ? undefined : unavailable.error.kind,
      "sandbox-unavailable",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
