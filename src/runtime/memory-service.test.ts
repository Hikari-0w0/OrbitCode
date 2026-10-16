import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryService } from "./memory-service";
import { memoryStores } from "./background-service";
import { LocalConversationStore } from "@/lib/local-conversation-store";
import { ConversationRuntimeManager } from "./conversation-runtime-manager";
import { ConversationOperationGuard } from "./conversation-operation-guard";
import type { ResolvedProviderConfig } from "@/models/config";
import type { ChatProvider } from "@/models/provider";
const config: ResolvedProviderConfig = { name: "p", protocol: "openai", model: "test", baseUrl: "http://127.0.0.1", apiKeyEnvironmentVariable: "FAKE", apiKey: "fake-credential", context: { windowTokens: 32000, singleToolResultTokens: 8000, toolResultGroupTokens: 12000, recentMessagesTokens: 10000, automaticReserveTokens: 13000, manualReserveTokens: 3000, previewChars: 2000 } };
test("正常保存来源提取一次，关闭与清空使迟到任务失效", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jobs-"));
    try {
        const w = path.join(dir, "w"), u = path.join(dir, "u");
        await mkdir(w);
        await mkdir(u);
        const store = new LocalConversationStore(path.join(dir, "conversations")), manager = new ConversationRuntimeManager(), guard = new ConversationOperationGuard(manager, store), service = new MemoryService(u, store, guard);
        const cp = await store.create({ workspaceId: "w", providerId: "p" });
        const saved = await store.save({ conversationId: cp.summary.id, expectedRevision: 0, checkpoint: { ...cp, lastTurn: { turnId: "t", endedAt: new Date().toISOString(), stopReason: "final-response", memoryEligibility: true }, displayMessages: [{ id: "u", role: "user", content: "项目使用中文", state: "complete" }, { id: "a", role: "assistant", content: "记录", state: "complete" }] } });
        assert.ok(saved.status === "saved");
        let calls = 0;
        const provider: ChatProvider = { async *stream() { calls++; yield { type: "text-delta", text: JSON.stringify([{ category: "preference", scope: "project", title: "语言", description: "中文", body: "中文", evidence: [{ kind: "user-stated", messageId: "u" }] }]) }; yield { type: "done", finishReason: "stop" }; } };
        service.scheduleSavedTurn(saved.checkpoint, w, config, provider);
        await service.jobs.idle();
        assert.equal((await memoryStores(w, u).project.load()).notes.length, 1);
        service.scheduleSavedTurn(saved.checkpoint, w, config, provider);
        await service.jobs.idle();
        assert.equal(calls, 1);
        await service.setEnabled(false);
        const next = { ...saved.checkpoint, lastTurn: { ...saved.checkpoint.lastTurn!, turnId: "t2" } };
        service.scheduleSavedTurn(next, w, config, provider);
        await service.jobs.idle();
        assert.equal(calls, 1);
        service.close();
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});


test("虚构凭据不进入模型输入、笔记、索引或后台状态", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "memory-secret-"));
    try {
        const user = path.join(root, "user"), workspace = path.join(root, "workspace");
        await mkdir(user); await mkdir(workspace);
        const store = new LocalConversationStore(path.join(root, "conversations")), manager = new ConversationRuntimeManager(), guard = new ConversationOperationGuard(manager, store), memory = new MemoryService(user, store, guard);
        const cp = await store.create({ workspaceId: "w", providerId: "p" });
        const saved = await store.save({ conversationId: cp.summary.id, expectedRevision: 0, checkpoint: { ...cp, lastTurn: { turnId: "t", endedAt: new Date().toISOString(), stopReason: "final-response", memoryEligibility: true }, displayMessages: [{ id: "u", role: "user", content: `项目规则；api_key=${config.apiKey}`, state: "complete" }, { id: "a", role: "assistant", content: "收到", state: "complete" }] } });
        assert.ok(saved.status === "saved"); let called = false;
        const provider: ChatProvider = { async *stream(messages) { called = true; assert.ok(!JSON.stringify(messages).includes(config.apiKey)); yield { type: "text-delta", text: JSON.stringify([{ category: "preference", scope: "project", title: "规则", description: "规则", body: config.apiKey, evidence: [{ kind: "user-stated", messageId: "u" }] }]) }; yield { type: "done", finishReason: "stop" }; } };
        memory.scheduleSavedTurn(saved.checkpoint, workspace, config, provider); await memory.jobs.idle(); await memory.close(); assert.equal(called, true);
        assert.equal((await memoryStores(workspace, user).project.load()).notes.length, 0);
        async function verify(directory: string): Promise<void> { for (const item of await readdir(directory, { withFileTypes: true })) { const file = path.join(directory, item.name); if (item.isDirectory()) await verify(file); else if (item.isFile()) assert.ok(!(await readFile(file, "utf8")).includes(config.apiKey)); } }
        await verify(user); await verify(workspace);
    } finally { await rm(root, { recursive: true, force: true }); }
});

async function memoryCase(userText: string) {
    const root = await mkdtemp(path.join(os.tmpdir(), "memory-candidates-")), user = path.join(root, "user"), workspace = path.join(root, "workspace");
    await mkdir(user); await mkdir(workspace);
    const store = new LocalConversationStore(path.join(root, "conversations")), manager = new ConversationRuntimeManager(), guard = new ConversationOperationGuard(manager, store), memory = new MemoryService(user, store, guard);
    const cp = await store.create({ workspaceId: "w", providerId: "p" });
    const saved = await store.save({ conversationId: cp.summary.id, expectedRevision: 0, checkpoint: { ...cp, lastTurn: { turnId: "t", endedAt: new Date().toISOString(), stopReason: "final-response", memoryEligibility: true }, displayMessages: [{ id: "u", role: "user", content: userText, state: "complete" }, { id: "a", role: "assistant", content: "理解要求，存储待后台确认", state: "complete" }] } });
    assert.ok(saved.status === "saved");
    return { memory, checkpoint: saved.checkpoint, workspace, user, async close() { await memory.close(); await rm(root, { recursive: true, force: true }); } };
}

test("混合候选只提交有效项，并显示未收录数量", async () => {
    const fixture = await memoryCase("本项目使用中文");
    try {
        const valid = { category: "preference", scope: "project", title: "语言", description: "中文", body: "本项目使用中文", evidence: [{ kind: "user-stated", messageId: "u" }] };
        const provider: ChatProvider = { async *stream() { yield { type: "text-delta", text: JSON.stringify([valid, { ...valid, evidence: [{ kind: "user-stated", messageId: "forged" }] }]) }; yield { type: "done", finishReason: "stop" }; } };
        fixture.memory.scheduleSavedTurn(fixture.checkpoint, fixture.workspace, config, provider);
        await fixture.memory.jobs.idle();
        assert.equal((await memoryStores(fixture.workspace, fixture.user).project.load()).notes.length, 1);
        const job = (await fixture.memory.inspect())[0];
        assert.equal(job.status, "skipped"); assert.match(job.detail, /1 条候选未通过校验/); assert.equal(job.noteIds.length, 1);
    } finally { await fixture.close(); }
});

test("纠正目标在模型等待期间被人工修改时，不覆盖新正文", async () => {
    const { serializeNote } = await import("./memory-validation");
    const fixture = await memoryCase("纠正：项目规则应该是新值");
    let release: () => void = () => {};
    try {
        const target = memoryStores(fixture.workspace, fixture.user).project;
        const source = { conversationId: fixture.checkpoint.summary.id, turnId: "old", savedRevision: 1, lifecycleEpoch: fixture.checkpoint.lifecycleEpoch! };
        await target.commit({ expectedRevision: "empty", source, candidates: [{ category: "project-knowledge", scope: "project", title: "规则", description: "旧规则", body: "旧值", evidence: [{ kind: "user-stated", messageId: "u" }] }] });
        const before = await target.load(); let started: () => void = () => {};
        const ready = new Promise<void>(resolve => { started = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
        const provider: ChatProvider = { async *stream() { started(); await barrier; yield { type: "text-delta", text: JSON.stringify([{ category: "correction", scope: "project", title: "规则", description: "新规则", body: "新值，旧值已失效", replaces: before.notes[0].id, evidence: [{ kind: "user-stated", messageId: "u" }] }]) }; yield { type: "done", finishReason: "stop" }; } };
        fixture.memory.scheduleSavedTurn(fixture.checkpoint, fixture.workspace, config, provider); await ready;
        await target.update(before.revision, before.notes[0].id, serializeNote({ ...before.notes[0], body: "人工确认的最新值" }));
        release(); await fixture.memory.jobs.idle();
        assert.equal((await target.load()).notes[0].body, "人工确认的最新值");
        assert.match((await fixture.memory.inspect())[0].detail, /correction-target-changed/);
    } finally { release(); await fixture.close(); }
});
