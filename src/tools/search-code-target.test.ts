import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { searchCodeTool } from "./search-code";
import { resolvePermissionSubject } from "./permission-target";
import { createWorkspaceBoundary } from "./workspace";

test("单文件搜索经权限解析且不扫描同目录其他文件，目录和glob保持兼容", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-search-target-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src/one.ts"), "needle\n");
    await writeFile(path.join(root, "src/two.ts"), "needle\n");
    await symlink("src/one.ts", path.join(root, "alias.ts"));
    const workspace = await createWorkspaceBoundary(root);
    const context = { workspace, signal: new AbortController().signal, deadlineMs: Date.now() + 10000 };
    const subject = await resolvePermissionSubject({ name: "search_code", mutability: "read-only", fingerprint: "test", permissionTarget: { kind: "path", requestedPath: "alias.ts", resolution: "existing-path" } }, workspace);
    assert.equal(subject.kind === "path" && subject.canonicalRelativePath, "src/one.ts");
    const one = await searchCodeTool.execute({ query: "needle", path: "src/one.ts" }, context);
    assert.deepEqual(one.ok && one.output, { matches: [{ path: "src/one.ts", line: 1, column: 1, text: "needle", textTruncated: false }], count: 1, skippedFiles: 0 });
    const directory = await searchCodeTool.execute({ query: "needle", path: "src" }, context);
    assert.equal(directory.ok, true);
    assert.match(JSON.stringify(directory.output), /"count":2/);
    const excluded = await searchCodeTool.execute({ query: "needle", path: "src/one.ts", file_pattern: "**/*.js" }, context);
    assert.equal(excluded.ok, true);
    assert.match(JSON.stringify(excluded.output), /"count":0/);
    await writeFile(path.join(root, ".env"), "needle");
    await symlink(path.join(tmpdir(), "outside.ts"), path.join(root, "escape.ts"));
    for (const target of [".env", "../outside.ts", "escape.ts", "missing.ts"]) {
      await assert.rejects(resolvePermissionSubject({ name: "search_code", mutability: "read-only", fingerprint: "test", permissionTarget: { kind: "path", requestedPath: target, resolution: "existing-path" } }, workspace));
      assert.equal((await searchCodeTool.execute({ query: "needle", path: target }, context)).ok, false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
