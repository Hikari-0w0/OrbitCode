import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { snapshotWorkspace } from "../scripts/evals/sub-agent-workspace-snapshot";

test("评测哈希区分同长度修改并证明恢复，不跟随工作区链接", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sub-agent-snapshot-"));
  try {
    await writeFile(path.join(root, "module.mjs"), "before");
    await symlink("/etc/hosts", path.join(root, "outside"));
    const before = await snapshotWorkspace(root);
    await writeFile(path.join(root, "module.mjs"), "after!");
    const changed = await snapshotWorkspace(root);
    assert.equal(before["module.mjs"].bytes, changed["module.mjs"].bytes);
    assert.notEqual(before["module.mjs"].sha256, changed["module.mjs"].sha256);
    await writeFile(path.join(root, "module.mjs"), "before");
    assert.deepEqual(await snapshotWorkspace(root), before);
    assert.equal("outside" in before, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
