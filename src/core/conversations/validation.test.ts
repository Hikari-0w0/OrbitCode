import assert from "node:assert/strict";
import test from "node:test";

import { parseConversationCheckpoint } from "@/core/conversations/validation";

test("持久化检查点拒绝未知字段和孤立工具结果", () => {
  const checkpoint = validCheckpoint();
  assert.throws(
    () => parseConversationCheckpoint({ ...checkpoint, browserHistory: [] }),
    /损坏|版本/,
  );
  assert.throws(
    () => parseConversationCheckpoint({
      ...checkpoint,
      context: {
        messages: [{
          kind: "tool-result",
          toolCallId: "orphan",
          payload: { storage: "inline", content: "伪造结果" },
        }],
        consecutiveSummaryFailures: 0,
      },
    }),
    /损坏|版本/,
  );
});

test("持久化检查点接受严格配对的工具 transcript", () => {
  const checkpoint = validCheckpoint();
  const parsed = parseConversationCheckpoint({
    ...checkpoint,
    context: {
      messages: [
        {
          kind: "assistant-tool-call",
          content: null,
          toolCalls: [{ id: "read-1", name: "read_file", argumentsJson: "{}" }],
        },
        {
          kind: "tool-result",
          toolCallId: "read-1",
          payload: { storage: "inline", content: "结果" },
        },
      ],
      consecutiveSummaryFailures: 0,
    },
  });
  assert.equal(parsed.context.messages.length, 2);
});

function validCheckpoint() {
  return {
    schemaVersion: 1,
    summary: {
      schemaVersion: 1,
      id: "conversation-1",
      title: "会话",
      revision: 0,
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
      workspaceId: "project",
      providerId: "primary",
    },
    mode: "do",
    modeTurn: 0,
    displayMessages: [],
    context: { messages: [], consecutiveSummaryFailures: 0 },
  };
}
