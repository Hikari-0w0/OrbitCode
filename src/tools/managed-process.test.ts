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
import { parseCommandSecurity } from "@/tools/command-security";

test("进程状态等待返回增量输出和退出，取消等待不终止仍运行的进程", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-process-wait-"));
  const controller = new ManagedProcessController(new TestProcessSandbox(), await createWorkspaceBoundary(root));
  try {
    const process = await controller.start({ command: "sleep 0.05; printf first; sleep 0.15; printf last", signal: new AbortController().signal });
    const first = await controller.waitStatus(process.processId, 0, 1000, "output", new AbortController().signal);
    assert.equal(first.status, "running");
    assert.match(first.logs.map(chunk => chunk.text).join(""), /first/);
    const finished = await controller.waitStatus(process.processId, first.nextCursor, 1000, "exit", new AbortController().signal);
    assert.equal(finished.status, "exited");
    assert.equal(finished.exit?.exitCode, 0);
    assert.equal(finished.logs.map(chunk => chunk.text).join(""), "last");
    const pending = await controller.start({ command: "sleep 5", signal: new AbortController().signal });
    const signal = new AbortController();
    const waiting = controller.waitStatus(pending.processId, 0, 1000, "exit", signal.signal);
    signal.abort();
    await assert.rejects(waiting, error => error instanceof ManagedProcessError && error.kind === "cancelled");
    assert.equal(controller.status(pending.processId).status, "running");
    const timed = await controller.waitStatus(pending.processId, 0, 5, "exit", new AbortController().signal);
    assert.equal(timed.status, "running");
  } finally { await controller.close(); await rm(root, { recursive: true, force: true }); }
});

test("受管进程数量与日志容量读取沙箱配置，扩容后仍回收全部进程", async () => {
  const root=await mkdtemp(path.join(tmpdir(),"orbitcode-managed-config-"));
  const workspace=await createWorkspaceBoundary(root);
  class ConfiguredSandbox extends TestProcessSandbox { readonly security=parseCommandSecurity({maxProcesses:2,processLogBytes:1024}); }
  const controller=new ManagedProcessController(new ConfiguredSandbox(),workspace);
  try {
    const first=await controller.start({command:`printf '${"x".repeat(2048)}'; sleep 5`,signal:new AbortController().signal});
    await controller.start({command:"sleep 5",signal:new AbortController().signal});
    await assert.rejects(controller.start({command:"sleep 5",signal:new AbortController().signal}),error=>error instanceof ManagedProcessError&&error.kind==="limit");
    const deadline=Date.now()+2000;
    while(!controller.status(first.processId).logs.length&&Date.now()<deadline)await delay(10);
    const status=controller.status(first.processId);assert.equal(status.truncated,true);assert.ok(status.logs.reduce((sum,chunk)=>sum+Buffer.byteLength(chunk.text),0)<=1024);
  }finally{await controller.close();await rm(root,{recursive:true,force:true});}
});

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
    assert.equal(started.lifetime, "current-turn");
    assert.deepEqual(started.portObservation, { port, scope: "tcp-connectivity-only" });
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

test("受管进程接受仅监听 IPv6 loopback 的本机服务", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-managed-ipv6-"));
  const port = await availablePort("::1");
  const workspace = await createWorkspaceBoundary(root);
  const controller = new ManagedProcessController(new TestProcessSandbox(), workspace);
  try {
    const script = [
      "const net=require('node:net');",
      "const server=net.createServer();",
      `server.listen(${port},'::1',()=>console.log('ready-v6'));`,
    ].join("");
    const started = await controller.start({
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
      readyPort: port,
      readyTimeoutMs: 500,
      signal: new AbortController().signal,
    });

    assert.equal(started.status, "running");
    assert.equal(started.lifetime, "current-turn");
    assert.deepEqual(started.portObservation, { port, scope: "tcp-connectivity-only" });
    // TCP 就绪与 stdout 到达是独立事件，等待日志而不是假定二者同步。
    const logDeadline = Date.now() + 1_000;
    while (!controller.status(started.processId).logs.some((chunk) => chunk.text.includes("ready-v6")) && Date.now() < logDeadline) {
      await delay(10);
    }
    assert.equal(
      controller.status(started.processId).logs.some((chunk) =>
        chunk.text.includes("ready-v6")
      ),
      true,
    );
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

test("等待就绪前退出时保留诊断日志且不暴露失效进程 ID", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-managed-failure-"));
  const port = await availablePort();
  const workspace = await createWorkspaceBoundary(root);
  const controller = new ManagedProcessController(new TestProcessSandbox(), workspace);
  try {
    await assert.rejects(
      controller.start({
        command: "printf config-broken; exit 1",
        readyPort: port,
        readyTimeoutMs: 1_000,
        signal: new AbortController().signal,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ManagedProcessError);
        assert.equal(error.kind, "not-ready");
        assert.equal(error.processAvailable, false);
        assert.equal(error.logs.some((chunk) => chunk.text.includes("config-broken")), true);
        return true;
      },
    );
  } finally {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const host of ["127.0.0.1", "::1"]) {
  test(`已占用的 ${host} 端口不能作为新进程就绪证据`, async () => {
    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, host, resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const workspace = await createWorkspaceBoundary(process.cwd());
    let starts = 0;
    const sandbox = new TestProcessSandbox();
    const original = sandbox.start.bind(sandbox);
    sandbox.start = async (request) => { starts += 1; return original(request); };
    const controller = new ManagedProcessController(sandbox, workspace);
    try {
      await assert.rejects(controller.start({
        command: "sleep 5",
        readyPort: address.port,
        signal: new AbortController().signal,
      }), /端口.*已被占用/u);
      assert.equal(starts, 0);
    } finally {
      await controller.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

test("预先取消不会启动子进程", async () => {
  const workspace = await createWorkspaceBoundary(process.cwd());
  const sandbox = new TestProcessSandbox();
  let starts = 0;
  const original = sandbox.start.bind(sandbox);
  sandbox.start = async (request) => { starts += 1; return original(request); };
  const controller = new ManagedProcessController(sandbox, workspace);
  const abort = new AbortController();
  abort.abort();
  try {
    await assert.rejects(controller.start({ command: "sleep 5", signal: abort.signal }),
      (error: unknown) => error instanceof ManagedProcessError && error.kind === "cancelled");
    assert.equal(starts, 0);
  } finally {
    await controller.close();
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

async function availablePort(host = "127.0.0.1"): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("没有可用测试端口");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('受管进程持有写入许可至退出，状态与停止不等待许可',async()=>{
 const {WorkspaceExecutionCoordinator}=await import('@/runtime/workspace-execution-coordinator');
 const workspace=await createWorkspaceBoundary(process.cwd());
 const coordinator=new WorkspaceExecutionCoordinator();const signal=new AbortController().signal;
 const release=await coordinator.acquire(workspace.root,signal);
 const controller=new ManagedProcessController(new TestProcessSandbox(),workspace);
 let entered=false;
 try{
  const task=await controller.start({command:'sleep 5',signal,takeWriteLease:()=>release});
  const next=coordinator.acquire(workspace.root,signal).then(unlock=>{entered=true;unlock();});
  await delay(10);assert.equal(entered,false);assert.equal(controller.status(task.processId).status,'running');
  await controller.stop(task.processId);await next;assert.equal(entered,true);
 }finally{await controller.close();release();}
});
test('停止失败保留错误与写许可，不把失败当作已退出',async()=>{
 const {WorkspaceExecutionCoordinator}=await import('@/runtime/workspace-execution-coordinator');
 const workspace=await createWorkspaceBoundary(process.cwd()),coordinator=new WorkspaceExecutionCoordinator();
 let finish!:(value:{exitCode:number|null;terminationSignal:NodeJS.Signals|null})=>void;
 const completion=new Promise<{exitCode:number|null;terminationSignal:NodeJS.Signals|null}>(resolve=>{finish=resolve;});
 const sandbox:CommandSandbox={probe:async()=>({available:true}),run:async()=>{throw new Error('不用命令执行');},start:async()=>({pid:process.pid,stdout:null,stderr:null,completion,stop:async()=>{throw new Error('停止失败');}})};
 const controller=new ManagedProcessController(sandbox,workspace);const signal=new AbortController().signal,release=await coordinator.acquire(workspace.root,signal);
 let entered=false;
 try{const task=await controller.start({command:'受控替身',signal,takeWriteLease:()=>release});const next=coordinator.acquire(workspace.root,signal).then(unlock=>{entered=true;unlock();});await assert.rejects(controller.stop(task.processId),/停止失败/);assert.equal(controller.status(task.processId).status,'running');assert.equal(entered,false);finish({exitCode:1,terminationSignal:null});await next;assert.equal(controller.status(task.processId).status,'exited');}finally{finish({exitCode:1,terminationSignal:null});await controller.close();release();}
});
