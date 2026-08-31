import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_WRITE_FILES_ITEMS,
  writeFilesTool,
} from "@/tools/write-files";
import { createWorkspaceBoundary } from "@/tools/workspace";

test("批量写入在准备阶段限制数量、字段、重复路径和总字节", () => {
  for (const input of [
    { files: [] },
    { files: [{ path: "a.txt" }] },
    { files: [{ path: "a.txt", content: "a", extra: true }] },
    { files: [{ path: "a.txt", content: "a" }, { path: "a.txt", content: "b" }] },
    {
      files: Array.from({ length: MAX_WRITE_FILES_ITEMS + 1 }, (_, index) => ({
        path: `${index}.txt`,
        content: "",
      })),
    },
  ]) {
    assert.equal(writeFilesTool.prepareUnknown(input).kind, "failure");
  }
});

test("批量准备冻结每个路径权限目标，执行时按输入顺序原子写入", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-write-files-"));
  try {
    await mkdir(path.join(root, "src"));
    const workspace = await createWorkspaceBoundary(root);
    const prepared = writeFilesTool.prepareUnknown({
      files: [
        { path: "src/a.ts", content: "export const a = 1;\n" },
        { path: "src/b.ts", content: "export const b = 2;\n" },
      ],
    });
    assert.equal(prepared.kind, "ready");
    if (prepared.kind !== "ready") return;
    assert.equal(prepared.call.permissionTargets?.length, 2);
    assert.equal(prepared.call.permissionTargets?.every(Object.isFrozen), true);

    const result = await prepared.call.execute({
      workspace,
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 1_000,
    });
    assert.equal(result.ok, true);
    assert.equal(await readFile(path.join(root, "src/a.ts"), "utf8"), "export const a = 1;\n");
    assert.equal(await readFile(path.join(root, "src/b.ts"), "utf8"), "export const b = 2;\n");
    assert.deepEqual(result.ok ? result.output : undefined, {
      files: [
        { path: "src/a.ts", byteLength: 20, created: true },
        { path: "src/b.ts", byteLength: 20, created: true },
      ],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("批量写入自动创建缺失的父目录", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-write-files-nested-"));
  try {
    const workspace = await createWorkspaceBoundary(root);
    const prepared = writeFilesTool.prepareUnknown({
      files: [
        { path: "web/css/style.css", content: "body {}\n" },
        { path: "web/js/app.js", content: "export {};\n" },
      ],
    });
    assert.equal(prepared.kind, "ready");
    if (prepared.kind !== "ready") return;

    const result = await prepared.call.execute({
      workspace,
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 1_000,
    });

    assert.equal(result.ok, true);
    assert.equal(await readFile(path.join(root, "web/css/style.css"), "utf8"), "body {}\n");
    assert.equal(await readFile(path.join(root, "web/js/app.js"), "utf8"), "export {};\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("任一路径预检失败时整批不会产生写入", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-write-files-preflight-"));
  try {
    const workspace = await createWorkspaceBoundary(root);
    const prepared = writeFilesTool.prepareUnknown({
      files: [
        { path: "would-write.txt", content: "first" },
        { path: ".env", content: "second" },
      ],
    });
    assert.equal(prepared.kind, "ready");
    if (prepared.kind !== "ready") return;
    const result = await prepared.call.execute({
      workspace,
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 1_000,
    });
    assert.equal(result.ok, false);
    await assert.rejects(stat(path.join(root, "would-write.txt")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
