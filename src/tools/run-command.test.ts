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

test("命令工具自动解包唯一 command 字段中的合法工具 JSON", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-command-unwrap-"));
  let observed: { readonly command: string; readonly timeoutMs: number } | undefined;
  try {
    const workspace = await createWorkspaceBoundary(root);
    const tool = createRunCommandTool({
      async probe() { return { available: true }; },
      async run(input) {
        observed = { command: input.command, timeoutMs: input.timeoutMs };
        return {
          stdout: "ok",
          stderr: "",
          exitCode: 0,
          terminationSignal: null,
          timedOut: false,
          cancelled: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      },
    });
    const prepared = tool.prepareUnknown({
      command: '{"command":"pwd && ls -la","timeout_ms":5000}',
    });
    assert.equal(prepared.kind, "ready");
    if (prepared.kind !== "ready") return;
    const result = await prepared.call.execute({
      workspace,
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 10_000,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(observed, { command: "pwd && ls -la", timeoutMs: 5_000 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("畸形命令在权限准备和沙箱执行前被拒绝", () => {
  let probed = false;
  const tool = createRunCommandTool({
    async probe() {
      probed = true;
      return { available: true };
    },
    async run() {
      throw new Error("不应执行");
    },
  });

  for (const input of [
    { command: '{"unexpected":"pwd"}' },
    { command: '"pwd"' },
    { command: "cd server && pwd", cwd: "server" },
  ]) {
    const prepared = tool.prepareUnknown(input);
    assert.equal(prepared.kind, "failure");
    if (prepared.kind === "failure") {
      assert.equal(prepared.result.ok, false);
      assert.equal(prepared.result.ok ? undefined : prepared.result.error.kind, "invalid-arguments");
    }
  }
  assert.equal(probed, false);
});
