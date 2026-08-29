import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  addLocalPermissionAllow,
  loadPermissionRules,
  PermissionConfigError,
  type PermissionConfigLocations,
} from "@/tools/permission-config";

const toolTargets = new Map([
  ["read_file", "path"],
  ["write_file", "path"],
  ["edit_file", "path"],
  ["find_files", "path"],
  ["search_code", "path"],
  ["run_command", "command"],
] as const);

test("仓库权限示例可由真实配置解析器读取", async () => {
  const missingDirectory = path.join(process.cwd(), ".orbitcode-example-missing");
  const snapshot = await loadPermissionRules({
    workspaceRoot: process.cwd(),
    toolTargets,
    locations: {
      user: path.join(missingDirectory, "user.yaml"),
      project: path.join(process.cwd(), "orbitcode.permissions.example.yaml"),
      local: path.join(missingDirectory, "local.yaml"),
    },
  });

  assert.deepEqual(
    snapshot.rules.map(({ expression, decision }) => ({ expression, decision })),
    [
      { expression: "read_file(README.md)", decision: "allow" },
      { expression: "write_file(src/**)", decision: "ask" },
      { expression: "run_command(git *)", decision: "ask" },
      { expression: "run_command(git push *)", decision: "deny" },
    ],
  );
});

test("读取并合并用户、项目和本地三层规则", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(fixture.locations.user, 'rules:\n  "run_command(git *)": ask\n');
    await writeFile(fixture.locations.project, 'rules:\n  "write_file(src/**)": allow\n');
    await writeFile(fixture.locations.local, 'rules:\n  "read_file(README.md)": deny\n');
    const snapshot = await loadPermissionRules({
      workspaceRoot: fixture.workspace,
      locations: fixture.locations,
      toolTargets,
    });
    assert.deepEqual(snapshot.rules.map((rule) => rule.source), ["user", "project", "local"]);
  } finally {
    await fixture.cleanup();
  }
});

test("缺失配置为空集合，alias、重复键、未知工具和未知决策失败关闭", async () => {
  const fixture = await createFixture();
  try {
    assert.deepEqual((await loadPermissionRules({ workspaceRoot: fixture.workspace, locations: fixture.locations, toolTargets })).rules, []);
    for (const source of [
      'rules: &rules\n  "read_file(*)": allow\ncopy: *rules\n',
      'rules:\n  "read_file(*)": allow\n  "read_file(*)": deny\n',
      'rules:\n  "unknown(*)": allow\n',
      'rules:\n  "read_file(*)": maybe\n',
    ]) {
      await writeFile(fixture.locations.local, source);
      await assert.rejects(
        loadPermissionRules({ workspaceRoot: fixture.workspace, locations: fixture.locations, toolTargets }),
        PermissionConfigError,
      );
    }
  } finally {
    await fixture.cleanup();
  }
});

test("本地永久允许原子保留既有规则且重复写入幂等", async () => {
  const fixture = await createFixture();
  try {
    await writeFile(fixture.locations.local, 'rules:\n  "read_file(README.md)": deny\n');
    const first = await addLocalPermissionAllow({
      workspaceRoot: fixture.workspace,
      locations: fixture.locations,
      toolTargets,
      expression: "run_command(git status)",
    });
    assert.equal(first.rules.length, 2);
    const before = await readFile(fixture.locations.local, "utf8");
    await addLocalPermissionAllow({
      workspaceRoot: fixture.workspace,
      locations: fixture.locations,
      toolTargets,
      expression: "run_command(git status)",
    });
    assert.equal(await readFile(fixture.locations.local, "utf8"), before);
  } finally {
    await fixture.cleanup();
  }
});

test("永久精确规则中的星号和问号重载后仍按字面匹配", async () => {
  const fixture = await createFixture();
  try {
    const snapshot = await addLocalPermissionAllow({
      workspaceRoot: fixture.workspace,
      locations: fixture.locations,
      toolTargets,
      expression: "run_command(echo \\*.ts\\?)",
    });
    const stored = snapshot.rules.find((candidate) => candidate.toolName === "run_command");
    assert.equal(stored?.matchKind, "exact");
    assert.equal(stored?.pattern, "echo \\*.ts\\?");
  } finally {
    await fixture.cleanup();
  }
});

test("本地目录或文件为符号链接及并发修改时写入失败且不遗留临时文件", async () => {
  const fixture = await createFixture();
  try {
    const outside = path.join(fixture.root, "outside.yaml");
    await writeFile(outside, "rules: {}\n");
    await rm(fixture.locations.local, { force: true });
    await symlink(outside, fixture.locations.local);
    await assert.rejects(
      addLocalPermissionAllow({
        workspaceRoot: fixture.workspace,
        locations: fixture.locations,
        toolTargets,
        expression: "run_command(git status)",
      }),
      PermissionConfigError,
    );
    await rm(fixture.locations.local);
    await writeFile(fixture.locations.local, "rules: {}\n");
    await assert.rejects(
      addLocalPermissionAllow({
        workspaceRoot: fixture.workspace,
        locations: fixture.locations,
        toolTargets,
        expression: "run_command(git status)",
        async beforeRename() {
          await writeFile(fixture.locations.local, 'rules:\n  "read_file(*)": deny\n');
        },
      }),
      /并发修改/,
    );
    const entries = await import("node:fs/promises").then(({ readdir }) =>
      readdir(path.dirname(fixture.locations.local)),
    );
    assert.equal(entries.some((entry) => entry.endsWith(".tmp")), false);
  } finally {
    await fixture.cleanup();
  }
});

async function createFixture(): Promise<{
  readonly root: string;
  readonly workspace: string;
  readonly locations: PermissionConfigLocations;
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-permission-config-"));
  const workspace = path.join(root, "workspace");
  const userDirectory = path.join(root, "user");
  const projectDirectory = path.join(workspace, ".orbitcode");
  await mkdir(projectDirectory, { recursive: true });
  await mkdir(userDirectory, { recursive: true });
  const locations = {
    user: path.join(userDirectory, "permissions.yaml"),
    project: path.join(projectDirectory, "permissions.yaml"),
    local: path.join(projectDirectory, "permissions.local.yaml"),
  };
  return {
    root,
    workspace,
    locations,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
