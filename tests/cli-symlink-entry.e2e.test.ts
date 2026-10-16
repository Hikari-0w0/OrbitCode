import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, symlink, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

test("CLI 通过符号链接入口启动时仍执行主程序，不产生空输出成功", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "orbitcode-cli-link-"));
    try {
        const entry = path.join(root, "orbitcode.ts");
        await symlink(path.resolve("src/cli/main.ts"), entry);
        const result = await exec(process.execPath, ["--import", path.resolve("node_modules/tsx/dist/loader.mjs"), entry, "--help"], { cwd: root, env: { NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME, TSX_TSCONFIG_PATH: path.resolve("tsconfig.json") } });
        assert.match(result.stdout, /OrbitCode|用法/);
        assert.ok(result.stdout.length > 100);
        assert.equal(result.stderr, "");
    } finally { await rm(root, { recursive: true, force: true }); }
});
