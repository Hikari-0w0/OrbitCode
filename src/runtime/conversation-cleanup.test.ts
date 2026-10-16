import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ConversationCleanup, SESSION_EXPIRY_MS } from "./conversation-cleanup";
import { ConversationService } from "./conversation-service";
import { ConversationRuntimeManager } from "./conversation-runtime-manager";
import { ConversationOperationGuard } from "./conversation-operation-guard";
import { LocalConversationStore } from "@/lib/local-conversation-store";
test("30 天预览只读，执行复检新修订并保留待保存会话", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cleanup-"));
    try {
        const date = new Date("2026-01-01T00:00:00Z"), store = new LocalConversationStore(root, () => date), manager = new ConversationRuntimeManager(), service = new ConversationService(store, manager, new ConversationOperationGuard(manager, store), async () => { throw new Error(); }), cleanup = new ConversationCleanup(service);
        const a = await store.create({ workspaceId: "w", providerId: "p" }), b = await store.create({ workspaceId: "w", providerId: "p" });
        assert.ok((await cleanup.preview(new Date(date.getTime() + SESSION_EXPIRY_MS - 1))).every(x => !x.eligible));
        const preview = await cleanup.preview(new Date(date.getTime() + SESSION_EXPIRY_MS));
        assert.ok(preview.every(x => x.eligible));
        assert.equal((await store.list()).length, 2);
        await service.rename({ conversationId: b.summary.id, expectedRevision: 0, title: "new" });
        const result = await cleanup.execute(preview.map(x => ({ id: x.summary.id, expectedRevision: x.summary.revision })), new Date(date.getTime() + SESSION_EXPIRY_MS));
        assert.equal(result.find(x => x.id === a.summary.id)?.status, "deleted");
        assert.equal(result.find(x => x.id === b.summary.id)?.status, "skipped");
        assert.equal((await store.list()).length, 1);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});


test("未来或非法更新时间无法清理，超期预览不修改存储", async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cleanup-dates-"));
    try {
        const now = new Date("2026-04-01T00:00:00Z"), store = new LocalConversationStore(root), manager = new ConversationRuntimeManager(), service = new ConversationService(store, manager, new ConversationOperationGuard(manager, store), async () => { throw new Error(); }), cleanup = new ConversationCleanup(service);
        const checkpoint = await store.create({ workspaceId: "w", providerId: "p" });
        for (const updatedAt of ["not-a-date", "2026-04-02T00:00:00Z"]) {
            context.mock.method(service, "list", async () => [{ ...checkpoint.summary, updatedAt }]);
            assert.equal((await cleanup.preview(now))[0].eligible, false);
            context.mock.restoreAll();
        }
        context.mock.method(service, "list", async () => [{ ...checkpoint.summary, updatedAt: new Date(now.getTime() - SESSION_EXPIRY_MS - 1).toISOString() }]);
        assert.equal((await cleanup.preview(now))[0].eligible, true);
        assert.equal((await store.load(checkpoint.summary.id)).summary.revision, 0);
    } finally { await rm(root, { recursive: true, force: true }); }
});
