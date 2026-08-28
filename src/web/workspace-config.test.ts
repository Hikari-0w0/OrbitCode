import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkspaceBoundary } from "@/tools/workspace";
import {
  loadWorkspaceCatalog,
  MAX_WORKSPACE_ID_LENGTH,
  MAX_WORKSPACE_NAME_LENGTH,
  MAX_WORKSPACES,
  resolveWorkspaceBoundary,
  WorkspaceCatalogError,
} from "@/web/workspace-config";

test("配置缺失时使用启动目录作为唯一默认 Workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-catalog-fallback-"));
  try {
    const catalog = await loadWorkspaceCatalog({
      cwd: root,
      filePath: path.join(root, "missing.yaml"),
    });
    assert.equal(catalog.defaultWorkspaceId, "default");
    assert.deepEqual(catalog.summaries, [
      {
        id: "default",
        name: path.basename(root),
        available: true,
        isDefault: true,
      },
    ]);
    assert.equal(catalog.entries[0].rootPath, await realpath(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("加载多个授权 Workspace 并只公开安全摘要", async () => {
  const first = await mkdtemp(path.join(tmpdir(), "orbitcode-catalog-a-"));
  const second = await mkdtemp(path.join(tmpdir(), "orbitcode-catalog-b-"));
  try {
    const source = workspaceYaml([
      { id: "alpha", name: "项目 A", rootPath: first },
      { id: "beta", name: "项目 B", rootPath: second },
    ], "beta");
    const catalog = await loadWorkspaceCatalog({
      filePath: "/virtual/workspaces.yaml",
      readTextFile: async () => source,
    });
    assert.equal(catalog.defaultWorkspaceId, "beta");
    assert.deepEqual(catalog.summaries, [
      { id: "alpha", name: "项目 A", available: true, isDefault: false },
      { id: "beta", name: "项目 B", available: true, isDefault: true },
    ]);
    assert.equal(JSON.stringify(catalog.summaries).includes(first), false);
    assert.equal(JSON.stringify(catalog.summaries).includes(second), false);
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

test("严格拒绝非法根结构、字段、ID、名称、路径和默认项", async () => {
  const validPath = path.join(tmpdir(), "workspace");
  const invalidSources = [
    "[]",
    "workspaces: []",
    `workspaces:\n  - id: ok\n    name: Name\n    path: ${validPath}\nextra: true`,
    `workspaces:\n  - id: bad/id\n    name: Name\n    path: ${validPath}`,
    `workspaces:\n  - id: ${"x".repeat(MAX_WORKSPACE_ID_LENGTH + 1)}\n    name: Name\n    path: ${validPath}`,
    `workspaces:\n  - id: ok\n    name: ${"x".repeat(MAX_WORKSPACE_NAME_LENGTH + 1)}\n    path: ${validPath}`,
    "workspaces:\n  - id: ok\n    name: Name\n    path: relative/path",
    `default: missing\nworkspaces:\n  - id: ok\n    name: Name\n    path: ${validPath}`,
    `workspaces:\n  - id: same\n    name: One\n    path: ${validPath}\n  - id: same\n    name: Two\n    path: ${validPath}`,
    `workspaces:\n  - id: ok\n    name: Name\n    path: ${validPath}\n    unknown: true`,
  ];
  for (const source of invalidSources) {
    await assert.rejects(
      loadWorkspaceCatalog({
        filePath: "/virtual/workspaces.yaml",
        readTextFile: async () => source,
        createBoundary: async (root) => createWorkspaceBoundary(root),
      }),
      WorkspaceCatalogError,
    );
  }
});

test("限制 Workspace 数量并拒绝 YAML alias 与重复键", async () => {
  const excessive = Array.from({ length: MAX_WORKSPACES + 1 }, (_, index) =>
    `  - id: w${index}\n    name: W${index}\n    path: /tmp/w${index}`,
  ).join("\n");
  await assert.rejects(loadSource(`workspaces:\n${excessive}`), /1 到/);
  await assert.rejects(
    loadSource("workspaces:\n  - &item\n    id: one\n    name: One\n    path: /tmp\n  - *item"),
    /解析|alias|Alias/,
  );
  await assert.rejects(
    loadSource("workspaces:\n  - id: one\n    id: two\n    name: One\n    path: /tmp"),
    /解析|map keys|unique/i,
  );
});

test("显式配置中的不可用目录使整个目录加载失败且不泄漏路径", async () => {
  const sentinelPath = "/private/sentinel-workspace-path";
  await assert.rejects(
    loadWorkspaceCatalog({
      filePath: "/virtual/workspaces.yaml",
      readTextFile: async () => workspaceYaml([
        { id: "secret", name: "安全项目", rootPath: sentinelPath },
      ]),
      createBoundary: async () => {
        throw new Error(`private detail ${sentinelPath}`);
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceCatalogError);
      assert.equal(error.kind, "config-value");
      assert.equal(error.message.includes(sentinelPath), false);
      assert.equal(error.message.includes("private detail"), false);
      return true;
    },
  );
});

test("非 ENOENT 读取错误不会回退到启动目录或泄漏原因", async () => {
  const sentinel = "private-reader-detail";
  await assert.rejects(
    loadWorkspaceCatalog({
      cwd: "/safe/fallback",
      filePath: "/virtual/workspaces.yaml",
      readTextFile: async () => {
        throw new Error(sentinel);
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceCatalogError);
      assert.equal(error.kind, "config-file");
      assert.equal(error.message.includes(sentinel), false);
      assert.equal(error.message.includes("/virtual"), false);
      return true;
    },
  );
});

test("按 ID 重新验证目录并区分未知与当前不可用", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-resolve-"));
  try {
    const catalog = await loadWorkspaceCatalog({
      filePath: "/virtual/workspaces.yaml",
      readTextFile: async () => workspaceYaml([
        { id: "project", name: "项目", rootPath: root },
      ]),
    });
    const boundary = await resolveWorkspaceBoundary(catalog, "project");
    assert.equal(boundary.root, await realpath(root));

    await assert.rejects(
      resolveWorkspaceBoundary(catalog, "missing"),
      (error: unknown) =>
        error instanceof WorkspaceCatalogError && error.kind === "unknown-workspace",
    );
    await rm(root, { recursive: true, force: true });
    await assert.rejects(
      resolveWorkspaceBoundary(catalog, "project"),
      (error: unknown) =>
        error instanceof WorkspaceCatalogError &&
        error.kind === "workspace-unavailable" &&
        !error.message.includes(root),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("目录加载失败消息不包含配置路径或底层错误", async () => {
  const sentinel = "sentinel-config-path";
  await assert.rejects(
    loadWorkspaceCatalog({
      filePath: `/${sentinel}/orbitcode.workspaces.yaml`,
      readTextFile: async () => {
        const error = new Error(`secret ${sentinel}`) as Error & { code: string };
        error.code = "EACCES";
        throw error;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceCatalogError);
      assert.equal(error.message.includes(sentinel), false);
      return true;
    },
  );
});

async function loadSource(source: string) {
  return loadWorkspaceCatalog({
    filePath: "/virtual/workspaces.yaml",
    readTextFile: async () => source,
    createBoundary: async (root) => createWorkspaceBoundary(root),
  });
}

function workspaceYaml(
  entries: readonly {
    readonly id: string;
    readonly name: string;
    readonly rootPath: string;
  }[],
  defaultWorkspaceId?: string,
): string {
  return [
    ...(defaultWorkspaceId ? [`default: ${defaultWorkspaceId}`] : []),
    "workspaces:",
    ...entries.flatMap((entry) => [
      `  - id: ${entry.id}`,
      `    name: ${entry.name}`,
      `    path: ${entry.rootPath}`,
    ]),
  ].join("\n");
}
