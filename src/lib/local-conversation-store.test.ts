import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  ConversationCheckpoint,
  ConversationSaveInput,
} from "@/core/conversations/types";
import { LocalConversationStore } from "@/lib/local-conversation-store";

test("本地会话跨实例恢复完整时间线和模型上下文", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-conversations-"));
  const times = [
    new Date("2026-08-30T01:00:00.000Z"),
    new Date("2026-08-30T01:00:01.000Z"),
  ];
  const store = new LocalConversationStore(root, () => times.shift() ?? new Date());
  try {
    const created = await store.create({
      workspaceId: "project",
      providerId: "deepseek",
    });
    const result = await store.save(saveInput(created, {
      displayMessages: [
        { id: "user-1", role: "user", content: "检查项目", state: "complete" },
        {
          id: "assistant-1",
          role: "assistant",
          content: "已检查",
          state: "complete",
          stopReason: "final-response",
          durationMs: 120,
        },
      ],
      context: {
        messages: [
          { kind: "user", content: "检查项目" },
          { kind: "assistant", content: "已检查" },
        ],
        consecutiveSummaryFailures: 0,
      },
    }));
    assert.equal(result.status, "saved");

    const restarted = new LocalConversationStore(root);
    const restored = await restarted.load(created.summary.id);
    assert.equal(restored.summary.revision, 1);
    assert.equal(restored.displayMessages[1]?.content, "已检查");
    assert.deepEqual(restored.context.messages, [
      { kind: "user", content: "检查项目" },
      { kind: "assistant", content: "已检查" },
    ]);
    assert.deepEqual((await restarted.list()).map((item) => item.id), [created.summary.id]);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(path.join(root, created.summary.id, "head.json"))).mode & 0o777,
      0o600,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CAS 拒绝旧修订且不覆盖较新的终态记录", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-conversations-cas-"));
  const store = new LocalConversationStore(root);
  try {
    const created = await store.create({ workspaceId: "project", providerId: "primary" });
    const first = await store.save(saveInput(created, { modeTurn: 1 }));
    assert.equal(first.status, "saved");
    const stale = await store.save(saveInput(created, { modeTurn: 2 }));
    assert.deepEqual(stale, {
      status: "conflict",
      expectedRevision: 0,
      actualRevision: 1,
    });
    assert.equal((await store.load(created.summary.id)).modeTurn, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("跨 Store 实例的写租约阻止同一会话并行运行", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-conversations-lease-"));
  const firstStore = new LocalConversationStore(root);
  try {
    const created = await firstStore.create({ workspaceId: "project", providerId: "primary" });
    const lease = await firstStore.acquireWriteLease(created.summary.id);
    const secondStore = new LocalConversationStore(root);
    await assert.rejects(
      secondStore.acquireWriteLease(created.summary.id),
      /另一个进程/,
    );
    await lease.release();
    const next = await secondStore.acquireWriteLease(created.summary.id);
    await next.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("上下文引用随稳定会话保存并在清空时清理", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-conversations-context-"));
  const store = new LocalConversationStore(root);
  try {
    const created = await store.create({ workspaceId: "project", providerId: "primary" });
    const stored = await store.write({
      sessionId: created.summary.id,
      content: "完整工具结果",
      signal: new AbortController().signal,
    });
    const restarted = new LocalConversationStore(root);
    const chunk = await restarted.read({
      sessionId: created.summary.id,
      reference: stored.reference,
      offset: 0,
      limit: 100,
      signal: new AbortController().signal,
    });
    assert.equal(chunk.content, "完整工具结果");
    const cleared = await restarted.clear({
      conversationId: created.summary.id,
      expectedRevision: 0,
    });
    assert.equal(cleared.status, "saved");
    await assert.rejects(
      restarted.read({
        sessionId: created.summary.id,
        reference: stored.reference,
        offset: 0,
        limit: 100,
        signal: new AbortController().signal,
      }),
      /上下文引用无效/,
    );
    const headSource = await readFile(
      path.join(root, created.summary.id, "head.json"),
      "utf8",
    );
    assert.equal(headSource.includes("完整工具结果"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("遗留活动标记在重启后恢复为结构化中断轮次", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-conversations-recovery-"));
  const store = new LocalConversationStore(root);
  try {
    const created = await store.create({ workspaceId: "project", providerId: "primary" });
    await store.markTurnStarted({
      conversationId: created.summary.id,
      expectedRevision: 0,
      userInput: "继续开发",
      mode: "do",
      modeTurn: 1,
    });
    const restarted = new LocalConversationStore(root);
    const recovered = await restarted.recoverInterruptedTurn(created.summary.id);
    assert.equal(recovered.summary.revision, 1);
    assert.equal(recovered.displayMessages.at(-1)?.stopReason, "agent-error");
    assert.deepEqual(recovered.context.messages.slice(-2), [
      { kind: "user", content: "继续开发" },
      {
        kind: "interruption",
        reason: "agent-error",
        detail: "上一次 Agent 运行因服务进程中断而未完成，已恢复到最近完整检查点。",
        sideEffect: "possible",
      },
    ]);
    assert.equal((await restarted.recoverInterruptedTurn(created.summary.id)).summary.revision, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("读取活动状态不修改修订，租约释放后才允许恢复", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-conversations-active-read-"));
  const first = new LocalConversationStore(root);
  try {
    const created = await first.create({ workspaceId: "project", providerId: "primary" });
    const lease = await first.acquireWriteLease(created.summary.id);
    await first.markTurnStarted({
      conversationId: created.summary.id,
      expectedRevision: 0,
      userInput: "继续开发",
      mode: "do",
      modeTurn: 1,
      ownerToken: lease.ownerToken,
    });
    const second = new LocalConversationStore(root);
    assert.deepEqual(await second.inspectActivity(created.summary.id), { status: "active" });
    assert.equal((await second.load(created.summary.id)).summary.revision, 0);
    await assert.rejects(
      second.recoverInterruptedTurn(created.summary.id),
      /另一个进程/,
    );
    await lease.release();
    assert.deepEqual(await second.inspectActivity(created.summary.id), {
      status: "interrupted",
      expectedRevision: 0,
    });
    assert.equal((await second.recoverInterruptedTurn(created.summary.id)).summary.revision, 1);
    assert.deepEqual(await second.inspectActivity(created.summary.id), { status: "idle" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("拒绝符号链接会话目录和上下文目录", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-conversations-links-"));
  const external = await mkdtemp(path.join(tmpdir(), "orbitcode-conversations-external-"));
  const store = new LocalConversationStore(root);
  try {
    await symlink(external, path.join(root, "linked-conversation"));
    await assert.rejects(store.load("linked-conversation"), /目录|会话/);

    const created = await store.create({ workspaceId: "project", providerId: "primary" });
    const contextDirectory = path.join(root, created.summary.id, "context");
    await rm(contextDirectory, { recursive: true });
    await symlink(external, contextDirectory);
    await assert.rejects(
      store.write({
        sessionId: created.summary.id,
        content: "不得越界",
        signal: new AbortController().signal,
      }),
      /目录|存储/,
    );
    assert.deepEqual(await readdir(external), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

function saveInput(
  checkpoint: ConversationCheckpoint,
  patch: Partial<Pick<ConversationCheckpoint, "modeTurn" | "displayMessages" | "context">>,
): ConversationSaveInput {
  return {
    conversationId: checkpoint.summary.id,
    expectedRevision: checkpoint.summary.revision,
    checkpoint: {
      schemaVersion: checkpoint.schemaVersion,
      summary: {
        schemaVersion: checkpoint.summary.schemaVersion,
        id: checkpoint.summary.id,
        title: checkpoint.summary.title,
        createdAt: checkpoint.summary.createdAt,
        workspaceId: checkpoint.summary.workspaceId,
        providerId: checkpoint.summary.providerId,
      },
      mode: checkpoint.mode,
      modeTurn: patch.modeTurn ?? checkpoint.modeTurn,
      displayMessages: patch.displayMessages ?? checkpoint.displayMessages,
      context: patch.context ?? checkpoint.context,
    },
  };
}
