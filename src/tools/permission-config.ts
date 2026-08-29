import { randomUUID } from "node:crypto";
import { open, lstat, mkdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { parse, stringify } from "yaml";

import {
  parsePermissionRule,
  PermissionRuleError,
} from "@/core/permissions/rules";
import type {
  PermissionDecision,
  PermissionRule,
  PermissionRuleLayer,
  PermissionTargetKind,
} from "@/core/permissions/types";

export const MAX_PERMISSION_CONFIG_BYTES = 256 * 1024;
export const MAX_PERMISSION_RULES_PER_LAYER = 512;
export const MAX_PERMISSION_RULES_TOTAL = MAX_PERMISSION_RULES_PER_LAYER * 3;

export type PermissionConfigLocations = {
  readonly user: string;
  readonly project: string;
  readonly local: string;
};

export type PermissionRuleSnapshot = {
  readonly rules: readonly PermissionRule[];
  readonly locations: PermissionConfigLocations;
};

export class PermissionConfigError extends Error {
  readonly kind = "permission-config" as const;

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "PermissionConfigError";
  }
}

export function resolvePermissionConfigLocations(
  workspaceRoot: string,
  userHome = homedir(),
): PermissionConfigLocations {
  return {
    user: path.join(userHome, ".orbitcode", "permissions.yaml"),
    project: path.join(workspaceRoot, ".orbitcode", "permissions.yaml"),
    local: path.join(workspaceRoot, ".orbitcode", "permissions.local.yaml"),
  };
}

export async function loadPermissionRules(options: {
  readonly workspaceRoot: string;
  readonly toolTargets: ReadonlyMap<string, PermissionTargetKind>;
  readonly locations?: PermissionConfigLocations;
}): Promise<PermissionRuleSnapshot> {
  const locations = options.locations ?? resolvePermissionConfigLocations(options.workspaceRoot);
  const layers = [
    ["user", locations.user],
    ["project", locations.project],
    ["local", locations.local],
  ] as const;
  const rules: PermissionRule[] = [];
  for (const [layer, filePath] of layers) {
    const entries = await readRuleEntries(filePath, layer);
    for (const [expression, decision] of entries) {
      try {
        rules.push(parsePermissionRule({
          expression,
          decision,
          source: layer,
          toolTargets: options.toolTargets,
        }));
      } catch (error) {
        if (error instanceof PermissionRuleError) {
          throw new PermissionConfigError(`${layerLabel(layer)}权限配置包含无效规则：${error.message}`);
        }
        throw error;
      }
    }
  }
  if (rules.length > MAX_PERMISSION_RULES_TOTAL) {
    throw new PermissionConfigError("合并后的权限规则数量超过允许上限。");
  }
  return { rules, locations };
}

export async function addLocalPermissionAllow(options: {
  readonly workspaceRoot: string;
  readonly expression: string;
  readonly toolTargets: ReadonlyMap<string, PermissionTargetKind>;
  readonly locations?: PermissionConfigLocations;
  readonly beforeRename?: () => Promise<void>;
}): Promise<PermissionRuleSnapshot> {
  const locations = options.locations ?? resolvePermissionConfigLocations(options.workspaceRoot);
  parsePermissionRule({
    expression: options.expression,
    decision: "allow",
    source: "local",
    toolTargets: options.toolTargets,
  });
  const configDirectory = path.dirname(locations.local);
  await ensureSafeLocalDirectory(options.workspaceRoot, configDirectory);
  const initial = await readLocalState(locations.local);
  const entries = initial.source === undefined
    ? new Map<string, PermissionDecision>()
    : parseRuleMap(initial.source, "local");
  if (entries.size >= MAX_PERMISSION_RULES_PER_LAYER && !entries.has(options.expression)) {
    throw new PermissionConfigError("本地级权限规则数量超过允许上限。");
  }
  if (entries.get(options.expression) === "allow") {
    return loadPermissionRules({ ...options, locations });
  }
  entries.set(options.expression, "allow");
  const source = stringify({ rules: Object.fromEntries(entries) }, { lineWidth: 0 });
  if (Buffer.byteLength(source, "utf8") > MAX_PERMISSION_CONFIG_BYTES) {
    throw new PermissionConfigError("本地级权限配置超过允许大小。");
  }
  const temporaryPath = path.join(configDirectory, `.permissions-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(source, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await options.beforeRename?.();
    await assertUnchanged(locations.local, initial.identity);
    await rename(temporaryPath, locations.local);
  } catch (error) {
    if (error instanceof PermissionConfigError) throw error;
    throw new PermissionConfigError("无法安全写入本地级权限配置。", error);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  return loadPermissionRules({ ...options, locations });
}

async function readRuleEntries(
  filePath: string,
  layer: PermissionRuleLayer,
): Promise<ReadonlyMap<string, PermissionDecision>> {
  const state = await readLocalState(filePath);
  if (state.source === undefined) return new Map();
  return parseRuleMap(state.source, layer);
}

function parseRuleMap(
  source: string,
  layer: PermissionRuleLayer,
): Map<string, PermissionDecision> {
  if (Buffer.byteLength(source, "utf8") > MAX_PERMISSION_CONFIG_BYTES) {
    throw new PermissionConfigError(`${layerLabel(layer)}权限配置超过允许大小。`);
  }
  let value: unknown;
  try {
    value = parse(source, {
      maxAliasCount: 0,
      prettyErrors: true,
      uniqueKeys: true,
    });
  } catch (error) {
    throw new PermissionConfigError(`无法解析${layerLabel(layer)}权限配置。`, error);
  }
  if (!isRecord(value) || Object.keys(value).length !== 1 || !isRecord(value.rules)) {
    throw new PermissionConfigError(`${layerLabel(layer)}权限配置根节点只能包含 rules 对象。`);
  }
  const entries = Object.entries(value.rules);
  if (entries.length > MAX_PERMISSION_RULES_PER_LAYER) {
    throw new PermissionConfigError(`${layerLabel(layer)}权限规则数量超过允许上限。`);
  }
  const result = new Map<string, PermissionDecision>();
  for (const [expression, decision] of entries) {
    if (decision !== "allow" && decision !== "ask" && decision !== "deny") {
      throw new PermissionConfigError(`${layerLabel(layer)}权限规则包含未知决策。`);
    }
    result.set(expression, decision);
  }
  return result;
}

type LocalState = {
  readonly source?: string;
  readonly identity?: FileIdentity;
};

type FileIdentity = {
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly modifiedMs: number;
};

async function readLocalState(filePath: string): Promise<LocalState> {
  let state;
  try {
    state = await lstat(filePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return {};
    throw new PermissionConfigError("无法检查权限配置。", error);
  }
  if (state.isSymbolicLink() || !state.isFile()) {
    throw new PermissionConfigError("权限配置必须是普通文件且不能是符号链接。");
  }
  if (state.size > MAX_PERMISSION_CONFIG_BYTES) {
    throw new PermissionConfigError("权限配置超过允许大小。");
  }
  try {
    const source = await readFile(filePath, "utf8");
    if (Buffer.byteLength(source, "utf8") > MAX_PERMISSION_CONFIG_BYTES) {
      throw new PermissionConfigError("权限配置超过允许大小。");
    }
    const after = await lstat(filePath);
    const beforeIdentity = identityOf(state);
    if (!sameIdentity(beforeIdentity, identityOf(after))) {
      throw new PermissionConfigError("权限配置在读取期间发生变化。");
    }
    return { source, identity: beforeIdentity };
  } catch (error) {
    if (error instanceof PermissionConfigError) throw error;
    throw new PermissionConfigError("无法读取权限配置。", error);
  }
}

async function ensureSafeLocalDirectory(
  workspaceRoot: string,
  directory: string,
): Promise<void> {
  const canonicalRoot = await realpath(workspaceRoot).catch((error: unknown) => {
    throw new PermissionConfigError("Workspace 当前不可用。", error);
  });
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) {
      throw new PermissionConfigError("无法创建本地权限配置目录。", error);
    }
  }
  const state = await lstat(directory).catch((error: unknown) => {
    throw new PermissionConfigError("无法检查本地权限配置目录。", error);
  });
  if (state.isSymbolicLink() || !state.isDirectory()) {
    throw new PermissionConfigError("本地权限配置目录必须是普通目录且不能是符号链接。");
  }
  const canonicalDirectory = await realpath(directory);
  const relative = path.relative(canonicalRoot, canonicalDirectory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PermissionConfigError("本地权限配置目录超出 Workspace。");
  }
}

async function assertUnchanged(
  filePath: string,
  expected: FileIdentity | undefined,
): Promise<void> {
  const current = await lstat(filePath).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw new PermissionConfigError("无法复检本地权限配置。", error);
  });
  if (current?.isSymbolicLink() || (current !== undefined && !current.isFile())) {
    throw new PermissionConfigError("本地权限配置目标已被替换。");
  }
  const currentIdentity = current ? identityOf(current) : undefined;
  if (
    (expected === undefined && currentIdentity !== undefined) ||
    (expected !== undefined &&
      (currentIdentity === undefined || !sameIdentity(expected, currentIdentity)))
  ) {
    throw new PermissionConfigError("本地权限配置发生并发修改。");
  }
}

function identityOf(value: {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}): FileIdentity {
  return {
    device: value.dev,
    inode: value.ino,
    size: value.size,
    modifiedMs: value.mtimeMs,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedMs === right.modifiedMs;
}

function layerLabel(layer: PermissionRuleLayer): string {
  if (layer === "user") return "用户级";
  if (layer === "project") return "项目级";
  return "本地级";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
