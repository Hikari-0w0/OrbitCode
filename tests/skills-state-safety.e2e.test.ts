import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import type { ConversationSaveInput } from "@/core/conversations/types";
import { LocalConversationStore } from "@/lib/local-conversation-store";
import { LocalConversationExporter } from "@/lib/local-conversation-exporter";
import { runtimeFixture, waitUntil } from "./helpers/runtime-fixture";
import { writeSkill, say, call, type SkillFixture } from "./helpers/skill-fixture";
import { record } from "@/runtime/skills/definition";

class FailOnceSkillStore extends LocalConversationStore {
    failed = false;
    override async save(input: ConversationSaveInput) {
        if (!this.failed && input.checkpoint.skills?.active.length && input.checkpoint.displayMessages.length) {
            this.failed = true;
            throw new Error("注入保存失败");
        }
        return super.save(input);
    }
}
async function nextTurn(fixture: SkillFixture) {
    const checkpoint = await fixture.checkpoint();
    const permissions = fixture.permissions.createSession();
    try {
        const events = [];
        for await (const event of fixture.runtime.streamTurn({ conversationId: checkpoint.summary.id, expectedRevision: checkpoint.summary.revision, permissionSessionId: permissions.id, input: "清空后继续", mode: "do", modeTurn: 1, source: "web", signal: new AbortController().signal })) events.push(event);
        return events;
    } finally { fixture.permissions.closeSession(permissions.id); }
}

test("保存失败后清空会话同时丢弃旧待保存 Skill，后续运行不被旧状态阻塞", async () => {
    const fixture = await runtimeFixture(() => say("正常回复"), { storeFactory: root => new FailOnceSkillStore(root) });
    try {
        await writeSkill(fixture, "persistent", { tools: [] });
        const original = await fixture.checkpoint();
        await fixture.controller.handleLine("/skill run persistent");
        assert.ok(fixture.manager.pendingSave(original.summary.id));
        const cleared = await fixture.conversations.clear({ conversationId: original.summary.id, expectedRevision: 0 });
        assert.equal(cleared.skills, undefined);
        assert.notEqual(cleared.lifecycleEpoch, original.lifecycleEpoch);
        assert.equal(fixture.manager.pendingSave(original.summary.id), undefined);
        assert.equal((await fixture.guard.inspect(original.summary.id)).status, "idle");
        const events = await nextTurn(fixture);
        assert.ok(events.some(event => event.type === "finished" && event.persistence.status === "saved"));
        assert.equal((await fixture.checkpoint()).skills?.active.length ?? 0, 0);
    } finally { await fixture.close(); }
});

test("Skill 保存失败后仅重试保存，不重放已经应用的写入", async () => {
    let requests = 0;
    const fixture = await runtimeFixture(() => ++requests === 1 ? call("write_file", { path: "once.txt", content: "first" }) : say("已写入"), { storeFactory: root => new FailOnceSkillStore(root) });
    try {
        await writeSkill(fixture, "writer", { tools: ["write_file"] });

        await fixture.controller.handleLine("/skill run writer");
        assert.equal(await readFile(path.join(fixture.root, "once.txt"), "utf8"), "first");
        const before = await fixture.checkpoint(), pending = fixture.manager.pendingSave(before.summary.id);
        assert.ok(pending?.checkpoint.skills?.active.length);
        const count = fixture.server.requests.length;
        const saved = await fixture.conversations.retrySave({ conversationId: before.summary.id, expectedRevision: before.summary.revision });
        assert.equal(saved.skills?.active.length, 1);
        assert.equal(fixture.server.requests.length, count);
        assert.equal(fixture.manager.pendingSave(before.summary.id), undefined);
        assert.equal((await fixture.guard.inspect(before.summary.id)).status, "idle");
    } finally { await fixture.close(); }
});

test("源文件删除不抹去持久化激活；导出和停用仍保持正确历史", async () => {
    const fixture = await runtimeFixture(() => say("继续"));
    try {
        const root = await writeSkill(fixture, "snapshot", { tools: [], body: "SAVED_INSTRUCTION_681 {{arguments}}" });
        await fixture.controller.handleLine("/skill run snapshot 参数");
        await rm(root, { recursive: true });
        await fixture.controller.handleLine("继续");
        assert.match(JSON.stringify(fixture.server.requests.at(-1)?.body), /SAVED_INSTRUCTION_681 参数/);
        const before = await fixture.checkpoint();
        await fixture.runtime.deactivateSkill({ conversationId: before.summary.id, expectedRevision: before.summary.revision, name: "snapshot" });
        const exported = await new LocalConversationExporter(fixture.log, fixture.store).createExport(before.summary.id);
        assert.equal(exported.revisions.at(-1)?.skills?.active.length, 0);
        assert.ok(exported.revisions.some(revision => revision.skills?.active.some(skill => skill.instructions.includes("SAVED_INSTRUCTION_681"))));
    } finally { await fixture.close(); }
});

test("两个页面同时停用同一 Skill，只有一个修订写入成功", async () => {
    const fixture = await runtimeFixture(() => say("完成"));
    try {
        await writeSkill(fixture, "snapshot", { tools: [] });
        await fixture.controller.handleLine("/skill run snapshot");
        const before = await fixture.checkpoint();
        const mutation = { conversationId: before.summary.id, expectedRevision: before.summary.revision, name: "snapshot" };
        const results = await Promise.allSettled([fixture.runtime.deactivateSkill(mutation), fixture.runtime.deactivateSkill(mutation)]);
        assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
        assert.equal(results.filter(result => result.status === "rejected").length, 1);
        const after = await fixture.checkpoint();
        assert.equal(after.summary.revision, before.summary.revision + 1);
        assert.equal(after.skills?.active.length, 0);
    } finally { await fixture.close(); }
});

test("独立模型等待中清空被拒绝，取消并清空后迟到响应不得复活 Skill 或消息", async () => {
    let release = () => { };
    let returned = false;
    const fixture = await runtimeFixture(async () => { await new Promise<void>(resolve => { release = resolve; }); returned = true; return say("LATE_CHILD_RESULT_733"); }, { terminal: true });
    try {
        await writeSkill(fixture, "worker", { mode: "isolated", tools: [] });
        const before = await fixture.checkpoint();
        const running = fixture.controller.handleLine("/skill run worker");
        await waitUntil(() => fixture.server.requests.length === 1);
        await assert.rejects(fixture.conversations.clear({ conversationId: before.summary.id, expectedRevision: before.summary.revision }), /进行中的操作/);
        fixture.controller.cancel();
        await running;
        const stopped = await fixture.checkpoint();
        const cleared = await fixture.conversations.clear({ conversationId: stopped.summary.id, expectedRevision: stopped.summary.revision });
        release();
        await waitUntil(() => returned);
        const after = await fixture.checkpoint();
        assert.equal(after.summary.revision, cleared.summary.revision);
        assert.equal(after.lifecycleEpoch, cleared.lifecycleEpoch);
        assert.equal(after.skills, undefined);
        assert.deepEqual(after.displayMessages, []);
        assert.deepEqual(after.context.messages, []);
        const lastRequest = fixture.server.requests.at(-1)?.body;
        assert.ok(record(lastRequest));
    } finally { release(); await fixture.close(); }
});

test("清空修订号冲突时不能丢弃尚未保存的 Skill 结果", async () => {
    const fixture = await runtimeFixture(() => say("完成"), { storeFactory: root => new FailOnceSkillStore(root) });
    try {
        await writeSkill(fixture, "snapshot", { tools: [] });
        await fixture.controller.handleLine("/skill run snapshot");
        const before = await fixture.checkpoint(), pending = fixture.manager.pendingSave(before.summary.id);
        assert.ok(pending);
        await assert.rejects(fixture.conversations.clear({ conversationId: before.summary.id, expectedRevision: before.summary.revision + 1 }), /已更新/);
        assert.equal(fixture.manager.pendingSave(before.summary.id), pending);
        const saved = await fixture.conversations.retrySave({ conversationId: before.summary.id, expectedRevision: before.summary.revision });
        assert.equal(saved.skills?.active.length, 1);
    } finally { await fixture.close(); }
});

test("删除保存失败的会话时清理进程内待保存结果", async () => {
    const fixture = await runtimeFixture(() => say("完成"), { storeFactory: root => new FailOnceSkillStore(root) });
    try {
        await writeSkill(fixture, "snapshot", { tools: [] });
        await fixture.controller.handleLine("/skill run snapshot");
        const before = await fixture.checkpoint();
        assert.ok(fixture.manager.pendingSave(before.summary.id));
        await fixture.conversations.delete({ conversationId: before.summary.id, expectedRevision: before.summary.revision });
        assert.equal(fixture.manager.pendingSave(before.summary.id), undefined);
        await assert.rejects(fixture.store.load(before.summary.id));
    } finally { await fixture.close(); }
});
