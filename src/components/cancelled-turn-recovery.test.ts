import assert from "node:assert/strict";
import test from "node:test";

import { waitForCancelledTurnCheckpoint } from "@/components/cancelled-turn-recovery";
import type { ConversationDetailResponse } from "@/web/chat-contract";

test("手动停止后等待活动轮次保存新 revision 再恢复输入", async () => {
  const snapshots = [
    detail(4, "active"),
    detail(4, "idle"),
    detail(5, "idle"),
  ];
  let loads = 0;
  let delays = 0;

  const checkpoint = await waitForCancelledTurnCheckpoint({
    previousRevision: 4,
    load: async () => snapshots[Math.min(loads++, snapshots.length - 1)]!,
    delay: async () => { delays += 1; },
    maxAttempts: 3,
    intervalMs: 1,
  });

  assert.equal(checkpoint.summary.revision, 5);
  assert.equal(loads, 3);
  assert.equal(delays, 2);
});

test("停止检查点未能在预算内保存时拒绝继续使用旧 revision", async () => {
  await assert.rejects(
    waitForCancelledTurnCheckpoint({
      previousRevision: 4,
      load: async () => detail(4, "idle"),
      delay: async () => undefined,
      maxAttempts: 2,
      intervalMs: 1,
    }),
    /停止结果尚未完成保存/u,
  );
});

function detail(
  revision: number,
  activity: "active" | "idle",
): ConversationDetailResponse {
  return {
    schemaVersion: 1,
    summary: {
      schemaVersion: 1,
      id: "conversation-test",
      title: "测试会话",
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
      workspaceId: "workspace-test",
      providerId: "provider-test",
      revision,
    },
    mode: "do",
    modeTurn: 1,
    displayMessages: [],
    availability: "ready",
    activity: { status: activity },
  };
}
