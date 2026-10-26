import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { MacOsSeatbeltCommandSandbox } from "@/tools/macos-seatbelt-sandbox";
import { createWorkspaceBoundary } from "@/tools/workspace";

const executeFile = promisify(execFile);

test("Seatbelt 阻止原生接口读取仅含合成凭据的父进程环境", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-parent-environment-"));
  const project = process.cwd();
  try {
    await executeFile("/usr/bin/clang", [path.join(project, "tests/fixtures/sandbox/read-parent-environment.c"), "-o", path.join(root, "reader")], { env: { PATH: "/usr/bin:/bin", NODE_ENV: "test" } });
    const source = `import {spawnSync} from 'node:child_process';
import {createWorkspaceBoundary} from ${JSON.stringify(pathToFileURL(path.join(project, "src/tools/workspace.ts")).href)};
import {createCommandSandbox} from ${JSON.stringify(pathToFileURL(path.join(project, "src/tools/platform-sandbox.ts")).href)};
const secret=process.env.ORBITCODE_SYNTHETIC_SECRET;
const control=spawnSync('./reader',[String(process.pid),secret],{cwd:process.cwd(),env:{PATH:'/usr/bin:/bin'}});
const workspace=await createWorkspaceBoundary(process.cwd());
const result=await createCommandSandbox({}).run({command:'./reader '+process.pid+' '+secret,cwd:await workspace.resolveExistingDirectory(),timeoutMs:10000,outputLimitBytes:1024},{workspace,signal:new AbortController().signal});
const own=await createCommandSandbox({}).run({command:'./reader self SELF_QUERY_SENTINEL',cwd:await workspace.resolveExistingDirectory(),timeoutMs:10000,outputLimitBytes:1024},{workspace,signal:new AbortController().signal});
process.stdout.write(JSON.stringify({control:control.status,sandbox:result.exitCode,self:own.exitCode}));`;
    const script = path.join(root, "supervisor.mjs");
    await writeFile(script, source);
    const result = await executeFile(process.execPath, ["--import", path.join(project, "node_modules/tsx/dist/loader.mjs"), script], {
      cwd: root, timeout: 20000,
      env: { PATH: "/usr/bin:/bin", NODE_ENV: "test", TSX_TSCONFIG_PATH: path.join(project, "tsconfig.json"), ORBITCODE_SYNTHETIC_SECRET: "ONLY_SYNTHETIC_PROCESS_SENTINEL" },
    });
    assert.deepEqual(JSON.parse(result.stdout), { control: 0, sandbox: 2, self: 0 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

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

test("Seatbelt 仅在显式配置时禁网，主进程仍能访问开发服务", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-seatbelt-offline-"));
  const server = createHttpServer((_request, response) => response.end("host-network-ok"));
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    const workspace = await createWorkspaceBoundary(root);
    const sandbox = new MacOsSeatbeltCommandSandbox({ network: "deny" });
    assert.deepEqual(await sandbox.probe(workspace), { available: true });
    const result = await sandbox.run({ command: `/usr/bin/curl --max-time 1 -fsS ${url}`, cwd: await workspace.resolveExistingDirectory(), timeoutMs: 3000, outputLimitBytes: 1024 }, { workspace, signal: new AbortController().signal });
    assert.notEqual(result.exitCode, 0);
    assert.equal(await (await fetch(url)).text(), "host-network-ok");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test("Seatbelt 可显式授权只读工具链，不授予工作区外写权限", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-seatbelt-toolchain-"));
  const tools = await mkdtemp(path.join(tmpdir(), "orbitcode-seatbelt-tools-"));
  try {
    await mkdir(path.join(tools, "bin"));
    const executable = path.join(tools, "bin/custom-sandbox-tool");
    await writeFile(executable, "#!/bin/sh\nprintf custom-ok", { mode: 0o755 });
    const workspace = await createWorkspaceBoundary(root);
    const sandbox = new MacOsSeatbeltCommandSandbox({ readOnlyRoots: [tools] });
    assert.deepEqual(await sandbox.probe(workspace), { available: true });
    // 本例检查权限兼容性；短时限与取消由独立用例覆盖，避免全仓负载污染功能断言。
    const request = { cwd: await workspace.resolveExistingDirectory(), timeoutMs: 10000, outputLimitBytes: 1024 };
    const execution = await sandbox.run({ ...request, command: "custom-sandbox-tool" }, { workspace, signal: new AbortController().signal });
    assert.equal(execution.exitCode, 0, JSON.stringify(execution));
    assert.equal(execution.stdout, "custom-ok");
    assert.notEqual((await sandbox.run({ ...request, command: `printf changed > '${executable}'` }, { workspace, signal: new AbortController().signal })).exitCode, 0);
    assert.equal(await readFile(executable, "utf8"), "#!/bin/sh\nprintf custom-ok");
    assert.equal((await new MacOsSeatbeltCommandSandbox({ readOnlyRoots: ["/"] }).probe(workspace)).available, false);
  } finally { await rm(root, { recursive: true, force: true }); await rm(tools, { recursive: true, force: true }); }
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

test("命令不能绕过受控读取访问现有或未来的记忆目录",async()=>{
 const {mkdir}=await import("node:fs/promises");const root=await mkdtemp(path.join(tmpdir(),"orbitcode-memory-boundary-"));try{
 await mkdir(path.join(root,"data/memory-v1"),{recursive:true});await writeFile(path.join(root,"data/memory-v1/note.md"),"MEMORY_SENTINEL");
 const workspace=await createWorkspaceBoundary(root),cwd=await workspace.resolveExistingDirectory(),sandbox=new MacOsSeatbeltCommandSandbox();assert.deepEqual(await sandbox.probe(workspace),{available:true});
 await assert.rejects(workspace.readTextFile("data/memory-v1/note.md",{maxBytes:1024}));
 for(const command of ["cat data/memory-v1/note.md","mkdir -p fresh/memory-state-v1 && printf x > fresh/memory-state-v1/a"]){const result=await sandbox.run({command,cwd,timeoutMs:2000,outputLimitBytes:1024},{workspace,signal:new AbortController().signal});assert.notEqual(result.exitCode,0);assert.ok(!result.stdout.includes("MEMORY_SENTINEL"));}
 }finally{await rm(root,{recursive:true,force:true});}
});
