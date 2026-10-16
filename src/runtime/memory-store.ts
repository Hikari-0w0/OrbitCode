import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readBounded, atomicText, ensureDirectory, nodeError } from "@/lib/bounded-files";
import { withFileLock } from "@/lib/local-file-lock";
import { buildMemoryIndex } from "@/runtime/memory-index";
import { isRecord, parseNote, serializeNote, safeId, parseCandidate, parseTurnIdentity } from "@/runtime/memory-validation";
import type { MemoryCandidate, MemoryNote, MemoryScope, MemorySnapshot, MemoryWriteResult, SavedTurnIdentity } from "@/runtime/memory-types";
export function contentHash(content: string): string { return createHash("sha256").update(content).digest("hex"); }
export function sourceKey(source: SavedTurnIdentity): string { return `${source.conversationId}:${source.lifecycleEpoch}:${source.turnId}`; }
type Manifest = {
    revision: string;
    hashes: Record<string, string>;
    processed: string[];
    tombstones: string[];
};
type Stored = {
    snapshot: MemorySnapshot;
    manifest: Manifest;
    changed: boolean;
};
const empty = (): Stored => ({ snapshot: { revision: "empty", index: "", notes: [], hashes: {} }, manifest: { revision: "empty", hashes: {}, processed: [], tombstones: [] }, changed: false });
export class MemoryStore {
    constructor(readonly root: string, readonly scope: MemoryScope, private readonly anchor = path.dirname(root)) { }
    private async initialize() { await ensureDirectory(this.anchor, this.root); }
    private async read(): Promise<Stored> {
        let head: unknown;
        try {
            head = JSON.parse((await readBounded(this.anchor, path.join(this.root, "HEAD.json"), 1024)).content);
        }
        catch (error) {
            if (nodeError(error, "ENOENT"))
                return empty();
            throw error;
        }
        if (!isRecord(head) || !safeId(head.revision))
            throw new Error("记忆修订损坏。");
        const dir = path.join(this.root, "generations", head.revision);
        const value: unknown = JSON.parse((await readBounded(this.anchor, path.join(dir, "manifest.json"), 2000000)).content);
        if (!isRecord(value) || value.revision !== head.revision || !isRecord(value.hashes) || !Array.isArray(value.processed) || !value.processed.every(x => typeof x === "string") || !Array.isArray(value.tombstones) || !value.tombstones.every(safeId))
            throw new Error("记忆清单损坏。");
        const manifest: Manifest = { revision: head.revision, hashes: {}, processed: value.processed, tombstones: value.tombstones };
        for (const [id, hash] of Object.entries(value.hashes)) {
            if (!safeId(id) || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))
                throw new Error("记忆引用损坏。");
            manifest.hashes[id] = hash;
        }
        if (Object.keys(manifest.hashes).length > 200)
            throw new Error("笔记数量超限。");
        const index = (await readBounded(this.anchor, path.join(dir, "index.md"), 25000)).content;
        const notes: MemoryNote[] = [], hashes: Record<string, string> = {};
        let changed = false;
        for (const [id, hash] of Object.entries(manifest.hashes)) {
            try {
                const text = (await readBounded(this.anchor, path.join(dir, "notes", `${id}.md`), 16000)).content;
                const note = parseNote(text);
                if (note.id !== id || note.scope !== this.scope)
                    throw new Error("笔记标识或作用域不一致。");
                hashes[id] = contentHash(text);
                if (hashes[id] !== hash)
                    changed = true;
                notes.push(note);
            }
            catch (error) {
                if (nodeError(error, "ENOENT")) {
                    manifest.tombstones.push(id);
                    changed = true;
                }
                else
                    throw error;
            }
        }
        // 索引只能由服务重建；手写引用不获得文件读取权。
        if (!changed && buildMemoryIndex(notes) !== index)
            throw new Error("记忆索引与正文不一致。");
        return { snapshot: { revision: head.revision, index: buildMemoryIndex(notes), notes, hashes }, manifest, changed };
    }
    async load(): Promise<MemorySnapshot> {
        try {
            const stored = await this.read();
            if (!stored.changed)
                return stored.snapshot;
        }
        catch (error) {
            if (nodeError(error, "ENOENT"))
                return empty().snapshot;
            throw error;
        }
        await this.initialize();
        return withFileLock(this.root, "write", async () => { const latest = await this.read(); if (!latest.changed)
            return latest.snapshot; return this.publish(latest, latest.snapshot.notes, latest.manifest); });
    }
    private async publish(previous: Stored, notes: readonly MemoryNote[], manifest: Manifest): Promise<MemorySnapshot> {
        const index = buildMemoryIndex(notes), revision = randomUUID(), dir = path.join(this.root, "generations", revision), hashes: Record<string, string> = {};
        for (const note of notes) {
            const text = serializeNote(note);
            if (Buffer.byteLength(text) > 16000)
                throw new Error("笔记容量不足。");
            await atomicText(this.anchor, path.join(dir, "notes", `${note.id}.md`), text);
            hashes[note.id] = contentHash(text);
        }
        await atomicText(this.anchor, path.join(dir, "index.md"), index);
        await atomicText(this.anchor, path.join(dir, "manifest.json"), JSON.stringify({ ...manifest, revision, hashes }));
        const current = await this.read();
        if (current.snapshot.revision !== previous.snapshot.revision || JSON.stringify(current.snapshot.hashes) !== JSON.stringify(previous.snapshot.hashes) || current.snapshot.notes.length !== previous.snapshot.notes.length)
            throw new Error("人工修改与记忆提交冲突，原内容已保留。");
        await atomicText(this.anchor, path.join(this.root, "HEAD.json"), JSON.stringify({ revision }));
        return { revision, index, notes, hashes };
    }
    async commit(input: {
        expectedRevision: string;
        candidates: readonly MemoryCandidate[];
        source: SavedTurnIdentity;
    }): Promise<MemoryWriteResult> {
        parseTurnIdentity(input.source);
        if (input.candidates.length > 8)
            return { status: "rejected", reason: "invalid" };
        await this.initialize();
        return withFileLock(this.root, "write", async () => {
            const stored = await this.read();
            if (stored.changed || stored.snapshot.revision !== input.expectedRevision)
                return { status: "rejected", reason: "conflict" };
            if (stored.manifest.processed.includes(sourceKey(input.source)))
                return { status: "saved", revision: stored.snapshot.revision, noteIds: [] };
            const notes = [...stored.snapshot.notes], ids: string[] = [];
            for (const raw of input.candidates) {
                const candidate = parseCandidate(raw);
                if (candidate.scope !== this.scope)
                    return { status: "rejected", reason: "invalid" };
                const same = notes.find(n => n.category === candidate.category && n.body.trim() === candidate.body.trim());
                if (same)
                    continue;
                if (!candidate.replaces && notes.some(n => n.category === candidate.category && n.title.trim() === candidate.title.trim() && n.body.trim() !== candidate.body.trim()))
                    return { status: "rejected", reason: "conflict" };
                const old = candidate.replaces ? notes.find(n => n.id === candidate.replaces) : undefined;
                if (candidate.replaces && !old)
                    return { status: "rejected", reason: "conflict" };
                const now = new Date().toISOString(), id = old?.id ?? randomUUID();
                if (stored.manifest.tombstones.includes(id))
                    return { status: "rejected", reason: "conflict" };
                const note: MemoryNote = { ...candidate, id, createdAt: old?.createdAt ?? now, updatedAt: now, sources: [...(old?.sources ?? []), input.source] };
                if (old) {
                    notes.splice(notes.indexOf(old), 1, note);
                }
                else
                    notes.push(note);
                ids.push(id);
            }
            try {
                buildMemoryIndex(notes);
                for (const note of notes)
                    parseNote(serializeNote(note));
            }
            catch {
                return { status: "rejected", reason: "capacity" };
            }
            const manifest = { ...stored.manifest, processed: [...stored.manifest.processed, sourceKey(input.source)] };
            const result = await this.publish(stored, notes, manifest);
            return { status: "saved", revision: result.revision, noteIds: ids };
        });
    }
    async hasProcessed(source: SavedTurnIdentity): Promise<boolean> { return (await this.read()).manifest.processed.includes(sourceKey(source)); }
    async update(expectedRevision: string, id: string, markdown: string | null): Promise<MemorySnapshot> {
        if (!safeId(id))
            throw new Error("笔记标识无效。");
        await this.initialize();
        return withFileLock(this.root, "write", async () => {
            const stored = await this.read();
            if (stored.changed || stored.snapshot.revision !== expectedRevision)
                throw new Error("笔记已更新，请重新加载。");
            const old = stored.snapshot.notes.find(n => n.id === id);
            if (!old)
                throw new Error("笔记不存在。");
            const notes = stored.snapshot.notes.filter(n => n.id !== id);
            if (markdown !== null) {
                const note = parseNote(markdown);
                if (note.id !== id || note.scope !== this.scope || JSON.stringify(note.sources) !== JSON.stringify(old.sources))
                    throw new Error("人工更新不能改变笔记标识、作用域或来源。");
                notes.push({ ...note, updatedAt: new Date().toISOString() });
            }
            const manifest = { ...stored.manifest, tombstones: markdown === null ? [...stored.manifest.tombstones, id] : stored.manifest.tombstones };
            return this.publish(stored, notes, manifest);
        });
    }
}
