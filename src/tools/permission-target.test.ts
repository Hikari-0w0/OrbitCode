import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  permissionTargetFailure,
  resolvePermissionSubject,
  summarizePermissionSubject,
} from "@/tools/permission-target";
import type { PreparedToolCall } from "@/tools/registry";
import { createWorkspaceBoundary } from "@/tools/workspace";

test("文件目标经真实路径解析后形成规范 Workspace 相对目标", async () => {
  const fixture = await createFixture();
  try {
    await mkdir(path.join(fixture.root, "src"));
    await writeFile(path.join(fixture.root, "src", "main.ts"), "export {};\n");
    await symlink("src/main.ts", path.join(fixture.root, "alias.ts"));
    const subject = await resolvePermissionSubject(
      preparedPath("read_file", "read-only", "alias.ts", "existing-file"),
      fixture.workspace,
    );
    assert.deepEqual(subject, {
      kind: "path",
      toolName: "read_file",
      toolKind: "read",
      requestedPath: "alias.ts",
      canonicalRelativePath: "src/main.ts",
    });
  } finally {
    await fixture.cleanup();
  }
});

test("命令工作目录规范化且安全摘要隐藏常见凭据", async () => {
  const fixture = await createFixture();
  try {
    await mkdir(path.join(fixture.root, "src"));
    const subject = await resolvePermissionSubject(
      preparedCommand("  API_TOKEN=secret curl --password hunter2 /tmp  ", "src"),
      fixture.workspace,
    );
    assert.equal(subject.kind, "command");
    if (subject.kind !== "command") return;
    assert.equal(subject.command, "API_TOKEN=secret curl --password hunter2 /tmp");
    assert.equal(subject.canonicalCwd, "src");
    const summary = summarizePermissionSubject(subject);
    assert.equal(JSON.stringify(summary).includes("secret"), false);
    assert.equal(JSON.stringify(summary).includes("hunter2"), false);
    assert.equal(summary.cwd, "src");
  } finally {
    await fixture.cleanup();
  }
});

test("写入摘要只包含规范路径和 UTF-8 字节数", () => {
  const summary = summarizePermissionSubject(
    {
      kind: "path",
      toolName: "write_file",
      toolKind: "write",
      requestedPath: "alias.txt",
      canonicalRelativePath: "manual/output.txt",
    },
    {
      kind: "path",
      requestedPath: "alias.txt",
      resolution: "write-target",
      byteLength: 4_096,
    },
  );

  assert.deepEqual(summary, {
    operation: "写入",
    path: "manual/output.txt",
    bytes: 4_096,
  });
});

test("越界符号链接在授权前返回无副作用 Workspace 失败", async () => {
  const fixture = await createFixture();
  const outside = await mkdtemp(path.join(tmpdir(), "orbitcode-target-outside-"));
  try {
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(path.join(outside, "secret.txt"), path.join(fixture.root, "escape.txt"));
    const error = await resolvePermissionSubject(
      preparedPath("read_file", "read-only", "escape.txt", "existing-file"),
      fixture.workspace,
    ).then(() => undefined, (failure: unknown) => failure);
    const result = permissionTargetFailure(error);
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.error.kind, "workspace-boundary");
    assert.equal(result.sideEffect, "none");
  } finally {
    await fixture.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

function preparedPath(
  name: "read_file" | "write_file",
  mutability: "read-only" | "workspace-write",
  requestedPath: string,
  resolution: "existing-file" | "write-target",
): PreparedToolCall {
  return {
    name,
    mutability,
    permissionTarget: { kind: "path", requestedPath, resolution },
    fingerprint: "fingerprint",
    async execute() {
      throw new Error("测试不执行工具");
    },
  };
}

function preparedCommand(command: string, cwd?: string): PreparedToolCall {
  return {
    name: "run_command",
    mutability: "command",
    permissionTarget: { kind: "command", command, cwd },
    fingerprint: "fingerprint",
    async execute() {
      throw new Error("测试不执行工具");
    },
  };
}

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-target-"));
  return {
    root,
    workspace: await createWorkspaceBoundary(root),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
