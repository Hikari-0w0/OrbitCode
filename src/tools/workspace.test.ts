import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkspaceBoundary, WorkspaceError } from "@/tools/workspace";

test("工作区解析内部符号链接并拒绝越界、敏感路径和外部链接", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-workspace-"));
  const outside = await mkdtemp(path.join(tmpdir(), "orbitcode-outside-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "main.ts"), "你好\n", "utf8");
    await writeFile(path.join(root, "large.txt"), "x".repeat(101), "utf8");
    await writeFile(path.join(root, "binary.dat"), Buffer.from([0xff, 0xfe]));
    await writeFile(path.join(root, ".env"), "SECRET=sentinel\n", "utf8");
    await writeFile(path.join(outside, "outside.txt"), "outside", "utf8");
    await symlink(path.join(outside, "outside.txt"), path.join(root, "link.txt"));
    await symlink(path.join(root, "src", "main.ts"), path.join(root, "internal.txt"));
    const workspace = await createWorkspaceBoundary(root);

    const snapshot = await workspace.readTextFile("src/main.ts", { maxBytes: 100 });
    assert.equal(snapshot.content, "你好\n");
    assert.equal(snapshot.path.relativePath, "src/main.ts");
    const internal = await workspace.readTextFile("internal.txt", { maxBytes: 100 });
    assert.equal(internal.content, "你好\n");
    assert.equal(internal.path.relativePath, "src/main.ts");
    for (const target of ["../outside.txt", path.join(outside, "outside.txt"), ".env", "src", "link.txt"]) {
      await assert.rejects(workspace.readTextFile(target, { maxBytes: 100 }), WorkspaceError);
    }
    await assert.rejects(
      workspace.readTextFile("large.txt", { maxBytes: 100 }),
      (error: unknown) => error instanceof WorkspaceError && error.kind === "limit-exceeded",
    );
    await assert.rejects(
      workspace.readTextFile("binary.dat", { maxBytes: 100 }),
      (error: unknown) => error instanceof WorkspaceError && error.kind === "unsupported-content",
    );
    for (const target of ["bad\0path", "src\\main.ts", "src/../src/main.ts"]) {
      await assert.rejects(workspace.resolveExistingFile(target), WorkspaceError);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("权限配置通过原路径或内部符号链接访问都被保护", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-permission-protected-"));
  try {
    await mkdir(path.join(root, ".orbitcode"));
    await writeFile(path.join(root, ".orbitcode", "permissions.yaml"), "rules: {}\n");
    await symlink(
      path.join(root, ".orbitcode", "permissions.yaml"),
      path.join(root, "permission-link.yaml"),
    );
    const workspace = await createWorkspaceBoundary(root);
    for (const target of [
      ".orbitcode/permissions.yaml",
      "permission-link.yaml",
    ]) {
      await assert.rejects(
        workspace.readTextFile(target, { maxBytes: 100 }),
        (error: unknown) =>
          error instanceof WorkspaceError && error.kind === "protected-path",
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("工作区原子创建嵌套目录、覆盖并拒绝快照冲突", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-write-"));
  try {
    const workspace = await createWorkspaceBoundary(root);
    const created = await workspace.resolveWriteTarget("new.txt");
    await workspace.atomicWrite(created, "first");
    assert.equal(await readFile(path.join(root, "new.txt"), "utf8"), "first");
    const nested = await workspace.resolveWriteTarget("missing/deep/file.txt");
    await workspace.atomicWrite(nested, "nested");
    assert.equal(
      await readFile(path.join(root, "missing/deep/file.txt"), "utf8"),
      "nested",
    );

    const snapshot = await workspace.readTextFile("new.txt", { maxBytes: 100 });
    await workspace.replaceSnapshot(snapshot, "second");
    assert.equal(await readFile(path.join(root, "new.txt"), "utf8"), "second");
    await assert.rejects(workspace.replaceSnapshot(snapshot, "stale"), /其他进程修改/);
    assert.equal(await readFile(path.join(root, "new.txt"), "utf8"), "second");
    assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("嵌套目录在授权后被替换为符号链接时拒绝写出 Workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-write-parent-race-"));
  const outside = await mkdtemp(path.join(tmpdir(), "orbitcode-write-parent-outside-"));
  try {
    const workspace = await createWorkspaceBoundary(root);
    const target = await workspace.resolveWriteTarget("nested/file.txt");
    await symlink(outside, path.join(root, "nested"));

    await assert.rejects(
      workspace.atomicWrite(target, "must-stay-inside"),
      (error: unknown) =>
        error instanceof WorkspaceError && error.kind === "conflict",
    );
    await assert.rejects(readFile(path.join(outside, "file.txt"), "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("原子写入 I/O 失败时不留下目标或临时文件", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-write-failure-"));
  const locked = path.join(root, "locked");
  try {
    await mkdir(locked);
    const workspace = await createWorkspaceBoundary(root);
    const target = await workspace.resolveWriteTarget("locked/result.txt");
    await chmod(locked, 0o555);
    await assert.rejects(workspace.atomicWrite(target, "content"), WorkspaceError);
    await chmod(locked, 0o755);
    assert.deepEqual(await readdir(locked), []);
  } finally {
    await chmod(locked, 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("原子写入在临时文件落盘后提交失败仍清理临时文件", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-write-mid-failure-"));
  try {
    let injectedFailure = false;
    const workspace = await createWorkspaceBoundary(root, {
      async beforeAtomicRename() {
        injectedFailure = true;
        await mkdir(path.join(root, "result.txt"));
      },
    });
    const target = await workspace.resolveWriteTarget("result.txt");

    await assert.rejects(
      workspace.atomicWrite(target, "content"),
      WorkspaceError,
    );
    assert.equal(injectedFailure, true);
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("工作区遍历排序稳定并跳过忽略、敏感和符号链接", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-walk-"));
  try {
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(root, "z.txt"), "z");
    await writeFile(path.join(root, "src", "a.ts"), "a");
    await writeFile(path.join(root, ".env"), "secret");
    await writeFile(path.join(root, "node_modules", "ignored.js"), "ignored");
    await symlink(path.join(root, "src"), path.join(root, "linked-src"));
    const workspace = await createWorkspaceBoundary(root);
    const entries = [];
    for await (const entry of workspace.walk({ signal: new AbortController().signal })) {
      entries.push(entry.relativePath);
    }
    assert.deepEqual(entries, ["src/a.ts", "z.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
