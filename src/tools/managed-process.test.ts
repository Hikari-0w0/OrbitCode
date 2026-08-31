import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  CommandSandbox,
  ManagedCommandRequest,
  SandboxManagedProcess,
} from "@/tools/command-sandbox";
import {
  ManagedProcessController,
  ManagedProcessError,
} from "@/tools/managed-process";
import { createWorkspaceBoundary } from "@/tools/workspace";

test("受管进程等待本机端口、分页读取日志并可停止", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-managed-process-"));
  const port = await availablePort();
  const workspace = await createWorkspaceBoundary(root);
  const controller = new ManagedProcessController(new TestProcessSandbox(), workspace);
  try {
    const script = [
      "const http=require('node:http');",
      "const server=http.createServer((_q,r)=>r.end('ok'));",
      `server.listen(${port},'127.0.0.1',()=>console.log('ready'));`,
      "setInterval(()=>console.error('tick'),50);",
    ].join("");
    const started = await controller.start({
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
      readyPort: port,
      readyTimeoutMs: 2_000,
      signal: new AbortController().signal,
    });
    assert.equal(started.status, "running");
    await delay(80);
    const first = controller.status(started.processId, 0);
    assert.ok(first.logs.some((chunk) => chunk.text.includes("ready")));
    const second = controller.status(started.processId, first.nextCursor);
    assert.equal(second.logs.some((chunk) => chunk.text.includes("ready")), false);

    const stopped = await controller.stop(started.processId);
    assert.equal(stopped.status, "exited");
    assert.notEqual(stopped.exit?.terminationSignal, null);
  } finally {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("数量上限、无效 ID 和 close 回收均有界", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-managed-limit-"));
  const workspace = await createWorkspaceBoundary(root);
  const controller = new ManagedProcessController(
    new TestProcessSandbox(),
    workspace,
    { maxProcesses: 1, logBytes: 16 },
  );
  try {
    const first = await controller.start({
      command: "sleep 5",
      signal: new AbortController().signal,
    });
    await assert.rejects(
      controller.start({ command: "sleep 5", signal: new AbortController().signal }),
      (error: unknown) => error instanceof ManagedProcessError && error.kind === "limit",
    );
    assert.throws(
      () => controller.status("process-not-owned"),
      (error: unknown) => error instanceof ManagedProcessError && error.kind === "invalid-id",
    );
    await controller.close();
    assert.equal(controller.status(first.processId).status, "exited");
  } finally {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  }
});

class TestProcessSandbox implements CommandSandbox {
  async probe() { return { available: true as const }; }
  async run(): Promise<never> { throw new Error("unused"); }
  async start(request: ManagedCommandRequest): Promise<SandboxManagedProcess> {
    const child = spawn("/bin/sh", ["-c", request.command], {
      cwd: request.cwd.absolutePath,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return testHandle(child);
  }
}

function testHandle(child: ChildProcess): SandboxManagedProcess {
  let settled = false;
  const completion = new Promise<{
    readonly exitCode: number | null;
    readonly terminationSignal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, terminationSignal) => {
      settled = true;
      resolve({ exitCode, terminationSignal });
    });
  });
  return {
    pid: child.pid ?? 0,
    stdout: child.stdout,
    stderr: child.stderr,
    completion,
    async stop() {
      if (!settled && child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
      }
      await completion.catch(() => undefined);
    },
  };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("没有可用测试端口");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
