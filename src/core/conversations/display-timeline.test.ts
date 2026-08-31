import assert from "node:assert/strict";
import test from "node:test";

import type { AgentEvent } from "@/core/agent-events";
import {
  appendPersistedTurn,
  deriveConversationTitle,
} from "@/core/conversations/display-timeline";

test("默认标题取首行并保持有界", () => {
  assert.equal(deriveConversationTitle("  修复会话恢复\n第二行  "), "修复会话恢复");
  const title = deriveConversationTitle("x".repeat(100));
  assert.equal(title.length, 40);
  assert.match(title, /…$/);
});

test("终态时间线保留文字、工具结果和运行时间但丢弃流式进度", () => {
  const events: AgentEvent[] = [
    { type: "progress", iteration: 1, maxIterations: 8, phase: "model" },
    { type: "text-delta", iteration: 1, text: "先读取。" },
    {
      type: "tool-call",
      iteration: 1,
      sequence: 0,
      call: { id: "read-1", name: "read_file", argumentsJson: "{}" },
    },
    {
      type: "tool-result",
      iteration: 1,
      sequence: 0,
      callId: "read-1",
      name: "read_file",
      result: {
        ok: true,
        output: { content: "README" },
        sideEffect: "none",
        meta: { durationMs: 5, truncated: false, truncatedFields: [] },
      },
    },
    { type: "text-delta", iteration: 2, text: "完成。" },
    {
      type: "stopped",
      reason: "max-iterations",
      iterations: 2,
      durationMs: 900,
      sideEffect: "none",
      detail: "达到上限。",
    },
  ];
  const ids = ["user-1", "assistant-1"];
  const messages = appendPersistedTurn({
    previous: [],
    userInput: "检查项目",
    events,
    createId: () => ids.shift() ?? "unexpected",
  });
  assert.equal(messages[1]?.state, "failed");
  assert.equal(messages[1]?.durationMs, 900);
  assert.equal(messages[1]?.content, "先读取。完成。");
  assert.equal(messages[1]?.toolExecutions?.[0]?.result.ok, true);
  assert.equal("progress" in (messages[1] ?? {}), false);
});

test("取消时不持久化尚未返回结果的在途工具", () => {
  const messages = appendPersistedTurn({
    previous: [],
    userInput: "运行",
    events: [
      {
        type: "tool-call",
        iteration: 1,
        sequence: 0,
        call: { id: "command-1", name: "run_command", argumentsJson: "{}" },
      },
      {
        type: "stopped",
        reason: "cancelled",
        iterations: 1,
        durationMs: 50,
        sideEffect: "possible",
        detail: "已取消。",
      },
    ],
    createId: () => "id",
  });
  assert.equal(messages[1]?.state, "cancelled");
  assert.equal(messages[1]?.parts, undefined);
  assert.equal(messages[1]?.toolExecutions, undefined);
});

test("持久时间线忽略工具之间的纯空白文本", () => {
  const messages = appendPersistedTurn({
    previous: [],
    userInput: "写入文件",
    events: [
      { type: "text-delta", iteration: 1, text: "\n\n\n\n\n\n\n" },
      {
        type: "tool-call",
        iteration: 1,
        sequence: 0,
        call: { id: "write-1", name: "write_file", argumentsJson: "{}" },
      },
      {
        type: "tool-result",
        iteration: 1,
        sequence: 0,
        callId: "write-1",
        name: "write_file",
        result: {
          ok: true,
          output: { path: "a.ts" },
          sideEffect: "applied",
          meta: { durationMs: 1, truncated: false, truncatedFields: [] },
        },
      },
      {
        type: "stopped",
        reason: "max-iterations",
        iterations: 1,
        durationMs: 10,
        sideEffect: "applied",
      },
    ],
    createId: () => "id",
  });
  assert.deepEqual(messages[1]?.parts, [
    { type: "tool", iteration: 1, callId: "write-1" },
  ]);
});
