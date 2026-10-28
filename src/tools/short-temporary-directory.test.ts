import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { shortTemporaryDirectory } from "./workspace-temporary-directory";
import { createWorkspaceBoundary } from "./workspace";
import { createCommandSandbox } from "./platform-sandbox";
import { parseCommandSecurity } from "./command-security";

test("长工作区使用短临时目录跨命令复用缓存，Unix socket可监听且兄弟工作区不可见", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "orbitcode-short-"));
  const root = path.join(parent, "long-workspace-".repeat(10));
  const other = path.join(parent, "other");
  await mkdir(root); await mkdir(other);
  const temporary = await shortTemporaryDirectory(root), sibling = await shortTemporaryDirectory(other);
  try {
    await writeFile(path.join(sibling, "secret.txt"), "sibling-sentinel");
    assert.notEqual(temporary, sibling);
    assert.ok(Buffer.byteLength(path.join(temporary, "tsx-501/12345.pipe")) < 104);
    const workspace = await createWorkspaceBoundary(root), cwd = await workspace.resolveExistingDirectory();
    const sandbox = createCommandSandbox({}, process.platform, parseCommandSecurity({ temporaryDirectory: "short" }));
    const run = (command: string) => sandbox.run({ command, cwd, timeoutMs: 10000, outputLimitBytes: 2048 }, { workspace, signal: new AbortController().signal });
    const socket = await run('node -e \'const net=require("node:net"),fs=require("node:fs");const p=process.env.TMPDIR+"/probe.pipe";const s=net.createServer();s.listen(p,()=>{fs.mkdirSync(process.env.npm_config_cache,{recursive:true});fs.writeFileSync(process.env.npm_config_cache+"/marker","cache-ok");s.close()});\'');
    assert.equal(socket.exitCode, 0, socket.stderr);
    assert.equal((await run('cat "$npm_config_cache/marker"')).stdout, "cache-ok");
    assert.equal(await readFile(path.join(temporary, "cache/npm/marker"), "utf8"), "cache-ok");
    assert.notEqual((await run(`cat '${sibling}/secret.txt'`)).exitCode, 0);
  } finally { await rm(parent, { recursive: true, force: true }); await rm(temporary, { recursive: true, force: true }); await rm(sibling, { recursive: true, force: true }); }
});
