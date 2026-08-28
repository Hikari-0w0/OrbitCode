import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import type { WorkspaceBoundary } from "@/tools/types";
import { createWorkspaceBoundary } from "@/tools/workspace";
import {
  MAX_WEB_WORKSPACE_ID_LENGTH,
  MAX_WEB_WORKSPACE_NAME_LENGTH,
  MAX_WEB_WORKSPACES,
  type WorkspaceSummary,
} from "@/web/chat-contract";

export const MAX_WORKSPACES = MAX_WEB_WORKSPACES;
export const MAX_WORKSPACE_ID_LENGTH = MAX_WEB_WORKSPACE_ID_LENGTH;
export const MAX_WORKSPACE_NAME_LENGTH = MAX_WEB_WORKSPACE_NAME_LENGTH;

const MAX_WORKSPACE_PATH_LENGTH = 4_096;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ROOT_FIELDS = new Set(["default", "workspaces"]);
const WORKSPACE_FIELDS = new Set(["id", "name", "path"]);

export type WorkspaceConfig = {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
};

export type WorkspaceCatalog = {
  readonly entries: readonly WorkspaceConfig[];
  readonly summaries: readonly WorkspaceSummary[];
  readonly defaultWorkspaceId: string;
};

export class WorkspaceCatalogError extends Error {
  constructor(
    readonly kind:
      | "config-file"
      | "config-value"
      | "unknown-workspace"
      | "workspace-unavailable",
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "WorkspaceCatalogError";
  }
}

type LoadWorkspaceCatalogOptions = {
  readonly cwd?: string;
  readonly filePath?: string;
  readonly readTextFile?: (filePath: string) => Promise<string>;
  readonly createBoundary?: (root: string) => Promise<WorkspaceBoundary>;
};

export async function loadWorkspaceCatalog({
  cwd = process.cwd(),
  filePath = path.join(cwd, "orbitcode.workspaces.yaml"),
  readTextFile = (target) => readFile(target, "utf8"),
  createBoundary = createWorkspaceBoundary,
}: LoadWorkspaceCatalogOptions = {}): Promise<WorkspaceCatalog> {
  let source: string;
  try {
    source = await readTextFile(filePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return createFallbackCatalog(cwd, createBoundary);
    }
    throw new WorkspaceCatalogError(
      "config-file",
      "无法读取 Workspace 配置文件。",
      error,
    );
  }

  let rawConfig: unknown;
  try {
    rawConfig = parse(source, {
      maxAliasCount: 0,
      prettyErrors: true,
      uniqueKeys: true,
    });
  } catch (error) {
    throw new WorkspaceCatalogError(
      "config-file",
      "无法解析 Workspace 配置文件。",
      error,
    );
  }

  const parsed = validateRoot(rawConfig);
  const entries = await Promise.all(
    parsed.workspaces.map(async (workspace, index) => {
      let boundary: WorkspaceBoundary;
      try {
        boundary = await createBoundary(workspace.rootPath);
      } catch (error) {
        throw new WorkspaceCatalogError(
          "config-value",
          `workspaces[${index}].path 必须指向可访问的目录。`,
          error,
        );
      }
      return { ...workspace, rootPath: boundary.root };
    }),
  );
  const defaultWorkspaceId = parsed.defaultWorkspaceId ?? entries[0].id;
  if (!entries.some((entry) => entry.id === defaultWorkspaceId)) {
    throw invalidConfig("default 必须引用 workspaces 中存在的 ID。");
  }
  return createCatalog(entries, defaultWorkspaceId);
}

export async function resolveWorkspaceBoundary(
  catalog: WorkspaceCatalog,
  workspaceId: string,
  createBoundary: (root: string) => Promise<WorkspaceBoundary> =
    createWorkspaceBoundary,
): Promise<WorkspaceBoundary> {
  assertWorkspaceId(workspaceId, "workspaceId");
  const entry = catalog.entries.find((candidate) => candidate.id === workspaceId);
  if (!entry) {
    throw new WorkspaceCatalogError(
      "unknown-workspace",
      "选择的 Workspace 未经服务端授权。",
    );
  }
  try {
    return await createBoundary(entry.rootPath);
  } catch (error) {
    throw new WorkspaceCatalogError(
      "workspace-unavailable",
      `Workspace“${entry.name}”当前不可用，请修复目录后重新加载。`,
      error,
    );
  }
}

type ParsedWorkspaceRoot = {
  readonly workspaces: readonly WorkspaceConfig[];
  readonly defaultWorkspaceId?: string;
};

function validateRoot(value: unknown): ParsedWorkspaceRoot {
  if (!isRecord(value)) {
    throw invalidConfig("配置根节点必须是对象。");
  }
  for (const field of Object.keys(value)) {
    if (!ROOT_FIELDS.has(field)) {
      throw invalidConfig(`配置根节点包含未知字段：${field}`);
    }
  }
  if (
    !Array.isArray(value.workspaces) ||
    value.workspaces.length === 0 ||
    value.workspaces.length > MAX_WORKSPACES
  ) {
    throw invalidConfig(`workspaces 必须包含 1 到 ${MAX_WORKSPACES} 项。`);
  }

  const workspaces = value.workspaces.map((workspace, index) =>
    validateWorkspace(workspace, index),
  );
  const ids = new Set<string>();
  for (const workspace of workspaces) {
    if (ids.has(workspace.id)) {
      throw invalidConfig(`Workspace ID 重复：${workspace.id}`);
    }
    ids.add(workspace.id);
  }

  let defaultWorkspaceId: string | undefined;
  if (value.default !== undefined) {
    defaultWorkspaceId = requireString(value.default, "default");
    assertWorkspaceId(defaultWorkspaceId, "default");
  }
  return { workspaces, defaultWorkspaceId };
}

function validateWorkspace(value: unknown, index: number): WorkspaceConfig {
  const location = `workspaces[${index}]`;
  if (!isRecord(value)) {
    throw invalidConfig(`${location} 必须是对象。`);
  }
  for (const field of Object.keys(value)) {
    if (!WORKSPACE_FIELDS.has(field)) {
      throw invalidConfig(`${location} 包含未知字段：${field}`);
    }
  }
  const id = requireString(value.id, `${location}.id`);
  assertWorkspaceId(id, `${location}.id`);
  const name = requireString(value.name, `${location}.name`);
  if (name.length > MAX_WORKSPACE_NAME_LENGTH) {
    throw invalidConfig(
      `${location}.name 不能超过 ${MAX_WORKSPACE_NAME_LENGTH} 个字符。`,
    );
  }
  const rootPath = requireString(value.path, `${location}.path`);
  if (rootPath.length > MAX_WORKSPACE_PATH_LENGTH || !path.isAbsolute(rootPath)) {
    throw invalidConfig(`${location}.path 必须是有效的绝对路径。`);
  }
  return { id, name, rootPath };
}

function assertWorkspaceId(value: string, field: string): void {
  if (
    value.length === 0 ||
    value.length > MAX_WORKSPACE_ID_LENGTH ||
    !WORKSPACE_ID_PATTERN.test(value)
  ) {
    throw invalidConfig(
      `${field} 必须是长度不超过 ${MAX_WORKSPACE_ID_LENGTH} 的字母、数字、点、下划线或连字符。`,
    );
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidConfig(`${field} 必须是非空字符串。`);
  }
  return value.trim();
}

async function createFallbackCatalog(
  cwd: string,
  createBoundary: (root: string) => Promise<WorkspaceBoundary>,
): Promise<WorkspaceCatalog> {
  let boundary: WorkspaceBoundary;
  try {
    boundary = await createBoundary(cwd);
  } catch (error) {
    throw new WorkspaceCatalogError(
      "workspace-unavailable",
      "默认 Workspace 当前不可用。",
      error,
    );
  }
  const entry: WorkspaceConfig = {
    id: "default",
    name: path.basename(boundary.root) || "当前工作目录",
    rootPath: boundary.root,
  };
  return createCatalog([entry], entry.id);
}

function createCatalog(
  entries: readonly WorkspaceConfig[],
  defaultWorkspaceId: string,
): WorkspaceCatalog {
  return {
    entries,
    defaultWorkspaceId,
    summaries: entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      available: true,
      isDefault: entry.id === defaultWorkspaceId,
    })),
  };
}

function invalidConfig(message: string): WorkspaceCatalogError {
  return new WorkspaceCatalogError("config-value", message);
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { readonly code?: unknown }).code === code
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
