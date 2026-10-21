import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChildReplyStorage, ChildExecutionHandoff, TaskScope } from "@/core/sub-agents/types";
import { readBounded, within } from "./bounded-files";
import { realpath } from "node:fs/promises";

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const CHILD_REPLY_MAX_BYTES = 256 * 1024;
const MAX_REPLIES = 256;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const queues = new Map<string, Promise<unknown>>();

// 正文属于父会话的数据目录；任务终止不删除，清空/删除父会话会一并清理。
export class ChildResultStore {
  constructor(private readonly conversationsRoot: string, private readonly now = Date.now) {}

  async save(scope: TaskScope, taskId: string, reply: string, observations?:ChildExecutionHandoff): Promise<ChildReplyStorage> {
    try {
      const directory = await this.directory(scope.conversationId);
      const previous = queues.get(directory) ?? Promise.resolve();
      const operation = previous.catch(() => undefined).then(async () => {
        this.validateId(taskId);
        this.validateId(scope.lifecycleEpoch);
        const byteLength = Buffer.byteLength(reply);
        if (byteLength > CHILD_REPLY_MAX_BYTES) return { status: "unavailable", reason: "capacity" } as const;
        let count = 0, bytes = 0;
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
          const file = path.join(directory, entry.name), stat = await lstat(file);
          if (this.now() - stat.mtimeMs > RETENTION_MS) { await rm(file); continue; }
          count++; bytes += stat.size;
        }
        const expiresAt = this.now() + RETENTION_MS, sha256 = createHash("sha256").update(reply).digest("hex");
        const facts = observations ? JSON.stringify(observations) : undefined;
        if(facts && Buffer.byteLength(facts)>64*1024)return {status:"unavailable",reason:"capacity"} as const;
        const content = JSON.stringify({ schemaVersion: 1, ...scope, taskId, expiresAt, sha256, reply, ...(facts ? { facts, factsSha256:createHash("sha256").update(facts).digest("hex") } : {}) });
        if (count >= MAX_REPLIES || bytes + Buffer.byteLength(content) > MAX_TOTAL_BYTES) return { status: "unavailable", reason: "capacity" } as const;
        const target = path.join(directory, `${taskId}.json`);
        // 同一任务的正文不可覆盖；禁止重跑或后续模型回复改写历史交付。
        try { await lstat(target); return { status: "unavailable", reason: "storage" } as const; } catch (error) { if (!isMissing(error)) throw error; }
        const temporary = path.join(directory, `.${randomUUID()}.tmp`);
        try { await writeFile(temporary, content, { flag: "wx", mode: 0o600 }); await rename(temporary, target); }
        finally { await rm(temporary, { force: true }); }
        return { status: "saved", byteLength, characters: Array.from(reply).length, sha256, expiresAt } as const;
      });
      queues.set(directory, operation);
      try { return await operation; } finally { if (queues.get(directory) === operation) queues.delete(directory); }
    } catch { return { status: "unavailable", reason: "storage" }; }
  }

  async read(scope: TaskScope, taskId: string, offset: number, limit: number, signal: AbortSignal) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 4000) throw new Error("正文分页参数无效，limit 为 1–4000 个字符。");
    const document = await this.load(scope.conversationId, taskId, signal).catch(() => { throw new Error("子回复不存在、已过期或无权读取。"); });
    if (document.lifecycleEpoch !== scope.lifecycleEpoch) throw new Error("正文不属于当前会话世代。");
    const characters = Array.from(document.reply);
    if (offset > characters.length) throw new Error("正文读取位置超过范围。");
    const nextOffset = Math.min(characters.length, offset + limit);
    return { taskId, content: characters.slice(offset, nextOffset).join(""), offset, nextOffset: nextOffset < characters.length ? nextOffset : null, totalCharacters: characters.length, hasMore: nextOffset < characters.length, source: "child-model-reply" as const };
  }

  async exportReply(conversationId: string, taskId: string) {
    return (await this.load(conversationId, taskId, new AbortController().signal)).reply;
  }

  async exportFacts(conversationId:string,taskId:string) { return (await this.load(conversationId,taskId,new AbortController().signal)).facts; }

  private async load(conversationId: string, taskId: string, signal: AbortSignal) {
    this.validateId(taskId);
    const directory = await this.directory(conversationId, false);
    const { content } = await readBounded(directory, path.join(directory, `${taskId}.json`), (CHILD_REPLY_MAX_BYTES+64*1024) * 6 + 4096, signal);
    const document: unknown = JSON.parse(content);
    if (!isDocument(document) || document.conversationId !== conversationId || document.taskId !== taskId || document.expiresAt <= this.now() || Buffer.byteLength(document.reply) > CHILD_REPLY_MAX_BYTES || createHash("sha256").update(document.reply).digest("hex") !== document.sha256) throw new Error("子回复已过期、损坏或不可用。");
    return document;
  }

  private async directory(conversationId: string, create = true) {
    this.validateId(conversationId);
    const parent = path.join(this.conversationsRoot, conversationId);
    const [root, actual, stat, rootStat] = await Promise.all([realpath(this.conversationsRoot), realpath(parent), lstat(parent), lstat(this.conversationsRoot)]);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || stat.isSymbolicLink() || !stat.isDirectory() || !within(root, actual)) throw new Error("父会话存储边界无效。");
    const directory = path.join(actual, "child-results");
    if (create) await mkdir(directory, { mode: 0o700 }).catch(error => { if (!isExists(error)) throw error; });
    const [info, resolved] = await Promise.all([lstat(directory), realpath(directory)]);
    if (!info.isDirectory() || info.isSymbolicLink() || !within(actual, resolved)) throw new Error("子回复存储边界无效。");
    return directory;
  }
  private validateId(id: string) { if (!SAFE_ID.test(id)) throw new Error("子结果身份无效。"); }
}

function isDocument(value: unknown): value is { schemaVersion: 1; conversationId: string; lifecycleEpoch: string; taskId: string; expiresAt: number; reply: string; sha256:string;facts?:string } {
  if(typeof value==="object"&&value!==null&&"facts"in value&&(typeof value.facts!=="string"||Buffer.byteLength(value.facts)>64*1024||!("factsSha256"in value)||createHash("sha256").update(value.facts).digest("hex")!==value.factsSha256))return false;
  return typeof value === "object" && value !== null && "schemaVersion" in value && value.schemaVersion === 1 && "conversationId" in value && typeof value.conversationId === "string" && "lifecycleEpoch" in value && typeof value.lifecycleEpoch === "string" && "taskId" in value && typeof value.taskId === "string" && "expiresAt" in value && typeof value.expiresAt === "number" && Number.isSafeInteger(value.expiresAt) && "reply" in value && typeof value.reply === "string" && "sha256" in value && typeof value.sha256==="string" && /^[a-f0-9]{64}$/.test(value.sha256);
}
function isMissing(error: unknown) { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
function isExists(error: unknown) { return error instanceof Error && "code" in error && error.code === "EEXIST"; }
