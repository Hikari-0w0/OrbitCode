import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { ContextManagementError } from "@/core/context/context-errors";
import type {
  ContextChunk,
  ContextStore,
  StoredContextReference,
} from "@/core/context/types";

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const REFERENCE_PATTERN = /^context:\/\/v1\/([0-9a-f-]{36})$/;
const MAX_STORED_CONTEXT_BYTES = 16 * 1024 * 1024;
const MAX_CONTEXT_READ_CHARACTERS = 64 * 1024;

export class LocalContextStore implements ContextStore {
  constructor(
    private readonly root = path.join(homedir(), ".orbitcode", "context-v1"),
  ) {}

  async write(input: {
    readonly sessionId: string;
    readonly content: string;
    readonly signal: AbortSignal;
  }): Promise<StoredContextReference> {
    assertSessionId(input.sessionId);
    if (input.signal.aborted) throw cancelled();
    const byteLength = Buffer.byteLength(input.content, "utf8");
    if (byteLength > MAX_STORED_CONTEXT_BYTES) {
      throw storageError("工具结果超过本地上下文存储上限。");
    }

    const sessionDirectory = await this.ensureSessionDirectory(input.sessionId);
    const objectId = randomUUID();
    const target = path.join(sessionDirectory, `${objectId}.txt`);
    const temporary = path.join(sessionDirectory, `.${objectId}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, input.content, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      if (input.signal.aborted) {
        await rm(temporary, { force: true });
        throw cancelled();
      }
      await rename(temporary, target);
      await chmod(target, 0o600);
      return {
        reference: `context://v1/${objectId}`,
        byteLength,
      };
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      if (error instanceof ContextManagementError) throw error;
      throw storageError("无法保存工具结果到本地上下文存储。", error);
    }
  }

  async read(input: {
    readonly sessionId: string;
    readonly reference: string;
    readonly offset: number;
    readonly limit: number;
    readonly signal: AbortSignal;
  }): Promise<ContextChunk> {
    assertSessionId(input.sessionId);
    const objectId = parseReference(input.reference);
    if (
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > MAX_CONTEXT_READ_CHARACTERS
    ) {
      throw referenceError();
    }
    if (input.signal.aborted) throw cancelled();

    const sessionDirectory = path.join(this.root, input.sessionId);
    const target = path.join(sessionDirectory, `${objectId}.txt`);
    try {
      const [directoryRealPath, targetRealPath, targetStat] = await Promise.all([
        realpath(sessionDirectory),
        realpath(target),
        lstat(target),
      ]);
      if (
        targetStat.isSymbolicLink() ||
        !targetStat.isFile() ||
        !isWithin(directoryRealPath, targetRealPath)
      ) {
        throw referenceError();
      }
      if (targetStat.size > MAX_STORED_CONTEXT_BYTES) throw referenceError();
      const content = await readFile(targetRealPath, "utf8");
      if (input.signal.aborted) throw cancelled();
      const characters = Array.from(content);
      if (input.offset > characters.length) throw referenceError();
      const chunk = characters.slice(input.offset, input.offset + input.limit).join("");
      const nextOffset = input.offset + Array.from(chunk).length;
      return {
        content: chunk,
        offset: input.offset,
        nextOffset,
        totalCharacters: characters.length,
        hasMore: nextOffset < characters.length,
      };
    } catch (error) {
      if (error instanceof ContextManagementError) throw error;
      throw referenceError();
    }
  }

  async deleteReference(input: {
    readonly sessionId: string;
    readonly reference: string;
  }): Promise<void> {
    assertSessionId(input.sessionId);
    const objectId = parseReference(input.reference);
    const sessionDirectory = path.join(this.root, input.sessionId);
    const target = path.join(sessionDirectory, `${objectId}.txt`);
    try {
      const directoryRealPath = await realpath(sessionDirectory);
      const targetRealPath = await realpath(target);
      if (!isWithin(directoryRealPath, targetRealPath)) throw referenceError();
      const targetStat = await lstat(targetRealPath);
      if (targetStat.isSymbolicLink() || !targetStat.isFile()) throw referenceError();
      await rm(targetRealPath, { force: true });
    } catch (error) {
      if (error instanceof ContextManagementError) throw error;
      // 删除用于回滚和清理，目标已经不存在时视为完成。
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    assertSessionId(sessionId);
    const target = path.join(this.root, sessionId);
    if (path.dirname(target) !== this.root) throw storageError("上下文会话路径无效。");
    await rm(target, { recursive: true, force: true }).catch((error) => {
      throw storageError("无法清理本地上下文会话。", error);
    });
  }

  async cleanupExpiredSessions(input: {
    readonly olderThanMs: number;
    readonly protectedSessionIds?: ReadonlySet<string>;
    readonly now?: number;
  }): Promise<number> {
    if (!Number.isSafeInteger(input.olderThanMs) || input.olderThanMs < 1) {
      throw storageError("上下文孤儿清理期限无效。");
    }
    const now = input.now ?? Date.now();
    if (!Number.isFinite(now)) throw storageError("上下文孤儿清理时间无效。");
    let entries;
    let rootRealPath: string;
    try {
      [entries, rootRealPath] = await Promise.all([
        readdir(this.root, { withFileTypes: true }),
        realpath(this.root),
      ]);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return 0;
      throw storageError("无法检查本地上下文孤儿目录。", error);
    }

    let removed = 0;
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        !SAFE_ID.test(entry.name) ||
        input.protectedSessionIds?.has(entry.name)
      ) continue;
      const target = path.join(this.root, entry.name);
      try {
        const [targetStat, targetRealPath] = await Promise.all([
          lstat(target),
          realpath(target),
        ]);
        if (
          targetStat.isSymbolicLink() ||
          !targetStat.isDirectory() ||
          !isWithin(rootRealPath, targetRealPath) ||
          now - targetStat.mtimeMs < input.olderThanMs
        ) continue;
        await rm(targetRealPath, { recursive: true, force: true });
        removed += 1;
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) {
          throw storageError("无法清理本地上下文孤儿目录。", error);
        }
      }
    }
    return removed;
  }

  private async ensureSessionDirectory(sessionId: string): Promise<string> {
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await chmod(this.root, 0o700);
      const sessionDirectory = path.join(this.root, sessionId);
      await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
      await chmod(sessionDirectory, 0o700);
      const rootRealPath = await realpath(this.root);
      const sessionRealPath = await realpath(sessionDirectory);
      if (!isWithin(rootRealPath, sessionRealPath)) {
        throw storageError("本地上下文存储目录无效。");
      }
      return sessionRealPath;
    } catch (error) {
      if (error instanceof ContextManagementError) throw error;
      throw storageError("无法初始化本地上下文存储。", error);
    }
  }
}

function assertSessionId(sessionId: string): void {
  if (!SAFE_ID.test(sessionId)) throw referenceError();
}

function parseReference(reference: string): string {
  const match = REFERENCE_PATTERN.exec(reference);
  if (!match?.[1]) throw referenceError();
  return match[1];
}

function isWithin(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function referenceError(): ContextManagementError {
  return new ContextManagementError(
    "storage",
    "上下文引用无效、已过期或不属于当前会话。",
  );
}

function storageError(message: string, cause?: unknown): ContextManagementError {
  return new ContextManagementError("storage", message, { cause });
}

function cancelled(): ContextManagementError {
  return new ContextManagementError("cancelled", "上下文存储操作已取消。");
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error &&
    "code" in error &&
    error.code === code;
}
