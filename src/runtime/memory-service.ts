import { ModelUsageTracker, isModelUsageSummary } from "@/models/usage-tracker";
import path from "node:path";
import { readdir } from "node:fs/promises";
import type { ConversationCheckpoint } from "@/core/conversations/types";
import type { ResolvedProviderConfig } from "@/models/config";
import type { ChatProvider } from "@/models/provider";
import { createChatProvider } from "@/models/provider-factory";
import type { LocalConversationStore } from "@/lib/local-conversation-store";
import { atomicText, nodeError, readBounded, ensureDirectory } from "@/lib/bounded-files";
import { withFileLock } from "@/lib/local-file-lock";
import type { ConversationOperationGuard } from "@/runtime/conversation-operation-guard";
import { isRecord, parseTurnIdentity } from "@/runtime/memory-validation";
import { MemoryJobs } from "@/runtime/memory-jobs";
import { extractMemory, MemoryExtractionError } from "@/runtime/memory-extractor";
import { memoryStores } from "@/runtime/background-service";
import { contentHash, sourceKey } from "@/runtime/memory-store";
import type { MemoryJobState, SavedTurnIdentity, MemoryScope, MemorySnapshot } from "@/runtime/memory-types";
export class MemoryService {
    private readonly scheduled = new Set<string>();
    private readonly pendingStates = new Map<string, MemoryJobState>();
    private readonly sideWrites = new Set<Promise<void>>();
    readonly jobs = new MemoryJobs();
    readonly stateRoot: string;
    constructor(readonly userConfigRoot: string, private readonly conversations: LocalConversationStore, private readonly guard: ConversationOperationGuard) { this.stateRoot = path.join(userConfigRoot, "memory-state-v1"); }
    private async withStateLock<T>(action: () => Promise<T>): Promise<T> { await ensureDirectory(this.userConfigRoot, this.stateRoot); return withFileLock(this.stateRoot, "state", action); }
    private statePath(source: SavedTurnIdentity) { return path.join(this.stateRoot, "jobs", `${source.conversationId}.${contentHash(sourceKey(source))}.json`); }
    async enabled(): Promise<boolean> {
        try {
            const value: unknown = JSON.parse((await readBounded(this.userConfigRoot, path.join(this.stateRoot, "settings.json"), 1024)).content);
            if (!isRecord(value) || typeof value.enabled !== "boolean")
                throw new Error();
            return value.enabled;
        }
        catch (error) {
            if (nodeError(error, "ENOENT"))
                return true;
            throw new Error("记忆开关配置损坏。");
        }
    }
    async setEnabled(enabled: boolean) {
        if (!enabled)
            this.jobs.cancel("");
        await this.withStateLock(() => atomicText(this.userConfigRoot, path.join(this.stateRoot, "settings.json"), JSON.stringify({ enabled })));
    }
    cancelConversation(id: string) { this.jobs.cancel(`${id}:`); }
    private record(state: MemoryJobState): Promise<void> {
        const write = atomicText(this.userConfigRoot, this.statePath(state.source), JSON.stringify({...state, pid: process.pid}));
        this.sideWrites.add(write);
        void write.finally(() => this.sideWrites.delete(write)).catch(() => undefined);
        return write;
    }
    async inspect(conversationId?: string, offset = 0): Promise<readonly MemoryJobState[]> {
        let files: string[];
        try {
            files = await readdir(path.join(this.stateRoot, "jobs"));
        }
        catch (error) {
            if (nodeError(error, "ENOENT"))
                return [];
            throw error;
        }
        const result: MemoryJobState[] = [];
        // 只读取有界分页；不在打开面板时扫描所有历史来源。
        for (const file of files.filter(x => /^[a-zA-Z0-9._-]+\.[a-f0-9]{64}\.json$/.test(x) && (!conversationId || x.startsWith(`${conversationId}.`))).sort().slice(offset, offset + 100)) {
            try {
                const value: unknown = JSON.parse((await readBounded(this.userConfigRoot, path.join(this.stateRoot, "jobs", file), 4096)).content);
                if (!isRecord(value) || typeof value.status !== "string" || !["queued", "running", "saved", "skipped", "failed", "abandoned"].includes(value.status) || typeof value.detail !== "string" || !Array.isArray(value.noteIds) || !value.noteIds.every(x => typeof x === "string"))
                    continue;
                const source = parseTurnIdentity(value.source);
                let status = value.status as MemoryJobState["status"];
                if ((status === "running" || status === "queued") && typeof value.pid === "number")
                    try {
                        process.kill(value.pid, 0);
                    }
                    catch (error) {
                        if (nodeError(error, "ESRCH"))
                            status = "abandoned";
                    }
                result.push({ ...(isModelUsageSummary(value.modelUsage) ? { modelUsage: value.modelUsage } : {}), source, status, detail: status === "abandoned" ? "进程中断，后台提取已放弃。" : value.detail, noteIds: value.noteIds });
            }
            catch { }
        }
        const known = new Set(result.map(item => sourceKey(item.source)));
        for (const [key, state] of this.pendingStates)
            if (!known.has(key) && (!conversationId || state.source.conversationId === conversationId))
                result.push(state);
        return result;
    }
    scheduleSavedTurn(checkpoint: ConversationCheckpoint, workspaceRoot: string, config: ResolvedProviderConfig, provider?: ChatProvider): void {
        const turn = checkpoint.lastTurn;
        if (!turn?.memoryEligibility || !checkpoint.lifecycleEpoch)
            return;
        const source: SavedTurnIdentity = { conversationId: checkpoint.summary.id, turnId: turn.turnId, savedRevision: checkpoint.summary.revision, lifecycleEpoch: checkpoint.lifecycleEpoch };
        const key = sourceKey(source);
        if (this.scheduled.has(key))
            return;
        this.scheduled.add(key);
        if (this.scheduled.size > 256) {
            const oldest = this.scheduled.values().next().value;
            if (oldest)
                this.scheduled.delete(oldest);
        }
        this.pendingStates.set(key, { source, status: "queued", detail: "等待后台提取。", noteIds: [] });
        const run = async (signal: AbortSignal) => {
            let claimed = false;
            const modelUsage = new ModelUsageTracker();
            const record = (state: MemoryJobState) => this.record({ ...state, modelUsage: modelUsage.snapshot() });
            try {
                claimed = await this.withStateLock(async () => {
                    if (!await this.enabled())
                        return false;
                    try {
                        await readBounded(this.userConfigRoot, this.statePath(source), 4096);
                        return false;
                    }
                    catch (error) {
                        if (!nodeError(error, "ENOENT"))
                            throw error;
                    }
                    await record({ source, status: "running", detail: "正在提取候选笔记。", noteIds: [] });
                    return true;
                });
                this.pendingStates.delete(key);
                if (!claimed)
                    return;
                const existing = [];
                const beforeExtraction = new Map<MemoryScope, MemorySnapshot>();
                for (const store of Object.values(memoryStores(workspaceRoot, this.userConfigRoot)))
                    try {
                        const snapshot = await store.load();
                        beforeExtraction.set(store.scope, snapshot);
                        existing.push(...snapshot.notes);
                    }
                    catch { }
                const noRetry = { ...config, transport: { firstByteTimeoutMs: 10000, idleTimeoutMs: 10000, totalTimeoutMs: 30000, maxRetries: 0 } };
                let invalidCandidates = 0;
                const candidates = await extractMemory({ provider: modelUsage.wrap(provider ?? createChatProvider(noRetry), "memory"), checkpoint, secrets: [config.apiKey], windowTokens: config.context.windowTokens, existing, signal, onRejectedCandidates: count => { invalidCandidates = count; } });
                signal.throwIfAborted();
                if (!candidates.length) {
                    await record({source, status: "saved", detail: "没有适合长期保存的笔记。", noteIds: []});
                    return;
                }
                const operation = await this.guard.begin(source.conversationId, "memory-commit", signal);
                try {
                    await this.withStateLock(async () => {
                        signal.throwIfAborted();
                        if (!await this.enabled())
                            throw new Error("disabled");
                        const latest = await this.conversations.load(source.conversationId);
                        if (latest.lifecycleEpoch !== source.lifecycleEpoch)
                            throw new Error("source-retired");
                        const noteIds: string[] = [], rejected: string[] = invalidCandidates ? [`${invalidCandidates} 条候选未通过校验`] : [];
                        for (const store of Object.values(memoryStores(workspaceRoot, this.userConfigRoot))) {
                            const selected = candidates.filter(x => x.scope === store.scope);
                            if (!selected.length)
                                continue;
                            signal.throwIfAborted();
                            const snapshot = await store.load();
                            // 模型等待期间人工改过的正文不能因同一个 id 被自动纠正覆盖。
                            if (selected.some(candidate => candidate.replaces && (!beforeExtraction.get(store.scope)?.hashes[candidate.replaces] || beforeExtraction.get(store.scope)?.hashes[candidate.replaces] !== snapshot.hashes[candidate.replaces]))) {
                                rejected.push(`${store.scope}:correction-target-changed`);
                                continue;
                            }
                            const result = await store.commit({ expectedRevision: snapshot.revision, candidates: selected, source });
                            if (result.status === "saved")
                                noteIds.push(...result.noteIds);
                            else
                                rejected.push(`${store.scope}:${result.reason}`);
                        }
                        await record({ source, status: rejected.length ? "skipped" : "saved", detail: rejected.length ? `部分候选未收录：${rejected.join("，")}` : candidates.length ? "候选已处理。" : "没有适合长期保存的笔记。", noteIds });
                    });
                }
                finally {
                    await operation.finish();
                }
            }
            catch (error) {
                this.pendingStates.delete(key);
                if (claimed)
                    await record({ source, status: signal.aborted ? "abandoned" : "failed", detail: signal.aborted ? "后台任务已取消或超时。" : error instanceof MemoryExtractionError ? error.message : "候选写入失败；请检查作用域存储、来源及并发状态，对话已保存。", noteIds: [] }).catch(() => undefined);
            }
        };
        const accepted = this.jobs.enqueue(key, run, () => { this.pendingStates.delete(key); void this.record({ source, status: "abandoned", detail: "后台任务已取消。", noteIds: [] }).catch(() => undefined); });
        if (!accepted) {
            this.pendingStates.delete(key);
            void this.record({ source, status: "skipped", detail: "后台队列已满、已关闭或来源重复。", noteIds: [] }).catch(() => undefined);
        }
    }
    async close(): Promise<void> { this.jobs.close(); await this.jobs.idle(); while (this.sideWrites.size) await Promise.allSettled([...this.sideWrites]); }
}
