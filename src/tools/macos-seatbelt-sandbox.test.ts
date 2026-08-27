import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MacOsSeatbeltCommandSandbox } from "@/tools/macos-seatbelt-sandbox";
import { createWorkspaceBoundary } from "@/tools/workspace";

test("Seatbelt 允许工作区命令并阻断外部、敏感与环境逃逸", async () => {
  assert.equal(process.platform, "darwin", "当前验收环境必须执行 Darwin 安全用例");
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-seatbelt-"));
  const outside = await mkdtemp(path.join(tmpdir(), "orbitcode-seatbelt-outside-"));
  const previousSentinel = process.env.ORBITCODE_SANDBOX_SENTINEL;
  process.env.ORBITCODE_SANDBOX_SENTINEL = "must-not-leak";
  try {
    await writeFile(path.join(root, "inside.txt"), "inside");
    await writeFile(path.join(root, ".env"), "SECRET=must-not-leak");
    await writeFile(path.join(outside, "outside.txt"), "outside");
    const workspace = await createWorkspaceBoundary(root);
    const cwd = await workspace.resolveExistingDirectory();
    const sandbox = new MacOsSeatbeltCommandSandbox();
    assert.deepEqual(await sandbox.probe(workspace), { available: true });
    const allowed = await sandbox.run(
      {
        command: "cat inside.txt; printf err >&2; exit 7",
        cwd,
        timeoutMs: 2_000,
        outputLimitBytes: 1_024,
      },
      { workspace, signal: new AbortController().signal },
    );
    assert.equal(allowed.stdout, "inside");
    assert.equal(allowed.stderr, "err");
    assert.equal(allowed.exitCode, 7);

    const networkServer = createServer();
    await new Promise<void>((resolve, reject) => {
      networkServer.once("error", reject);
      networkServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = networkServer.address();
    if (typeof address === "string" || address === null) {
      throw new Error("测试网络服务没有可用端口。");
    }
    try {
      for (const command of [
        `cat '${path.join(outside, "outside.txt")}'`,
        `cat '${path.relative(root, path.join(outside, "outside.txt"))}'`,
        "cat /private/etc/hosts",
        "cat .env",
        "test -n \"${ORBITCODE_SANDBOX_SENTINEL:-}\"",
        `sh -c \"cat '${path.join(outside, "outside.txt")}'\"`,
        `node -e \"require('node:fs').readFileSync('${path.join(outside, "outside.txt")}')\"`,
        `/usr/bin/nc -G 1 127.0.0.1 ${address.port}`,
      ]) {
        const result = await sandbox.run(
          { command, cwd, timeoutMs: 2_000, outputLimitBytes: 1_024 },
          { workspace, signal: new AbortController().signal },
        );
        assert.notEqual(result.exitCode, 0, command);
        assert.equal(`${result.stdout}${result.stderr}`.includes("must-not-leak"), false);
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        networkServer.close((error) => error ? reject(error) : resolve());
      });
    }
  } finally {
    if (previousSentinel === undefined) delete process.env.ORBITCODE_SANDBOX_SENTINEL;
    else process.env.ORBITCODE_SANDBOX_SENTINEL = previousSentinel;
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("Seatbelt 命令输出受限并可超时终止进程组", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-seatbelt-timeout-"));
  try {
    const workspace = await createWorkspaceBoundary(root);
    const cwd = await workspace.resolveExistingDirectory();
    const sandbox = new MacOsSeatbeltCommandSandbox();
    const truncated = await sandbox.run(
      {
        command: "printf 1234567890; printf abcdefghij >&2",
        cwd,
        timeoutMs: 2_000,
        outputLimitBytes: 4,
      },
      { workspace, signal: new AbortController().signal },
    );
    assert.equal(truncated.stdout, "1234");
    assert.equal(truncated.stderr, "abcd");
    assert.equal(truncated.stdoutTruncated, true);
    assert.equal(truncated.stderrTruncated, true);

    const timedOut = await sandbox.run(
      { command: "trap '' TERM; sleep 5", cwd, timeoutMs: 100, outputLimitBytes: 100 },
      { workspace, signal: new AbortController().signal },
    );
    assert.equal(timedOut.timedOut, true);
    assert.notEqual(timedOut.terminationSignal, null);

    const controller = new AbortController();
    const cancelledRun = sandbox.run(
      { command: "sleep 5", cwd, timeoutMs: 2_000, outputLimitBytes: 100 },
      { workspace, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 50);
    const cancelled = await cancelledRun;
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.timedOut, false);
    assert.notEqual(cancelled.terminationSignal, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
