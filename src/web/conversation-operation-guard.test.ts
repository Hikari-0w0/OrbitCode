import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalConversationStore } from "@/lib/local-conversation-store";
import { ConversationOperationGuard } from "@/web/conversation-operation-guard";
import { ConversationRuntimeManager } from "@/web/conversation-runtime-manager";

test("操作守卫统一持有运行状态和跨实例写租约", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-operation-guard-"));
  const firstStore = new LocalConversationStore(root);
  try {
    const created = await firstStore.create({ workspaceId: "project", providerId: "primary" });
    const guard = new ConversationOperationGuard(
      new ConversationRuntimeManager(),
      firstStore,
    );
    const operation = await guard.begin(created.summary.id, "agent");
    assert.deepEqual(await guard.inspect(created.summary.id), { status: "active" });
    await assert.rejects(
      new ConversationOperationGuard(
        new ConversationRuntimeManager(),
        new LocalConversationStore(root),
      ).begin(created.summary.id, "delete"),
      /另一个进程/,
    );
    await operation.finish();
    assert.deepEqual(await guard.inspect(created.summary.id), { status: "idle" });
    await operation.finish();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
