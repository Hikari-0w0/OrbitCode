import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { LocalSettingsStore } from "@/lib/local-settings-store";

test("两个独立进程以同一 revision 保存时只有一个事务成功", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-settings-process-"));
  try {
    const project = process.cwd();
    const storeModule = pathToFileURL(path.join(project, "src/lib/local-settings-store.ts")).href;
    const source = `import { LocalSettingsStore, EMPTY_SETTINGS } from ${JSON.stringify(storeModule)};
      try { await new LocalSettingsStore(${JSON.stringify(root)}).save(0, EMPTY_SETTINGS); process.stdout.write('saved'); }
      catch (error) { if (error.code !== 'conflict') throw error; process.stdout.write('conflict'); }`;
    const launch = () => promisify(execFile)(process.execPath, ["--import", path.join(project, "node_modules/tsx/dist/loader.mjs"),
      "--input-type=module", "-e", source], { cwd: project, timeout: 10_000,
      env: { NODE_ENV: "test", TSX_TSCONFIG_PATH: path.join(project, "tsconfig.json") } });
    const results = await Promise.all([launch(), launch()]);
    assert.deepEqual(results.map((result) => result.stdout).sort(), ["conflict", "saved"]);
    assert.equal((await new LocalSettingsStore(root).load())?.revision, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("持锁进程被终止后，下一进程回收已退出 owner 并保留事务边界", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-settings-crash-"));
  const project = process.cwd();
  const moduleUrl = pathToFileURL(path.join(project, "src/lib/settings-lock.ts")).href;
  const source = "import { acquireSettingsLock } from " + JSON.stringify(moduleUrl) + "; await acquireSettingsLock(" + JSON.stringify(root) + "); process.stdout.write('ready'); setInterval(()=>{},1000);";
  const child = spawn(process.execPath, ["--import", path.join(project, "node_modules/tsx/dist/loader.mjs"), "--input-type=module", "-e", source],
    { cwd: project, env: { NODE_ENV: "test", TSX_TSCONFIG_PATH: path.join(project, "tsconfig.json") }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("子进程未取得设置锁")), 5_000);
      child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.kill("SIGKILL");
    await exited;
    const store = new LocalSettingsStore(root);
    const saved = await store.save(0, { schemaVersion: 1, providers: [], workspaces: [], mcpServers: [] });
    assert.equal(saved.revision, 1);
  } finally { child.kill("SIGKILL"); await rm(root, { recursive: true, force: true }); }
});
