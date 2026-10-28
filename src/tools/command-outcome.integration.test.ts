import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createCommandSandbox } from "./platform-sandbox";
import { createRunCommandTool } from "./run-command";
import { createWorkspaceBoundary } from "./workspace";

test("真实隔离后端传播管道失败，保留输出并允许显式错误处理", { skip: !["darwin", "linux"].includes(process.platform) }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-command-outcome-"));
  try {
    const workspace = await createWorkspaceBoundary(root);
    const sandbox = createCommandSandbox({});
    assert.deepEqual(await sandbox.probe(workspace), { available: true });
    const tool = createRunCommandTool(sandbox);
    const execute = (command: string) => tool.execute({ command }, {
      workspace, signal: new AbortController().signal, deadlineMs: Date.now() + 10000,
    });
    const failed = await execute("(printf 'assertion failed\\n'; exit 7) | tail -n 1");
    assert.equal(failed.ok, false);
    assert.equal(failed.ok ? undefined : failed.error.kind, "command-failed");
    assert.ok(failed.output && typeof failed.output === "object" && !Array.isArray(failed.output));
    assert.ok("exitCode" in failed.output && "stdout" in failed.output);
    assert.equal(failed.output.exitCode, 7);
    assert.equal(failed.output.stdout, "assertion failed\n");
    assert.equal((await execute("printf success | cat")).ok, true);
    assert.equal((await execute("false | cat || printf handled")).ok, true);
    // 不开启 errexit；多条命令和显式错误处理仍遵循 shell 语义。
    assert.equal((await execute("false; printf continued")).ok, true);
    assert.ok(sandbox.start);
    const managed = await sandbox.start({ command: "(exit 9) | cat", cwd: await workspace.resolveExistingDirectory() }, { workspace });
    try { assert.equal((await managed.completion).exitCode, 9); }
    finally { await managed.stop(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
