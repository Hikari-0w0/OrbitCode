import assert from "node:assert/strict";
import test from "node:test";

import {
  groupContextMessages,
  selectRecentContextTail,
} from "@/core/context/message-groups";
import type { ManagedContextMessage } from "@/core/context/types";

test("工具调用与全部结果形成不可拆分原子组", () => {
  const messages: ManagedContextMessage[] = [
    { kind: "user", content: "开始" },
    {
      kind: "assistant-tool-call",
      content: null,
      toolCalls: [
        { id: "a", name: "read_file", argumentsJson: "{}" },
        { id: "b", name: "read_file", argumentsJson: "{}" },
      ],
    },
    { kind: "tool-result", toolCallId: "a", payload: { storage: "inline", content: "A" } },
    { kind: "tool-result", toolCallId: "b", payload: { storage: "inline", content: "B" } },
    { kind: "assistant", content: "完成" },
  ];
  const groups = groupContextMessages(messages);
  assert.deepEqual(groups.map((group) => [group.start, group.end]), [
    [0, 1],
    [1, 4],
    [4, 5],
  ]);

  const tail = selectRecentContextTail(messages, {
    targetTokens: 1,
    minimumMessages: 4,
    estimate: (items) => items.length,
  });
  assert.equal(tail.recent[0]?.kind, "assistant-tool-call");
  assert.equal(tail.recent.length, 4);
});

test("拒绝孤立、缺失和重复的工具结果", () => {
  assert.throws(() => groupContextMessages([
    { kind: "tool-result", toolCallId: "a", payload: { storage: "inline", content: "A" } },
  ]));
  assert.throws(() => groupContextMessages([
    {
      kind: "assistant-tool-call",
      content: null,
      toolCalls: [{ id: "a", name: "read_file", argumentsJson: "{}" }],
    },
  ]));
});
