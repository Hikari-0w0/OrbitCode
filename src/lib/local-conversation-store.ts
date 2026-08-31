import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  utimes,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { ContextManagementError } from "@/core/context/context-errors";
import type {
  ContextChunk,
  ContextStore,
  StoredContextReference,
} from "@/core/context/types";
import {
  CONVERSATION_SCHEMA_VERSION,
  ConversationRepositoryError,
  type ConversationCheckpoint,
  type ConversationCreateInput,
  type ConversationRepository,
  type ConversationSaveInput,
  type ConversationSaveResult,
  type ConversationSummary,
} from "@/core/conversations/types";
import type { AgentMode } from "@/core/agent-events";
import {
  parseConversationCheckpoint,
  parseConversationSummary,
  validateConversationId,
  validateConversationTitle,
} from "@/core/conversations/validation";

const REFERENCE_PATTERN = /^context:\/\/v1\/([0-9a-f-]{36})$/;
const MAX_STORED_CONTEXT_BYTES = 16 * 1024 * 1024;
const MAX_CONTEXT_READ_CHARACTERS = 64 * 1024;
const MAX_HEAD_BYTES = 64 * 1024;
const MAX_CHECKPOINT_BYTES = 64 * 1024 * 1024;
const LEASE_STALE_MS = 2 * 60 * 1_000;
const LEASE_HEARTBEAT_MS = 20 * 1_000;

export type ConversationWriteLease = {
  readonly ownerToken: string;
  readonly release: () => Promise<void>;
};

export type ConversationActivity =
  | { readonly status: "idle" }
  | { readonly status: "active" }
  | { readonly status: "interrupted"; readonly expectedRevision: number };

export class LocalConversationStore implements ConversationRepository, ContextStore {
  readonly #queues = new Map<string, Promise<void>>();

  constructor(
    private readonly root = path.join(homedir(), ".orbitcode", "conversations-v1"),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(): Promise<readonly ConversationSummary[]> {
    await this.ensureRoot();
    const entries = await readdir(this.root, { withFileTypes: true });
    const summaries: ConversationSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        validateConversationId(entry.name);
        summaries.push(await this.readHead(entry.name));
      } catch (error) {
        if (
          isNodeError(error, "ENOENT") ||
          (error instanceof ConversationRepositoryError && error.kind === "invalid-data")
        ) continue;
        throw normalizeStorageError(error, "无法读取本地会话列表。");
      }
    }
    return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async create(input: ConversationCreateInput): Promise<ConversationCheckpoint> {
    await this.ensureRoot();
    const id = randomUUID();
    const timestamp = this.now().toISOString();
    const summary: ConversationSummary = {
      schemaVersion: CONVERSATION_SCHEMA_VERSION,
      id,
      title: validateConversationTitle(input.title ?? "新对话"),
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      workspaceId: input.workspaceId,
      providerId: input.providerId,
    };
    const checkpoint: ConversationCheckpoint = {
      schemaVersion: CONVERSATION_SCHEMA_VERSION,
      summary,
      mode: input.mode ?? "do",
      modeTurn: 0,
      displayMessages: [],
      context: { messages: [], consecutiveSummaryFailures: 0 },
    };
    const directory = this.directory(id);
    try {
      await mkdir(directory, { mode: 0o700 });
      await mkdir(this.revisionsDirectory(id), { mode: 0o700 });
      await mkdir(this.contextDirectory(id), { mode: 0o700 });
      await this.writeRevision(checkpoint);
      await this.atomicWriteJson(this.headPath(id), summary);
      return checkpoint;
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw normalizeStorageError(error, "无法创建本地会话。");
    }
  }

  async load(conversationId: string): Promise<ConversationCheckpoint> {
    validateConversationId(conversationId);
    try {
      await this.assertConversationDirectory(conversationId);
      const head = await this.readHead(conversationId);
      const checkpoint = parseConversationCheckpoint(
        await this.readJson(
          this.revisionPath(conversationId, head.revision),
          MAX_CHECKPOINT_BYTES,
        ),
      );
      if (checkpoint.summary.id !== conversationId || checkpoint.summary.revision !== head.revision) {
        throw new ConversationRepositoryError("invalid-data", "本地会话修订指针不一致。");
      }
      return checkpoint;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new ConversationRepositoryError("not-found", "会话不存在或已被删除。");
      }
      throw normalizeStorageError(error, "无法读取本地会话。");
    }
  }

  async loadRevision(
    conversationId: string,
    revision: number,
  ): Promise<ConversationCheckpoint> {
    validateConversationId(conversationId);
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new ConversationRepositoryError("invalid-data", "会话修订号无效。");
    }
    try {
      await this.assertConversationDirectory(conversationId);
      const checkpoint = parseConversationCheckpoint(
        await this.readJson(
          this.revisionPath(conversationId, revision),
          MAX_CHECKPOINT_BYTES,
        ),
      );
      if (
        checkpoint.summary.id !== conversationId ||
        checkpoint.summary.revision !== revision
      ) {
        throw new ConversationRepositoryError("invalid-data", "本地会话修订内容不一致。");
      }
      return checkpoint;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new ConversationRepositoryError("not-found", "会话修订不存在或已被删除。");
      }
      throw normalizeStorageError(error, "无法读取本地会话修订。");
    }
  }

  async listRevisions(
    conversationId: string,
  ): Promise<readonly ConversationCheckpoint[]> {
    validateConversationId(conversationId);
    try {
      await this.assertConversationDirectory(conversationId);
      const entries = await readdir(this.revisionsDirectory(conversationId), {
        withFileTypes: true,
      });
      const revisions = entries
        .filter((entry) => entry.isFile() && /^\d{12}\.json$/.test(entry.name))
        .map((entry) => Number(entry.name.slice(0, 12)))
        .sort((left, right) => left - right);
      if (revisions.length === 0) {
        throw new ConversationRepositoryError("invalid-data", "本地会话没有可用修订。");
      }
      const checkpoints: ConversationCheckpoint[] = [];
      for (const revision of revisions) {
        checkpoints.push(await this.loadRevision(conversationId, revision));
      }
      return checkpoints;
    } catch (error) {
      if (error instanceof ConversationRepositoryError) throw error;
      throw normalizeStorageError(error, "无法读取本地会话修订列表。");
    }
  }

  async save(input: ConversationSaveInput): Promise<ConversationSaveResult> {
    validateConversationId(input.conversationId);
    return this.serialize(input.conversationId, async () => {
      const current = await this.load(input.conversationId);
      if (current.summary.revision !== input.expectedRevision) {
        return {
          status: "conflict",
          expectedRevision: input.expectedRevision,
          actualRevision: current.summary.revision,
        };
      }
      const revision = current.summary.revision + 1;
      const checkpoint: ConversationCheckpoint = {
        ...input.checkpoint,
        summary: {
          ...input.checkpoint.summary,
          id: input.conversationId,
          revision,
          updatedAt: this.now().toISOString(),
        },
      };
      parseConversationCheckpoint(checkpoint);
      try {
        await this.writeRevision(checkpoint);
      } catch (error) {
        if (error instanceof ConversationRepositoryError && error.kind === "conflict") {
          const head = await this.readHead(input.conversationId).catch(() => current.summary);
          return {
            status: "conflict",
            expectedRevision: input.expectedRevision,
            actualRevision: Math.max(head.revision, revision),
          };
        }
        throw error;
      }
      await this.atomicWriteJson(this.headPath(input.conversationId), checkpoint.summary);
      return { status: "saved", checkpoint };
    });
  }

  async rename(input: {
    readonly conversationId: string;
    readonly expectedRevision: number;
    readonly title: string;
  }): Promise<ConversationSaveResult> {
    const current = await this.load(input.conversationId);
    return this.save({
      conversationId: input.conversationId,
      expectedRevision: input.expectedRevision,
      checkpoint: {
        ...current,
        summary: {
          ...summaryForSave(current.summary, current.summary.lastStopReason),
          title: validateConversationTitle(input.title),
        },
      },
    });
  }

  async clear(input: {
    readonly conversationId: string;
    readonly expectedRevision: number;
  }): Promise<ConversationSaveResult> {
    const current = await this.load(input.conversationId);
    const result = await this.save({
      conversationId: input.conversationId,
      expectedRevision: input.expectedRevision,
      checkpoint: {
        ...current,
        summary: summaryForSave(current.summary, undefined),
        modeTurn: 0,
        displayMessages: [],
        context: { messages: [], consecutiveSummaryFailures: 0 },
      },
    });
    if (result.status === "saved") {
      await rm(this.contextDirectory(input.conversationId), {
        recursive: true,
        force: true,
      });
      await mkdir(this.contextDirectory(input.conversationId), { mode: 0o700 });
    }
    return result;
  }

  async delete(input: {
    readonly conversationId: string;
    readonly expectedRevision: number;
  }): Promise<void> {
    validateConversationId(input.conversationId);
    await this.serialize(input.conversationId, async () => {
      const current = await this.load(input.conversationId);
      if (current.summary.revision !== input.expectedRevision) {
        throw new ConversationRepositoryError("conflict", "会话已在其他页面更新，请刷新后重试。");
      }
      await rm(this.directory(input.conversationId), { recursive: true, force: true });
    });
  }

  async acquireWriteLease(conversationId: string): Promise<ConversationWriteLease> {
    validateConversationId(conversationId);
    await this.load(conversationId);
    const leaseDirectory = this.writeLeaseDirectory(conversationId);
    const token = randomUUID();
    const acquire = async (mayBreakStale: boolean): Promise<void> => {
      try {
        await mkdir(leaseDirectory, { mode: 0o700 });
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
        const leaseStat = await lstat(leaseDirectory).catch(() => undefined);
        if (
          mayBreakStale &&
          leaseStat?.isDirectory() &&
          this.now().getTime() - leaseStat.mtimeMs >= LEASE_STALE_MS
        ) {
          await rm(leaseDirectory, { recursive: true, force: true });
          await acquire(false);
          return;
        }
        throw new ConversationRepositoryError("busy", "当前会话正在另一个进程中运行。");
      }
      await this.atomicWriteJson(path.join(leaseDirectory, "owner.json"), {
        token,
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      });
    };
    await acquire(true);
    const heartbeat = setInterval(() => {
      const now = new Date();
      void utimes(leaseDirectory, now, now).catch(() => undefined);
    }, LEASE_HEARTBEAT_MS);
    heartbeat.unref();
    let released = false;
    return {
      ownerToken: token,
      release: async () => {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        try {
          const owner = await this.readJson(
            path.join(leaseDirectory, "owner.json"),
            MAX_HEAD_BYTES,
          );
          if (isRecordWithToken(owner, token)) {
            await rm(leaseDirectory, { recursive: true, force: true });
          }
        } catch (error) {
          if (!isNodeError(error, "ENOENT")) throw error;
        }
      },
    };
  }

  async inspectActivity(conversationId: string): Promise<ConversationActivity> {
    validateConversationId(conversationId);
    await this.load(conversationId);
    const leaseDirectory = this.writeLeaseDirectory(conversationId);
    const leaseStat = await lstat(leaseDirectory).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw normalizeStorageError(error, "无法读取会话运行状态。");
    });
    if (leaseStat !== undefined) {
      if (!leaseStat.isDirectory() || leaseStat.isSymbolicLink()) {
        throw new ConversationRepositoryError("invalid-data", "本地会话运行状态无效。");
      }
      if (this.now().getTime() - leaseStat.mtimeMs < LEASE_STALE_MS) {
        return { status: "active" };
      }
    }

    let marker: unknown;
    try {
      marker = await this.readJson(this.activeTurnPath(conversationId), MAX_HEAD_BYTES);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { status: "idle" };
      throw normalizeStorageError(error, "无法读取会话运行状态。");
    }
    if (!isTurnMarker(marker)) {
      throw new ConversationRepositoryError("invalid-data", "本地会话恢复标记损坏。");
    }
    return { status: "interrupted", expectedRevision: marker.expectedRevision };
  }

  async markTurnStarted(input: {
    readonly conversationId: string;
    readonly expectedRevision: number;
    readonly userInput: string;
    readonly mode: AgentMode;
    readonly modeTurn: number;
    readonly ownerToken?: string;
  }): Promise<void> {
    const checkpoint = await this.load(input.conversationId);
    if (checkpoint.summary.revision !== input.expectedRevision) {
      throw new ConversationRepositoryError("conflict", "会话已更新，请刷新后重试。");
    }
    await this.atomicWriteJson(this.activeTurnPath(input.conversationId), {
      schemaVersion: 1,
      expectedRevision: input.expectedRevision,
      userInput: input.userInput,
      mode: input.mode,
      modeTurn: input.modeTurn,
      startedAt: this.now().toISOString(),
      ...(input.ownerToken === undefined ? {} : { ownerToken: input.ownerToken }),
    });
  }

  async clearTurnMarker(conversationId: string, ownerToken?: string): Promise<void> {
    validateConversationId(conversationId);
    if (ownerToken !== undefined) {
      let marker: unknown;
      try {
        marker = await this.readJson(this.activeTurnPath(conversationId), MAX_HEAD_BYTES);
      } catch (error) {
        if (isNodeError(error, "ENOENT")) return;
        throw normalizeStorageError(error, "无法读取会话恢复标记。");
      }
      if (!isTurnMarker(marker) || marker.ownerToken !== ownerToken) {
        throw new ConversationRepositoryError("busy", "会话运行所有权已发生变化。");
      }
    }
    await rm(this.activeTurnPath(conversationId), { force: true });
  }

  async recoverInterruptedTurn(
    conversationId: string,
    existingLease?: ConversationWriteLease,
  ): Promise<ConversationCheckpoint> {
    validateConversationId(conversationId);
    const lease = existingLease ?? await this.acquireWriteLease(conversationId);
    try {
      return await this.recoverInterruptedTurnWithLease(conversationId);
    } finally {
      if (existingLease === undefined) await lease.release();
    }
  }

  private async recoverInterruptedTurnWithLease(
    conversationId: string,
  ): Promise<ConversationCheckpoint> {
    let marker: unknown;
    try {
      marker = await this.readJson(this.activeTurnPath(conversationId), MAX_HEAD_BYTES);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw normalizeStorageError(error, "无法读取会话恢复标记。");
      }
      return this.load(conversationId);
    }
    if (!isTurnMarker(marker)) {
      throw new ConversationRepositoryError("invalid-data", "本地会话恢复标记损坏。");
    }
    const current = await this.load(conversationId);
    if (current.summary.revision !== marker.expectedRevision) {
      await this.clearTurnMarker(conversationId);
      return current;
    }
    const detail = "上一次 Agent 运行因服务进程中断而未完成，已恢复到最近完整检查点。";
    const summary = summaryForSave(current.summary, "agent-error");
    const result = await this.save({
      conversationId,
      expectedRevision: marker.expectedRevision,
      checkpoint: {
        schemaVersion: current.schemaVersion,
        summary,
        mode: marker.mode,
        modeTurn: marker.modeTurn,
        displayMessages: [
          ...current.displayMessages,
          { id: randomUUID(), role: "user", content: marker.userInput, state: "complete" },
          {
            id: randomUUID(),
            role: "assistant",
            content: "",
            state: "failed",
            detail,
            stopReason: "agent-error",
            durationMs: Math.max(0, this.now().getTime() - Date.parse(marker.startedAt)),
          },
        ],
        context: {
          ...current.context,
          messages: [
            ...current.context.messages,
            { kind: "user", content: marker.userInput },
            {
              kind: "interruption",
              reason: "agent-error",
              detail,
              sideEffect: "possible",
            },
          ],
        },
      },
    });
    if (result.status === "conflict") return this.load(conversationId);
    await this.clearTurnMarker(conversationId);
    return result.checkpoint;
  }

  async write(input: {
    readonly sessionId: string;
    readonly content: string;
    readonly signal: AbortSignal;
  }): Promise<StoredContextReference> {
    validateConversationId(input.sessionId);
    if (input.signal.aborted) throw cancelled();
    const byteLength = Buffer.byteLength(input.content, "utf8");
    if (byteLength > MAX_STORED_CONTEXT_BYTES) throw contextStorageError("工具结果超过本地上下文存储上限。");
    const objectId = randomUUID();
    const target = path.join(this.contextDirectory(input.sessionId), `${objectId}.txt`);
    try {
      await this.assertContextDirectory(input.sessionId);
      await this.atomicWriteText(target, input.content);
      if (input.signal.aborted) {
        await rm(target, { force: true });
        throw cancelled();
      }
      return { reference: `context://v1/${objectId}`, byteLength };
    } catch (error) {
      if (error instanceof ContextManagementError) throw error;
      throw contextStorageError("无法保存工具结果到本地上下文存储。", error);
    }
  }

  async read(input: {
    readonly sessionId: string;
    readonly reference: string;
    readonly offset: number;
    readonly limit: number;
    readonly signal: AbortSignal;
  }): Promise<ContextChunk> {
    validateConversationId(input.sessionId);
    const objectId = parseReference(input.reference);
    if (!Number.isSafeInteger(input.offset) || input.offset < 0 || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_CONTEXT_READ_CHARACTERS) {
      throw referenceError();
    }
    if (input.signal.aborted) throw cancelled();
    const directory = this.contextDirectory(input.sessionId);
    const target = path.join(directory, `${objectId}.txt`);
    try {
      await this.assertContextDirectory(input.sessionId);
      const [directoryRealPath, targetRealPath, stat] = await Promise.all([
        realpath(directory),
        realpath(target),
        lstat(target),
      ]);
      if (stat.isSymbolicLink() || !stat.isFile() || !isWithin(directoryRealPath, targetRealPath) || stat.size > MAX_STORED_CONTEXT_BYTES) {
        throw referenceError();
      }
      const characters = Array.from(await readFile(targetRealPath, "utf8"));
      if (input.signal.aborted || input.offset > characters.length) throw referenceError();
      const content = characters.slice(input.offset, input.offset + input.limit).join("");
      const nextOffset = input.offset + Array.from(content).length;
      return {
        content,
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
    validateConversationId(input.sessionId);
    const objectId = parseReference(input.reference);
    await this.assertContextDirectory(input.sessionId);
    await rm(path.join(this.contextDirectory(input.sessionId), `${objectId}.txt`), {
      force: true,
    }).catch(() => undefined);
  }

  async deleteSession(sessionId: string): Promise<void> {
    validateConversationId(sessionId);
    await this.assertConversationDirectory(sessionId);
    await rm(this.contextDirectory(sessionId), { recursive: true, force: true });
  }

  private async readHead(conversationId: string): Promise<ConversationSummary> {
    return parseConversationSummary(
      await this.readJson(this.headPath(conversationId), MAX_HEAD_BYTES),
    );
  }

  private async writeRevision(checkpoint: ConversationCheckpoint): Promise<void> {
    const content = `${JSON.stringify(checkpoint)}\n`;
    if (Buffer.byteLength(content, "utf8") > MAX_CHECKPOINT_BYTES) {
      throw new ConversationRepositoryError("storage", "本地会话检查点超过容量上限。");
    }
    const target = this.revisionPath(checkpoint.summary.id, checkpoint.summary.revision);
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      await link(temporary, target);
      await chmod(target, 0o600);
    } catch (error) {
      await handle.close().catch(() => undefined);
      if (isNodeError(error, "EEXIST")) {
        throw new ConversationRepositoryError("conflict", "会话修订已由其他进程提交。");
      }
      throw error;
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async atomicWriteJson(target: string, value: unknown): Promise<void> {
    const content = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(content, "utf8") > MAX_CHECKPOINT_BYTES) {
      throw new ConversationRepositoryError("storage", "本地会话检查点超过容量上限。");
    }
    await this.atomicWriteText(target, content);
  }

  private async readJson(target: string, maxBytes: number): Promise<unknown> {
    const targetStat = await lstat(target);
    if (targetStat.isSymbolicLink() || !targetStat.isFile() || targetStat.size > maxBytes) {
      throw new ConversationRepositoryError("invalid-data", "本地会话文件类型或容量无效。");
    }
    return JSON.parse(await readFile(target, "utf8")) as unknown;
  }

  private async atomicWriteText(target: string, content: string): Promise<void> {
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      await rename(temporary, target);
      await chmod(target, 0o600);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(this.root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new ConversationRepositoryError("storage", "本地会话根目录类型无效。");
    }
    await chmod(this.root, 0o700);
  }

  private async assertConversationDirectory(id: string): Promise<void> {
    const [rootStat, directoryStat, rootRealPath, directoryRealPath] = await Promise.all([
      lstat(this.root),
      lstat(this.directory(id)),
      realpath(this.root),
      realpath(this.directory(id)),
    ]);
    if (
      rootStat.isSymbolicLink() ||
      !rootStat.isDirectory() ||
      directoryStat.isSymbolicLink() ||
      !directoryStat.isDirectory() ||
      !isWithin(rootRealPath, directoryRealPath)
    ) throw new ConversationRepositoryError("invalid-data", "本地会话目录类型或边界无效。");
  }

  private async assertContextDirectory(id: string): Promise<void> {
    await this.assertConversationDirectory(id);
    const [conversationRealPath, contextRealPath, contextStat] = await Promise.all([
      realpath(this.directory(id)),
      realpath(this.contextDirectory(id)),
      lstat(this.contextDirectory(id)),
    ]);
    if (
      contextStat.isSymbolicLink() ||
      !contextStat.isDirectory() ||
      !isWithin(conversationRealPath, contextRealPath)
    ) throw contextStorageError("本地会话上下文目录类型或边界无效。");
  }

  private directory(id: string): string {
    return path.join(this.root, id);
  }

  private revisionsDirectory(id: string): string {
    return path.join(this.directory(id), "revisions");
  }

  private contextDirectory(id: string): string {
    return path.join(this.directory(id), "context");
  }

  private headPath(id: string): string {
    return path.join(this.directory(id), "head.json");
  }

  private activeTurnPath(id: string): string {
    return path.join(this.directory(id), "active-turn.json");
  }

  private writeLeaseDirectory(id: string): string {
    return path.join(this.directory(id), ".write-lease");
  }

  private revisionPath(id: string, revision: number): string {
    return path.join(this.revisionsDirectory(id), `${String(revision).padStart(12, "0")}.json`);
  }

  private async serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(id) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.#queues.set(id, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#queues.get(id) === tail) this.#queues.delete(id);
    }
  }
}

type TurnMarker = {
  readonly schemaVersion: 1;
  readonly expectedRevision: number;
  readonly userInput: string;
  readonly mode: AgentMode;
  readonly modeTurn: number;
  readonly startedAt: string;
  readonly ownerToken?: string;
};

function isTurnMarker(value: unknown): value is TurnMarker {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  return marker.schemaVersion === 1 &&
    Number.isSafeInteger(marker.expectedRevision) &&
    Number(marker.expectedRevision) >= 0 &&
    typeof marker.userInput === "string" &&
    (marker.mode === "plan" || marker.mode === "do") &&
    Number.isSafeInteger(marker.modeTurn) &&
    Number(marker.modeTurn) >= 1 &&
    typeof marker.startedAt === "string" &&
    (marker.ownerToken === undefined ||
      (typeof marker.ownerToken === "string" && marker.ownerToken.length > 0)) &&
    Number.isFinite(Date.parse(marker.startedAt));
}

function summaryForSave(
  summary: ConversationSummary,
  lastStopReason: ConversationSummary["lastStopReason"],
) {
  return {
    schemaVersion: summary.schemaVersion,
    id: summary.id,
    title: summary.title,
    createdAt: summary.createdAt,
    workspaceId: summary.workspaceId,
    providerId: summary.providerId,
    ...(lastStopReason === undefined ? {} : { lastStopReason }),
  };
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
  return new ContextManagementError("storage", "上下文引用无效或不属于当前会话。");
}

function contextStorageError(message: string, cause?: unknown): ContextManagementError {
  return new ContextManagementError("storage", message, { cause });
}

function cancelled(): ContextManagementError {
  return new ContextManagementError("cancelled", "上下文存储操作已取消。");
}

function normalizeStorageError(error: unknown, message: string): ConversationRepositoryError {
  if (error instanceof ConversationRepositoryError) return error;
  return new ConversationRepositoryError("storage", message);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecordWithToken(value: unknown, token: string): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    "token" in value && value.token === token;
}
