import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createCommandSandbox } from "@/tools/platform-sandbox";
import { createWorkspaceBoundary } from "@/tools/workspace";
import { resolveSandboxReadRoots } from "@/tools/sandbox-read-roots";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-security-"));
  const workspace = await createWorkspaceBoundary(root);
  const sandbox = createCommandSandbox({});
  assert.deepEqual(await sandbox.probe(workspace), { available: true });
  const cwd = await workspace.resolveExistingDirectory();
  return { root, run: (command: string, timeoutMs = 5000) => sandbox.run({ command, cwd, timeoutMs, outputLimitBytes: 1024 }, { workspace, signal: new AbortController().signal }), close: () => rm(root, { recursive: true, force: true }) };
}

test("沙箱阻止敏感文件硬链接、依赖目录密钥与敏感符号链接别名", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, ".env"), "SYNTHETIC_PRIVATE_VALUE");
    await link(path.join(f.root, ".env"), path.join(f.root, "alias.txt"));
    await mkdir(path.join(f.root, "node_modules/package"), { recursive: true });
    await writeFile(path.join(f.root, "node_modules/package/private.key"), "SYNTHETIC_PRIVATE_VALUE");
    await writeFile(path.join(f.root, "ordinary.txt"), "SYNTHETIC_PRIVATE_VALUE");
    await symlink("ordinary.txt", path.join(f.root, ".env.link"));
    for (const target of ["alias.txt", "node_modules/package/private.key", "ordinary.txt"]) {
      const result = await f.run(`cat ${target}`);
      assert.notEqual(result.exitCode, 0, target);
      assert.ok(!result.stdout.includes("SYNTHETIC_PRIVATE_VALUE"), target);
    }
  } finally { await f.close(); }
});

test("指向含敏感文件目录的链接不能破坏正常命令或暴露目录内容", async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.root, "secrets"));
    await writeFile(path.join(f.root, "secrets/private.key"), "SYNTHETIC_PRIVATE_VALUE");
    await writeFile(path.join(f.root, "secrets/ordinary.txt"), "SYNTHETIC_PRIVATE_VALUE");
    await symlink("secrets", path.join(f.root, ".env.directory"));
    const normal = await f.run("printf normal-ok");
    assert.equal(normal.exitCode, 0, normal.stderr);
    assert.equal(normal.stdout, "normal-ok");
    assert.notEqual((await f.run("cat secrets/ordinary.txt")).exitCode, 0);
  } finally { await f.close(); }
});

test("短命令正常退出后回收仍会写入的后台子进程", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.run("(sleep 0.5; printf leaked > orphan.txt) >/dev/null 2>&1 & exit 0")).exitCode, 0);
    await delay(800);
    await assert.rejects(readFile(path.join(f.root, "orphan.txt")));
  } finally { await f.close(); }
});

test("终止父进程后继续忽略TERM的子进程仍须被回收", async () => {
  const f = await fixture();
  try {
    const result = await f.run("(trap '' TERM; sleep 0.5; printf leaked > timeout-orphan.txt) >/dev/null 2>&1 & wait", 100);
    assert.equal(result.timedOut, true);
    await delay(800);
    await assert.rejects(readFile(path.join(f.root, "timeout-orphan.txt")));
  } finally { await f.close(); }
});

test("多个工作区并发执行不共享文件或私有HOME", async () => {
  const fixtures = await Promise.all(Array.from({ length: 4 }, () => fixture()));
  try {
    const results = await Promise.all(fixtures.map((f, index) => f.run(`printf ${index} > result.txt; printf ${index} > "$HOME/private"; sleep 0.05; cat result.txt; cat "$HOME/private"`)));
    for (const [index, result] of results.entries()) {
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout, `${index}${index}`);
      assert.equal((await fixtures[index].run('test ! -e "$HOME/private"')).exitCode, 0);
    }
  } finally { await Promise.all(fixtures.map(f => f.close())); }
});

test("长驻命令自行退出后也不能遗留普通后台后代", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-managed-security-"));
  try {
    const workspace = await createWorkspaceBoundary(root);
    const sandbox = createCommandSandbox({});
    assert.ok(sandbox.start);
    const handle = await sandbox.start({ command: "(sleep 0.5; printf leaked > managed-orphan.txt) >/dev/null 2>&1 & exit 0", cwd: await workspace.resolveExistingDirectory() }, { workspace });
    handle.stdout?.resume(); handle.stderr?.resume();
    await handle.completion;
    await delay(800);
    await assert.rejects(readFile(path.join(root, "managed-orphan.txt")));
    await handle.stop();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("大量输出仍持续排空管道并保留非零退出码", async () => {
  const f = await fixture();
  try {
    const result = await f.run(`node -e 'process.stdout.write("x".repeat(500000));process.stderr.write("y".repeat(500000));process.exitCode=9'`);
    assert.equal(result.exitCode, 9);
    assert.equal(result.stdout.length, 1024); assert.equal(result.stderr.length, 1024);
    assert.equal(result.stdoutTruncated, true); assert.equal(result.stderrTruncated, true);
  } finally { await f.close(); }
});

test("显式公网补测：DNS、TLS与npm包安装", { skip: process.env.ORBITCODE_SANDBOX_PUBLIC_NETWORK_TEST !== "1" }, async () => {
  const f = await fixture();
  try {
    // 公网偶发断链允许一次短重试，整个补测仍受固定命令预算约束。
    const result = await f.run(`npm install is-number@7.0.0 --registry=https://registry.npmjs.org --ignore-scripts --no-audit --no-fund --fetch-retries=1 --fetch-retry-mintimeout=250 --fetch-retry-maxtimeout=250 --fetch-timeout=10000 && node -e 'if(!require("is-number")(42))process.exit(2)'`, 25000);
    assert.equal(result.exitCode, 0, result.stderr);
  } finally { await f.close(); }
});

for (const reason of ["timeout", "cancel"] as const) test(`沙箱准备阶段也响应${reason === "timeout" ? "总时限" : "取消"}`, async context => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-preparation-"));
  const sandbox = createCommandSandbox({});
  const workspace = await createWorkspaceBoundary(root);
  const signal = new AbortController();
  let probeCompleted = false;
  // 模拟系统能力探测缓慢，检查超时不能等到子进程启动后才开始。
  context.mock.method(sandbox, "probe", async () => { await delay(350); probeCompleted = true; return { available: true as const }; });
  const timer = reason === "cancel" ? setTimeout(() => signal.abort(), 30) : undefined;
  try {
    const result = await sandbox.run({ command: "printf bad > must-not-run.txt", cwd: await workspace.resolveExistingDirectory(), timeoutMs: reason === "timeout" ? 50 : 5000, outputLimitBytes: 1024 }, { workspace, signal: signal.signal });
    assert.equal(probeCompleted, false, "准备阶段未及时结束等待");
    assert.equal(result.timedOut, reason === "timeout");
    assert.equal(result.cancelled, reason === "cancel");
    await delay(400);
    await assert.rejects(readFile(path.join(root, "must-not-run.txt")));
  } finally { if (timer) clearTimeout(timer); await rm(root, { recursive: true, force: true }); }
});

test("中文、引号、换行和shell字符的工作区路径按数据处理", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "orbitcode-path-data-"));
  const root = path.join(parent, '中文 \' " ; $(printf BAD) `printf BAD` \nworkspace');
  try {
    await mkdir(root);
    await writeFile(path.join(root, ".env.example"), "public-example");
    const workspace = await createWorkspaceBoundary(root);
    const sandbox = createCommandSandbox({});
    const result = await sandbox.run({ command: "pwd; cat .env.example", cwd: await workspace.resolveExistingDirectory(), timeoutMs: 5000, outputLimitBytes: 4096 }, { workspace, signal: new AbortController().signal });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, `${workspace.root}\npublic-example`);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("能力探测不执行项目同名工具，正常命令仍可调用项目工具", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-probe-trust-"));
  try {
    const bin = path.join(root, "node_modules/.bin");
    await mkdir(bin, { recursive: true });
    const marker = path.join(root, "shim-ran.txt");
    for (const name of ["cat", "sh", "readlink"]) await writeFile(path.join(bin, name), `#!/bin/sh\nprintf unexpected > '${marker}'\nexit 1`, { mode: 0o755 });
    await writeFile(path.join(bin, "project-tool"), "#!/bin/sh\nprintf project-tool-ok", { mode: 0o755 });
    const workspace = await createWorkspaceBoundary(root);
    const sandbox = createCommandSandbox({});
    assert.deepEqual(await sandbox.probe(workspace), { available: true });
    await assert.rejects(readFile(marker));
    const result = await sandbox.run({ command: "project-tool", cwd: await workspace.resolveExistingDirectory(), timeoutMs: 5000, outputLimitBytes: 1024 }, { workspace, signal: new AbortController().signal });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, "project-tool-ok");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("只读工具链授权不能借系统别名扩大到整棵私人数据目录", async () => {
  for (const root of ["/", "/tmp", "/etc", "/var", "/var/run", "/var/tmp", homedir(), tmpdir()]) {
    await assert.rejects(resolveSandboxReadRoots([root], process.cwd()), /整个根目录/u, root);
  }
});

test("包含敏感文件的祖先目录改名不能绕过文件保护", async () => {
  const f = await fixture();
  try {
    for (const folder of ["nested", "..nested"]) {
      await mkdir(path.join(f.root, folder));
      await writeFile(path.join(f.root, folder, "private.key"), "RENAMED_PRIVATE_SENTINEL");
      await writeFile(path.join(f.root, folder, "public.txt"), "public-data");
      assert.equal((await f.run(`cat ${folder}/public.txt`)).stdout, "public-data");
      const result = await f.run(`mv ${folder} ${folder}-renamed && cat ${folder}-renamed/private.key`);
      assert.notEqual(result.exitCode, 0, folder);
      assert.ok(!`${result.stdout}${result.stderr}`.includes("RENAMED_PRIVATE_SENTINEL"), folder);
    }
  } finally { await f.close(); }
});
