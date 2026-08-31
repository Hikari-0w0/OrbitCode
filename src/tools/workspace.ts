import { randomUUID } from "node:crypto";
import { constants as fileSystemConstants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rmdir,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

import { isProtectedPath } from "@/tools/protected-paths";
import type {
  FileIdentity,
  ReadLimits,
  ResolvedWorkspacePath,
  TextFileSnapshot,
  WalkOptions,
  WorkspaceBoundary,
  WorkspaceEntry,
} from "@/tools/types";

const MAX_PATH_LENGTH = 1_024;
const DEFAULT_IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".orbitcode-runtime",
]);

export class WorkspaceError extends Error {
  readonly kind:
    | "invalid-path"
    | "not-found"
    | "not-file"
    | "not-directory"
    | "protected-path"
    | "unsupported-content"
    | "limit-exceeded"
    | "conflict"
    | "permission-denied"
    | "execution-failed";

  constructor(kind: WorkspaceError["kind"], message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "WorkspaceError";
    this.kind = kind;
  }
}

export async function createWorkspaceBoundary(
  root: string,
  options: WorkspaceBoundaryOptions = {},
): Promise<WorkspaceBoundary> {
  let resolvedRoot: string;
  try {
    resolvedRoot = await realpath(root);
    const rootStat = await stat(resolvedRoot);
    if (!rootStat.isDirectory()) throw new Error("not a directory");
    await access(
      resolvedRoot,
      fileSystemConstants.R_OK | fileSystemConstants.X_OK,
    );
  } catch (error) {
    throw new WorkspaceError("not-directory", "授权工作目录不可用。", error);
  }
  return new LocalWorkspaceBoundary(resolvedRoot, options);
}

export type WorkspaceBoundaryOptions = {
  // 仅供受信任的组装与故障测试使用，确保原子提交失败路径可确定验证。
  readonly beforeAtomicRename?: () => Promise<void>;
};

class LocalWorkspaceBoundary implements WorkspaceBoundary {
  constructor(
    readonly root: string,
    private readonly options: WorkspaceBoundaryOptions,
  ) {}

  async resolveExistingFile(input: string): Promise<ResolvedWorkspacePath> {
    const resolved = await this.resolveExisting(input);
    const targetStat = await safeLstat(resolved.absolutePath);
    if (!targetStat.isFile()) {
      throw new WorkspaceError("not-file", "目标不是普通文件。");
    }
    return { ...resolved, identity: identityOf(targetStat) };
  }

  async resolveExistingDirectory(input = "."): Promise<ResolvedWorkspacePath> {
    if (input === ".") {
      return { absolutePath: this.root, relativePath: ".", existed: true };
    }
    const resolved = await this.resolveExisting(input);
    const targetStat = await safeLstat(resolved.absolutePath);
    if (!targetStat.isDirectory()) {
      throw new WorkspaceError("not-directory", "目标不是目录。");
    }
    return resolved;
  }

  async resolveWriteTarget(input: string): Promise<ResolvedWorkspacePath> {
    const normalized = normalizeRelativePath(input);
    assertAllowed(normalized);
    const parentRelative = path.posix.dirname(normalized);
    const parentAbsolutePath = await this.resolveWriteParent(parentRelative);
    const requestedAbsolutePath = path.join(
      parentAbsolutePath,
      path.posix.basename(normalized),
    );
    const requestedState = await lstat(requestedAbsolutePath).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw mapFileError(error, "无法检查写入目标。");
    });
    let absolutePath = requestedAbsolutePath;
    let existing = requestedState;
    if (requestedState !== undefined) {
      absolutePath = await realpath(requestedAbsolutePath).catch((error: unknown) => {
        throw mapFileError(error, "无法解析写入目标。", "invalid-path");
      });
      assertWithinRoot(this.root, absolutePath, "写入目标超出授权工作目录。");
      existing = await safeLstat(absolutePath);
    }
    if (existing && !existing.isFile()) {
      throw new WorkspaceError("not-file", "写入目标不是普通文件。");
    }
    const relativePath = workspaceRelativePath(this.root, absolutePath);
    assertAllowed(relativePath);
    return {
      absolutePath,
      relativePath,
      existed: existing !== undefined,
      identity: existing ? identityOf(existing) : undefined,
    };
  }

  async *walk(options: WalkOptions): AsyncIterable<WorkspaceEntry> {
    const start = await this.resolveExistingDirectory(options.path);
    const entries: WorkspaceEntry[] = [];
    const visit = async (directory: string, relativeBase: string): Promise<void> => {
      assertNotAborted(options.signal);
      let children;
      try {
        children = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        throw mapFileError(error, "无法遍历工作目录。");
      }
      children.sort((left, right) => left.name.localeCompare(right.name, "en"));
      for (const child of children) {
        assertNotAborted(options.signal);
        const relativePath = relativeBase
          ? `${relativeBase}/${child.name}`
          : child.name;
        if (isProtectedPath(relativePath)) continue;
        if (child.isSymbolicLink()) continue;
        if (child.isDirectory()) {
          if (!DEFAULT_IGNORED_DIRECTORIES.has(child.name)) {
            await visit(path.join(directory, child.name), relativePath);
          }
          continue;
        }
        if (!child.isFile()) continue;
        const childStat = await stat(path.join(directory, child.name));
        entries.push({
          relativePath,
          absolutePath: path.join(directory, child.name),
          byteLength: childStat.size,
        });
        if (options.maxEntries !== undefined && entries.length >= options.maxEntries) {
          return;
        }
      }
    };
    const base = start.relativePath === "." ? "" : start.relativePath;
    await visit(start.absolutePath, base);
    entries.sort((left, right) => comparePaths(left.relativePath, right.relativePath));
    yield* entries;
  }

  async readTextFile(input: string, limits: ReadLimits): Promise<TextFileSnapshot> {
    const resolved = await this.resolveExistingFile(input);
    const identity = resolved.identity;
    if (!identity) throw new WorkspaceError("execution-failed", "文件身份缺失。");
    if (identity.size > limits.maxBytes) {
      throw new WorkspaceError("limit-exceeded", "文件超过允许读取的大小。");
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(resolved.absolutePath);
    } catch (error) {
      throw mapFileError(error, "无法读取文件。");
    }
    if (bytes.byteLength > limits.maxBytes) {
      throw new WorkspaceError("limit-exceeded", "文件超过允许读取的大小。");
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new WorkspaceError(
        "unsupported-content",
        "文件不是有效的 UTF-8 文本。",
        error,
      );
    }
    const after = await safeLstat(resolved.absolutePath);
    if (!sameIdentity(identity, identityOf(after))) {
      throw new WorkspaceError("conflict", "文件在读取期间发生变化。");
    }
    return { path: resolved, content, byteLength: bytes.byteLength, identity };
  }

  async atomicWrite(target: ResolvedWorkspacePath, content: string): Promise<void> {
    await this.commit(target, content, target.identity);
  }

  async replaceSnapshot(snapshot: TextFileSnapshot, content: string): Promise<void> {
    await this.commit(snapshot.path, content, snapshot.identity);
  }

  private async resolveExisting(input: string): Promise<ResolvedWorkspacePath> {
    const normalized = normalizeRelativePath(input);
    assertAllowed(normalized);
    const requestedAbsolutePath = path.join(this.root, ...normalized.split("/"));
    const canonical = await realpath(requestedAbsolutePath).catch((error: unknown) => {
      throw mapFileError(error, "无法解析目标路径。");
    });
    assertWithinRoot(this.root, canonical, "目标路径超出授权工作目录。");
    const relativePath = workspaceRelativePath(this.root, canonical);
    assertAllowed(relativePath);
    return { absolutePath: canonical, relativePath, existed: true };
  }

  private async resolveWriteParent(parentRelative: string): Promise<string> {
    if (parentRelative === ".") return this.root;
    let current = this.root;
    let encounteredMissingDirectory = false;
    for (const segment of parentRelative.split("/")) {
      const candidate = path.join(current, segment);
      if (encounteredMissingDirectory) {
        current = candidate;
        continue;
      }
      const state = await lstat(candidate).catch((error: unknown) => {
        if (isNodeError(error, "ENOENT")) return undefined;
        throw mapFileError(error, "无法检查写入目录。");
      });
      if (state === undefined) {
        encounteredMissingDirectory = true;
        current = candidate;
        continue;
      }
      const canonical = await realpath(candidate).catch((error: unknown) => {
        throw mapFileError(error, "无法解析写入目录。", "invalid-path");
      });
      assertWithinRoot(this.root, canonical, "写入目录超出授权工作目录。");
      const canonicalState = await safeLstat(canonical);
      if (!canonicalState.isDirectory()) {
        throw new WorkspaceError("not-directory", "写入目标的父路径不是目录。");
      }
      current = canonical;
    }
    assertWithinRoot(this.root, current, "写入目录超出授权工作目录。");
    return current;
  }

  private async commit(
    target: ResolvedWorkspacePath,
    content: string,
    expectedIdentity: FileIdentity | undefined,
  ): Promise<void> {
    const parent = path.dirname(target.absolutePath);
    const createdDirectories = await this.ensureParentDirectories(parent);
    try {
      const canonicalParent = await realpath(parent).catch((error: unknown) => {
        throw mapFileError(error, "无法解析写入目录。", "invalid-path");
      });
      if (!isWithinRoot(this.root, canonicalParent)) {
        throw new WorkspaceError("invalid-path", "写入目标超出授权工作目录。");
      }
      if (canonicalParent !== parent) {
        throw new WorkspaceError("conflict", "写入目录在执行期间发生变化。");
      }
      const current = await lstat(target.absolutePath).catch((error: unknown) => {
        if (isNodeError(error, "ENOENT")) return undefined;
        throw mapFileError(error, "无法检查写入目标。");
      });
      if (current?.isSymbolicLink()) {
        throw new WorkspaceError("conflict", "写入目标已变为符号链接。");
      }
      if (
        (expectedIdentity === undefined && current !== undefined) ||
        (expectedIdentity !== undefined &&
          (current === undefined || !sameIdentity(expectedIdentity, identityOf(current))))
      ) {
        throw new WorkspaceError("conflict", "写入目标已被其他进程修改。");
      }

      const temporaryPath = path.join(parent, `.orbitcode-${randomUUID()}.tmp`);
      let handle;
      try {
        handle = await open(temporaryPath, "wx", current?.mode ?? 0o600);
        await handle.writeFile(content, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        await this.options.beforeAtomicRename?.();
        await rename(temporaryPath, target.absolutePath);
      } finally {
        await handle?.close().catch(() => undefined);
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    } catch (error) {
      await removeEmptyDirectories(createdDirectories);
      throw mapFileError(error, "无法原子写入文件。");
    }
  }

  private async ensureParentDirectories(parent: string): Promise<readonly string[]> {
    assertWithinRoot(this.root, parent, "写入目录超出授权工作目录。");
    const relative = path.relative(this.root, parent);
    if (relative.length === 0) return [];
    const created: string[] = [];
    let current = this.root;
    try {
      for (const segment of relative.split(path.sep)) {
        const candidate = path.join(current, segment);
        let state = await lstat(candidate).catch((error: unknown) => {
          if (isNodeError(error, "ENOENT")) return undefined;
          throw mapFileError(error, "无法检查写入目录。");
        });
        if (state === undefined) {
          try {
            await mkdir(candidate, { mode: 0o700 });
            created.push(candidate);
          } catch (error) {
            if (!isNodeError(error, "EEXIST")) {
              throw mapFileError(error, "无法创建写入目录。");
            }
          }
          state = await safeLstat(candidate);
        }
        if (state.isSymbolicLink()) {
          throw new WorkspaceError("conflict", "写入目录已变为符号链接。");
        }
        if (!state.isDirectory()) {
          throw new WorkspaceError("not-directory", "写入目标的父路径不是目录。");
        }
        const canonical = await realpath(candidate).catch((error: unknown) => {
          throw mapFileError(error, "无法解析写入目录。", "invalid-path");
        });
        assertWithinRoot(this.root, canonical, "写入目录超出授权工作目录。");
        current = canonical;
      }
      if (current !== parent) {
        throw new WorkspaceError("conflict", "写入目录在执行期间发生变化。");
      }
      return created;
    } catch (error) {
      await removeEmptyDirectories(created);
      throw error;
    }
  }
}

function normalizeRelativePath(input: string): string {
  if (
    input.length === 0 ||
    input.length > MAX_PATH_LENGTH ||
    input.includes("\0") ||
    input.includes("\\") ||
    path.isAbsolute(input)
  ) {
    throw new WorkspaceError("invalid-path", "路径必须是有效的相对路径。");
  }
  const normalized = path.posix.normalize(input);
  const segments = input.split("/");
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new WorkspaceError("invalid-path", "路径包含无效路径段。");
  }
  return normalized;
}

function assertAllowed(relativePath: string): void {
  if (isProtectedPath(relativePath)) {
    throw new WorkspaceError("protected-path", "目标属于受保护路径。");
  }
}

function isWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertWithinRoot(root: string, target: string, message: string): void {
  if (!isWithinRoot(root, target)) {
    throw new WorkspaceError("invalid-path", message);
  }
}

function workspaceRelativePath(root: string, target: string): string {
  const relative = path.relative(root, target);
  if (relative === "") return ".";
  return relative.split(path.sep).join("/");
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
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedMs === right.modifiedMs
  );
}

async function safeLstat(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    throw mapFileError(error, "目标路径不存在或不可访问。");
  }
}

function mapFileError(
  error: unknown,
  fallback: string,
  fallbackKind: WorkspaceError["kind"] = "execution-failed",
): WorkspaceError {
  if (error instanceof WorkspaceError) return error;
  if (isNodeError(error, "ENOENT")) return new WorkspaceError("not-found", "目标不存在。", error);
  if (isNodeError(error, "EACCES") || isNodeError(error, "EPERM")) {
    return new WorkspaceError("permission-denied", "没有权限访问目标。", error);
  }
  return new WorkspaceError(fallbackKind, fallback, error);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function removeEmptyDirectories(
  directories: readonly string[],
): Promise<void> {
  for (const directory of [...directories].reverse()) {
    await rmdir(directory).catch(() => undefined);
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new WorkspaceError("execution-failed", "工作区操作已取消。");
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
