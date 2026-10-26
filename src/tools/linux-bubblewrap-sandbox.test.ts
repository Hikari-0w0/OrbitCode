import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { LinuxBubblewrapCommandSandbox } from "@/tools/linux-bubblewrap-sandbox";
import { ManagedProcessController } from "@/tools/managed-process";
import { createWorkspaceBoundary } from "@/tools/workspace";
import type { CommandSandboxOptions } from "@/tools/command-sandbox";

const linuxOnly = { skip: process.platform !== "linux" };
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture(options: CommandSandboxOptions = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "orbitcode-linux-test-"));
  const root = path.join(directory, "workspace with ' quotes");
  await mkdir(root);
  const workspace = await createWorkspaceBoundary(root);
  const sandbox = new LinuxBubblewrapCommandSandbox(options);
  assert.deepEqual(await sandbox.probe(workspace), { available: true }, "Linux 验收必须实际通过隔离探测，不能跳过");
  const cwd = await workspace.resolveExistingDirectory();
  const run = (command: string, timeoutMs = 5000, signal = new AbortController().signal, outputLimitBytes = 4096) => sandbox.run({ command, cwd, timeoutMs, outputLimitBytes }, { workspace, signal });
  return { directory, root, workspace, sandbox, run, close: () => rm(directory, { recursive: true, force: true }) };
}

test("Linux 允许开发命令并隔离工作区外文件、凭据、环境、proc 与别名", linuxOnly, async () => {
  const f = await fixture();
  const previous = process.env.ORBITCODE_SANDBOX_SENTINEL;
  process.env.ORBITCODE_SANDBOX_SENTINEL = "PRIVATE_SENTINEL";
  try {
    await writeFile(path.join(f.root, "inside.txt"), "inside");
    await writeFile(path.join(f.directory, "outside.txt"), "PRIVATE_SENTINEL");
    await writeFile(path.join(f.root, ".env"), "PRIVATE_SENTINEL");
    await mkdir(path.join(f.root, ".orbitcode/memory-v1"), { recursive: true });
    await writeFile(path.join(f.root, ".orbitcode/memory-v1/note.md"), "PRIVATE_SENTINEL");
    await link(path.join(f.root, ".env"), path.join(f.root, "env-alias.txt"));
    await link(path.join(f.root, ".orbitcode/memory-v1/note.md"), path.join(f.root, "memory-alias.txt"));
    await symlink(".env", path.join(f.root, "env-link.txt"));
    await symlink(path.join(f.directory, "outside.txt"), path.join(f.root, "outside-link.txt"));
    await mkdir(path.join(f.root, "node_modules/package"), { recursive: true });
    await writeFile(path.join(f.root, "node_modules/package/private.key"), "PRIVATE_SENTINEL");
    const allowed = await f.run("cat inside.txt; printf err >&2; exit 7");
    assert.equal(allowed.stdout, "inside");
    assert.equal(allowed.stderr, "err");
    assert.equal(allowed.exitCode, 7);
    for (const command of [
      `cat ${quote(path.join(f.directory, "outside.txt"))}`,
      "cat ../outside.txt", "cat .env", "printf overwritten > .env", "cat env-alias.txt", "cat env-link.txt", "cat memory-alias.txt", "cat outside-link.txt",
      "cat .orbitcode/memory-v1/note.md", "cat node_modules/package/private.key",
      `cat /proc/${process.pid}/environ`, "cat /root/.ssh/id_rsa", "cat /var/run/docker.sock",
      "test -n \"${ORBITCODE_SANDBOX_SENTINEL:-}\"",
      "sh -c 'cat .env'", "node -e 'require(\"node:fs\").readFileSync(\".env\")'",
    ]) {
      const result = await f.run(command);
      assert.notEqual(result.exitCode, 0, command);
      assert.ok(!`${result.stdout}${result.stderr}`.includes("PRIVATE_SENTINEL"), command);
    }
    // /tmp 是独立 tmpfs，允许创建同名临时文件，但不得修改宿主文件。
    await f.run(`printf changed > ${quote(path.join(f.directory, "outside.txt"))}`);
    assert.equal(await readFile(path.join(f.directory, "outside.txt"), "utf8"), "PRIVATE_SENTINEL");
    const tools = await f.run("node --version && npm --version && git init -q && printf ok > changed.txt && git add changed.txt && printf ignored > /dev/null", 10000);
    assert.equal(tools.exitCode, 0, tools.stderr);
    assert.equal(await readFile(path.join(f.root, "changed.txt"), "utf8"), "ok");
    assert.equal((await f.run("test ! -e \"$HOME/probe\" && test -z \"${NODE_ENV:-}\" && test \"$(npm config get omit)\" != dev")).exitCode, 0);
    await mkdir(path.join(f.root, "local-package"));
    await writeFile(path.join(f.root, "local-package/package.json"), JSON.stringify({ name: "sandbox-local-package", version: "1.0.0" }));
    const install = await f.run("npm install ./local-package --no-audit --no-fund", 20000);
    assert.equal(install.exitCode, 0, install.stderr);
    await writeFile(path.join(f.root, "main.cpp"), '#include <iostream>\nint main(){std::cout << 42;}\n');
    const compile = await f.run("c++ main.cpp -o main && ./main", 20000);
    assert.equal(compile.exitCode, 0, compile.stderr);
    assert.equal(compile.stdout, "42");
    assert.equal((await f.run("python3 -c 'print(42)'", 10000)).stdout.trim(), "42");
    // 探测后新增的敏感文件也必须在下一条命令执行前被重新遮蔽。
    await writeFile(path.join(f.root, "late.key"), "PRIVATE_SENTINEL");
    assert.notEqual((await f.run("cat late.key")).exitCode, 0);
  } finally {
    if (previous === undefined) delete process.env.ORBITCODE_SANDBOX_SENTINEL;
    else process.env.ORBITCODE_SANDBOX_SENTINEL = previous;
    await f.close();
  }
});

test("Linux 默认可联网，显式禁网不影响主进程网络", linuxOnly, async () => {
  const server = createServer((_request, response) => response.end("network-ok"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const allowed = await fixture();
  const denied = await fixture({ network: "deny" });
  try {
    const command = `node -e ${quote(`fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(1000)}).then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.exit(17))`)}`;
    assert.equal((await allowed.run(command)).stdout, "network-ok");
    assert.equal((await denied.run(command)).exitCode, 17);
    assert.equal(await (await fetch(url)).text(), "network-ok");
  } finally { await allowed.close(); await denied.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("Linux 输出限制、超时、取消和长驻进程回收", linuxOnly, async () => {
  const f = await fixture();
  const controller = new ManagedProcessController(f.sandbox, f.workspace);
  try {
    const limited = await f.run("printf 123456789; printf abcdefghi >&2", 1000, undefined, 4);
    assert.equal(limited.stdout, "1234"); assert.equal(limited.stderr, "abcd");
    assert.equal(limited.stdoutTruncated, true); assert.equal(limited.stderrTruncated, true);
    const timeout = await f.run("trap '' TERM; sleep 30", 150);
    assert.equal(timeout.timedOut, true);
    const abort = new AbortController();
    const pending = f.run("sleep 30", 5000, abort.signal);
    setTimeout(() => abort.abort(), 100);
    assert.equal((await pending).cancelled, true);
    const cancelled = await f.run("printf should-not-run > bad.txt", 5000, AbortSignal.abort());
    assert.equal(cancelled.cancelled, true);
    await assert.rejects(readFile(path.join(f.root, "bad.txt")));
    const process = await controller.start({ command: "while true; do printf tick; sleep 0.05; done", signal: new AbortController().signal });
    await delay(150);
    assert.ok(controller.status(process.processId).logs.length > 0);
    await controller.close();
    assert.equal(controller.status(process.processId).status, "exited");
    // 短命令退出后不应遗留后台写入者。
    await f.run("(sleep 0.5; printf leaked > orphan.txt) >/dev/null 2>&1 & exit 0");
    await delay(700);
    await assert.rejects(readFile(path.join(f.root, "orphan.txt")));
  } finally { await controller.close(); await f.close(); }
});

test("Linux 仅显式授权的额外工具链目录可读且不能写入", linuxOnly, async () => {
  const tools = await mkdtemp(path.join(tmpdir(), "orbitcode-extra-toolchain-"));
  await mkdir(path.join(tools, "bin"));
  await writeFile(path.join(tools, "bin/custom-tool"), "#!/bin/sh\nprintf custom-ok", { mode: 0o755 });
  const f = await fixture({ readOnlyRoots: [tools] });
  try {
    assert.equal((await f.run("custom-tool")).stdout, "custom-ok");
    assert.notEqual((await f.run(`printf changed > ${quote(path.join(tools, "bin/custom-tool"))}`)).exitCode, 0);
  } finally { await f.close(); await rm(tools, { recursive: true, force: true }); }
});

test("Linux 拒绝工作区外 cwd 与过宽的工具链授权", linuxOnly, async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.sandbox.run({ command: "pwd", cwd: { absolutePath: "/", relativePath: "..", existed: true }, timeoutMs: 1000, outputLimitBytes: 100 }, { workspace: f.workspace, signal: new AbortController().signal }), /工作目录/u);
    assert.equal((await new LinuxBubblewrapCommandSandbox({ readOnlyRoots: ["/"] }).probe(f.workspace)).available, false);
  } finally { await f.close(); }
});

test("Linux 外层容器禁止 namespace 时拒绝执行", { skip: process.platform !== "linux" || process.env.ORBITCODE_EXPECT_SANDBOX_UNAVAILABLE !== "1" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-unavailable-"));
  try {
    const workspace = await createWorkspaceBoundary(root);
    const sandbox = new LinuxBubblewrapCommandSandbox();
    const availability = await sandbox.probe(workspace);
    assert.equal(availability.available, false);
    await assert.rejects(sandbox.run({ command: "printf escaped > should-not-exist", cwd: await workspace.resolveExistingDirectory(), timeoutMs: 1000, outputLimitBytes: 1024 }, { workspace, signal: new AbortController().signal }));
    await assert.rejects(readFile(path.join(root, "should-not-exist")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Linux PID namespace 回收自行脱离进程组的后台进程", linuxOnly, async () => {
  const f = await fixture();
  try {
    const script = 'require("node:child_process").spawn(process.execPath,["-e",`setTimeout(()=>require("node:fs").writeFileSync("detached.txt","bad"),500)`],{detached:true,stdio:"ignore"}).unref()';
    const result = await f.run(`node -e ${quote(script)}`);
    assert.equal(result.exitCode, 0, result.stderr);
    await delay(800);
    await assert.rejects(readFile(path.join(f.root, "detached.txt")));
  } finally { await f.close(); }
});

test("Linux 不能借proc根目录或嵌套namespace揭开敏感文件遮蔽", linuxOnly, async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, ".env"), "NAMESPACE_PRIVATE_SENTINEL");
    for (const command of [
      `cat /proc/self/root${quote(path.join(f.root, ".env"))}`,
      `cat /proc/1/root${quote(path.join(f.root, ".env"))}`,
      `unshare -Urnm /bin/sh -c 'umount .env && cat .env'`,
      "chmod 644 .env && cat .env",
      "mv .env visible.txt && cat visible.txt",
    ]) {
      const result = await f.run(command);
      assert.notEqual(result.exitCode, 0, command);
      assert.ok(!`${result.stdout}${result.stderr}`.includes("NAMESPACE_PRIVATE_SENTINEL"), command);
    }
  } finally { await f.close(); }
});
