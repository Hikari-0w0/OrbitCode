import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ParentExecutionPolicy } from "./parent-execution-policy";
import { createModeToolPolicy } from "./mode-policy";
import { createDefaultToolRegistry } from "./default-registry";
import { MacOsSeatbeltCommandSandbox } from "./macos-seatbelt-sandbox";
import { createWorkspaceBoundary } from "./workspace";

test("仅委派策略覆盖定义、分类、准备、直接调用和已有 PreparedToolCall，不让 load_skill 豁免越过", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "parent-policy-"));
  try {
    const registry = createDefaultToolRegistry(new MacOsSeatbeltCommandSandbox()), base = createModeToolPolicy(registry, "do");
    const policy = new ParentExecutionPolicy(base, { version: 1, mode: "delegate-only" });
    const context = { workspace: await createWorkspaceBoundary(root), signal: new AbortController().signal, deadlineMs: Date.now() + 1000 };
    const prepared = base.prepare("write_file", { path: "blocked.txt", content: "不能执行" });
    assert.equal(prepared.kind, "ready");
    assert.ok(!policy.definitions().some(tool => tool.function.name === "write_file"));
    assert.equal(policy.classify("write_file").kind, "denied");
    assert.equal(policy.prepare("write_file", {}).kind, "failure");
    assert.equal(policy.prepare("load_skill", {}).kind, "failure");
    assert.equal((await policy.execute("write_file", { path: "blocked.txt", content: "不能执行" }, context)).ok, false);
    if (prepared.kind === "ready") assert.equal((await policy.executePrepared(prepared.call, context)).ok, false);
    await assert.rejects(readFile(path.join(root, "blocked.txt")));
  } finally { await rm(root, { recursive: true, force: true }); }
});
