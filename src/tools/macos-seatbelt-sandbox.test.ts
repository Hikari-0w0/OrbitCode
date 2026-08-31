import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
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
    const hiddenRuntime = await sandbox.run(
      {
        command: "test ! -e .orbitcode-runtime",
        cwd,
        timeoutMs: 2_000,
        outputLimitBytes: 1_024,
      },
      { workspace, signal: new AbortController().signal },
    );
    assert.equal(hiddenRuntime.exitCode, 0, "沙箱私有运行目录不得污染 Workspace");

    for (const command of [
      `cat '${path.join(outside, "outside.txt")}'`,
      `cat '${path.relative(root, path.join(outside, "outside.txt"))}'`,
      "cat /private/etc/hosts",
      "cat .env",
      "test -n \"${ORBITCODE_SANDBOX_SENTINEL:-}\"",
      `sh -c \"cat '${path.join(outside, "outside.txt")}'\"`,
      `node -e \"require('node:fs').readFileSync('${path.join(outside, "outside.txt")}')\"`,
    ]) {
      const result = await sandbox.run(
        { command, cwd, timeoutMs: 2_000, outputLimitBytes: 1_024 },
        { workspace, signal: new AbortController().signal },
      );
      assert.notEqual(result.exitCode, 0, command);
      assert.equal(`${result.stdout}${result.stderr}`.includes("must-not-leak"), false);
    }
  } finally {
    if (previousSentinel === undefined) delete process.env.ORBITCODE_SANDBOX_SENTINEL;
    else process.env.ORBITCODE_SANDBOX_SENTINEL = previousSentinel;
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("Seatbelt 允许命令访问网络，同时保持最小环境", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-seatbelt-network-"));
  const networkServer = createNetServer((socket) => socket.end());
  const httpServer = createHttpServer((_request, response) => response.end("ok"));
  const previousSentinel = process.env.ORBITCODE_SANDBOX_SENTINEL;
  process.env.ORBITCODE_SANDBOX_SENTINEL = "must-not-leak";
  try {
    await new Promise<void>((resolve, reject) => {
      networkServer.once("error", reject);
      networkServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = networkServer.address();
    if (typeof address === "string" || address === null) {
      throw new Error("测试网络服务没有可用端口。");
    }
    const workspace = await createWorkspaceBoundary(root);
    const cwd = await workspace.resolveExistingDirectory();
    const sandbox = new MacOsSeatbeltCommandSandbox();
    const result = await sandbox.run(
      {
        command: `/usr/bin/nc -G 1 -z 127.0.0.1 ${address.port}`,
        cwd,
        timeoutMs: 5_000,
        outputLimitBytes: 1_024,
      },
      { workspace, signal: new AbortController().signal },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(`${result.stdout}${result.stderr}`, /succeeded/u);
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", () => resolve());
    });
    const httpAddress = httpServer.address();
    if (typeof httpAddress === "string" || httpAddress === null) {
      throw new Error("测试 HTTP 服务没有可用端口。");
    }
    const curl = await sandbox.run(
      {
        command: `/usr/bin/curl -fsS http://127.0.0.1:${httpAddress.port}`,
        cwd,
        timeoutMs: 5_000,
        outputLimitBytes: 1_024,
      },
      { workspace, signal: new AbortController().signal },
    );
    assert.equal(curl.exitCode, 0, curl.stdout || curl.stderr);
    assert.equal(curl.stdout, "ok");
    const environment = await sandbox.run(
      {
        command: "test -z \"${ORBITCODE_SANDBOX_SENTINEL:-}\"",
        cwd,
        timeoutMs: 2_000,
        outputLimitBytes: 1_024,
      },
      { workspace, signal: new AbortController().signal },
    );
    assert.equal(environment.exitCode, 0);
  } finally {
    if (previousSentinel === undefined) delete process.env.ORBITCODE_SANDBOX_SENTINEL;
    else process.env.ORBITCODE_SANDBOX_SENTINEL = previousSentinel;
    await new Promise<void>((resolve) => networkServer.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
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

test("Seatbelt 允许命令安全使用 /dev/null", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-seatbelt-dev-null-"));
  try {
    const workspace = await createWorkspaceBoundary(root);
    const cwd = await workspace.resolveExistingDirectory();
    const sandbox = new MacOsSeatbeltCommandSandbox();
    const result = await sandbox.run(
      {
        command: "printf ignored >/dev/null; printf ok",
        cwd,
        timeoutMs: 2_000,
        outputLimitBytes: 1_024,
      },
      { workspace, signal: new AbortController().signal },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "ok");
    assert.equal(result.stderr, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Seatbelt 允许当前 Node 运行时内的 npm 启动且不强制生产依赖", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-seatbelt-node-runtime-"));
  try {
    const workspace = await createWorkspaceBoundary(root);
    const cwd = await workspace.resolveExistingDirectory();
    const sandbox = new MacOsSeatbeltCommandSandbox();
    const result = await sandbox.run(
      {
        command: "test -z \"${NODE_ENV:-}\" && test \"$(npm config get omit)\" != dev && npm --version",
        cwd,
        timeoutMs: 10_000,
        outputLimitBytes: 4_096,
      },
      { workspace, signal: new AbortController().signal },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/u);
    assert.equal(result.stderr, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Seatbelt 允许系统 C++ 工具链编译 Workspace 源码", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-seatbelt-cpp-"));
  try {
    await writeFile(
      path.join(root, "main.cpp"),
      "#include <iostream>\nint main() { std::cout << 42; }\n",
    );
    const workspace = await createWorkspaceBoundary(root);
    const cwd = await workspace.resolveExistingDirectory();
    const sandbox = new MacOsSeatbeltCommandSandbox();
    const result = await sandbox.run(
      {
        command: "c++ main.cpp -o main && ./main",
        cwd,
        timeoutMs: 20_000,
        outputLimitBytes: 16_384,
      },
      { workspace, signal: new AbortController().signal },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, "42");
    assert.equal(result.stderr, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
