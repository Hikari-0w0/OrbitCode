import assert from "node:assert/strict";
import test from "node:test";

import {
  chatSessionReducer,
  INITIAL_CHAT_SESSION_STATE,
  type ChatSessionState,
} from "@/components/chat-session-state";

test("Workspace 真实切换清空会话并恢复 Do，重选当前项不重置", () => {
  const initial = populatedState();
  assert.equal(
    chatSessionReducer(initial, {
      type: "workspace-selected",
      workspaceId: "alpha",
    }),
    initial,
  );

  const next = chatSessionReducer(initial, {
    type: "workspace-selected",
    workspaceId: "beta",
  });
  assert.equal(next.selectedWorkspaceId, "beta");
  assert.equal(next.selectedProvider, "primary");
  assert.equal(next.mode, "do");
  assert.equal(next.modeTurn, 0);
  assert.deepEqual(next.messages, []);
  assert.deepEqual(next.history, []);
  assert.equal(next.draft, "");
  assert.equal(next.executablePlanMessageId, undefined);
});

test("加载持久化会话恢复绑定、终态工具时间线和 revision", () => {
  const restored = chatSessionReducer(INITIAL_CHAT_SESSION_STATE, {
    type: "conversation-loaded",
    conversationId: "conversation-1",
    revision: 4,
    workspaceId: "project",
    provider: "deepseek",
    mode: "do",
    modeTurn: 2,
    availability: "ready",
    messages: [
      { id: "user-1", role: "user", content: "检查", state: "complete" },
      {
        id: "assistant-1",
        role: "assistant",
        content: "完成",
        state: "complete",
        durationMs: 80,
      },
    ],
  });
  assert.equal(restored.conversationId, "conversation-1");
  assert.equal(restored.revision, 4);
  assert.equal(restored.messages[1]?.durationMs, 80);
  assert.deepEqual(restored.history.map((item) => item.content), ["检查", "完成"]);
});

test("Provider 切换和清空会话保留 Workspace", () => {
  const switched = chatSessionReducer(populatedState(), {
    type: "provider-selected",
    provider: "secondary",
  });
  assert.equal(switched.selectedWorkspaceId, "alpha");
  assert.equal(switched.selectedProvider, "secondary");
  assert.equal(switched.mode, "do");
  assert.equal(switched.modeTurn, 0);
  assert.deepEqual(switched.history, []);

  const cleared = chatSessionReducer(populatedState(), {
    type: "conversation-cleared",
  });
  assert.equal(cleared.selectedWorkspaceId, "alpha");
  assert.equal(cleared.selectedProvider, "primary");
  assert.equal(cleared.mode, "do");
  assert.equal(cleared.modeTurn, 0);
});

test("模式切换使 Plan 候选失效，重选当前模式保持幂等", () => {
  const initial = populatedState();
  assert.equal(chatSessionReducer(initial, {
    type: "mode-selected",
    mode: "plan",
  }), initial);

  const byControl = chatSessionReducer(initial, {
    type: "mode-selected",
    mode: "do",
  });
  assert.equal(byControl.draft, "草稿");
  assert.equal(byControl.modeTurn, 0);
  assert.equal(byControl.executablePlanMessageId, undefined);

  const byCommand = chatSessionReducer(populatedState(), {
    type: "mode-selected",
    mode: "plan",
    clearDraft: true,
  });
  assert.equal(byCommand.draft, "");
  assert.equal(byCommand.modeTurn, initial.modeTurn);
});

test("仅成功 Plan 回复成为最新可执行候选", () => {
  const started = startRequest({ ...populatedState(), requestState: "idle" }, "plan");
  assert.equal(started.executablePlanMessageId, undefined);
  const completed = chatSessionReducer(started, {
    type: "request-completed",
    assistantId: "assistant-new",
    userMessage: { role: "user", content: "新计划" },
    finalMessage: { role: "assistant", content: "计划内容" },
    mode: "plan",
    durationMs: 1_200,
  });
  assert.equal(completed.executablePlanMessageId, "assistant-new");
  assert.equal(completed.history.at(-1)?.content, "计划内容");

  const doCompleted = chatSessionReducer(startRequest({
    ...completed,
    requestState: "idle",
  }, "do"), {
    type: "request-completed",
    assistantId: "assistant-new",
    userMessage: { role: "user", content: "执行" },
    finalMessage: { role: "assistant", content: "完成" },
    mode: "do",
    durationMs: 800,
  });
  assert.equal(doCompleted.executablePlanMessageId, undefined);
});

test("模型文字与工具调用按事件顺序保留，完成时不覆盖中间文字", () => {
  let state = startRequest({ ...populatedState(), requestState: "idle" }, "do");
  state = chatSessionReducer(state, {
    type: "text-delta",
    assistantId: "assistant-new",
    iteration: 1,
    text: "先读取。",
  });
  state = chatSessionReducer(state, {
    type: "tool-call",
    assistantId: "assistant-new",
    event: {
      type: "tool-call",
      iteration: 1,
      sequence: 0,
      call: { id: "read-1", name: "read_file", argumentsJson: "{}" },
    },
  });
  state = chatSessionReducer(state, {
    type: "text-delta",
    assistantId: "assistant-new",
    iteration: 2,
    text: "读取完成。",
  });
  state = chatSessionReducer(state, {
    type: "request-completed",
    assistantId: "assistant-new",
    userMessage: { role: "user", content: "新计划" },
    finalMessage: { role: "assistant", content: "读取完成。" },
    mode: "do",
    durationMs: 1_500,
  });

  const message = state.messages.find((item) => item.id === "assistant-new");
  assert.equal(message?.content, "先读取。读取完成。");
  assert.deepEqual(message?.parts, [
    { type: "text", iteration: 1, content: "先读取。" },
    { type: "tool", iteration: 1, callId: "read-1" },
    { type: "text", iteration: 2, content: "读取完成。" },
  ]);
});

test("失败、取消和非最终停止不污染历史或 Plan 候选", () => {
  const started = startRequest({ ...populatedState(), requestState: "idle" }, "plan");
  const stopped = chatSessionReducer(started, {
    type: "request-stopped",
    assistantId: "assistant-new",
    event: {
      type: "stopped",
      reason: "max-iterations",
      iterations: 8,
      durationMs: 8_000,
      sideEffect: "none",
      detail: "已到上限",
    },
  });
  assert.equal(stopped.executablePlanMessageId, undefined);
  assert.deepEqual(stopped.history, populatedState().history);

  const cancelled = chatSessionReducer(started, {
    type: "request-transport-failed",
    assistantId: "assistant-new",
    detail: "已停止",
    cancelled: true,
  });
  assert.equal(cancelled.executablePlanMessageId, undefined);
  assert.equal(cancelled.notice, undefined);
});

test("中断后保留已展示的文字和工具顺序并收敛未完成工具", () => {
  let state = startRequest({ ...populatedState(), requestState: "idle" }, "do");
  state = chatSessionReducer(state, {
    type: "text-delta",
    assistantId: "assistant-new",
    iteration: 1,
    text: "正在检查。",
  });
  state = chatSessionReducer(state, {
    type: "tool-call",
    assistantId: "assistant-new",
    event: {
      type: "tool-call",
      iteration: 1,
      sequence: 0,
      call: { id: "read-running", name: "read_file", argumentsJson: "{}" },
    },
  });
  state = chatSessionReducer(state, {
    type: "tool-started",
    assistantId: "assistant-new",
    event: {
      type: "tool-started",
      iteration: 1,
      sequence: 0,
      callId: "read-running",
      name: "read_file",
    },
  });
  state = chatSessionReducer(state, {
    type: "request-stopped",
    assistantId: "assistant-new",
    event: {
      type: "stopped",
      reason: "cancelled",
      iterations: 1,
      durationMs: 900,
      sideEffect: "none",
      detail: "Agent 轮次已取消。",
    },
  });

  const message = state.messages.find((item) => item.id === "assistant-new");
  assert.equal(message?.content, "正在检查。");
  assert.deepEqual(message?.parts, [
    { type: "text", iteration: 1, content: "正在检查。" },
    { type: "tool", iteration: 1, callId: "read-running" },
  ]);
  assert.equal(message?.toolExecutions?.[0]?.state, "cancelled");
  assert.equal(message?.state, "cancelled");
  assert.equal(message?.stopReason, "cancelled");
});

test("请求期间拒绝 Workspace、Provider、Mode 和清空转换", () => {
  const streaming = startRequest({ ...populatedState(), requestState: "idle" }, "plan");
  for (const action of [
    { type: "workspace-selected", workspaceId: "beta" },
    { type: "provider-selected", provider: "secondary" },
    { type: "mode-selected", mode: "do" },
    { type: "conversation-cleared" },
  ] as const) {
    assert.equal(chatSessionReducer(streaming, action), streaming);
  }
  const stopping = chatSessionReducer(streaming, { type: "request-stopping" });
  assert.equal(stopping.requestState, "stopping");
  assert.equal(
    chatSessionReducer(stopping, { type: "request-settled" }).requestState,
    "idle",
  );
});

test("授权请求、提交失败与服务端终态只更新对应工具卡", () => {
  let state = startRequest({ ...populatedState(), requestState: "idle" }, "do");
  state = chatSessionReducer(state, {
    type: "tool-call",
    assistantId: "assistant-new",
    event: {
      type: "tool-call",
      iteration: 1,
      sequence: 0,
      call: { id: "call-1", name: "write_file", argumentsJson: "{}" },
    },
  });
  state = chatSessionReducer(state, {
    type: "permission-requested",
    assistantId: "assistant-new",
    event: {
      type: "permission-requested",
      iteration: 1,
      sequence: 0,
      callId: "call-1",
      name: "write_file",
      prompt: {
        requestId: "request-1",
        toolCallId: "call-1",
        toolName: "write_file",
        workspace: { id: "alpha", name: "Alpha" },
        summary: { operation: "写入", path: "src/main.ts" },
        risk: { level: "medium", message: "写入需要确认。" },
        source: "mode",
        persistentLayer: "local",
        expiresAt: "2026-08-29T00:00:00.000Z",
      },
    },
  });
  assert.equal(tool(state)?.state, "awaiting-approval");
  assert.equal(tool(state)?.permission?.state, "awaiting");

  state = chatSessionReducer(state, {
    type: "permission-submitting",
    requestId: "request-1",
  });
  assert.equal(tool(state)?.permission?.state, "submitting");
  state = chatSessionReducer(state, {
    type: "permission-submit-failed",
    requestId: "request-1",
    error: "网络失败",
  });
  assert.equal(tool(state)?.permission?.state, "awaiting");
  assert.equal(tool(state)?.permission?.error, "网络失败");

  state = chatSessionReducer(state, {
    type: "permission-resolved",
    assistantId: "assistant-new",
    event: {
      type: "permission-resolved",
      iteration: 1,
      sequence: 0,
      callId: "call-1",
      name: "write_file",
      requestId: "request-1",
      status: "allowed",
      scope: "session",
    },
  });
  assert.equal(tool(state)?.state, "queued");
  assert.equal(tool(state)?.permission?.state, "allowed");
  assert.equal(tool(state)?.permission?.scope, "session");
});

test("等待授权时强制切换上下文会立即清空会话", () => {
  const streaming = startRequest({ ...populatedState(), requestState: "idle" }, "do");
  const reset = chatSessionReducer(streaming, {
    type: "context-reset",
    workspaceId: "beta",
  });
  assert.equal(reset.requestState, "idle");
  assert.equal(reset.selectedWorkspaceId, "beta");
  assert.deepEqual(reset.messages, []);
  assert.deepEqual(reset.history, []);
});

function populatedState(): ChatSessionState {
  return {
    ...INITIAL_CHAT_SESSION_STATE,
    selectedWorkspaceId: "alpha",
    selectedProvider: "primary",
    mode: "plan",
    modeTurn: 3,
    messages: [
      { id: "assistant-old", role: "assistant", content: "旧计划", state: "complete" },
    ],
    history: [
      { role: "user", content: "需求" },
      { role: "assistant", content: "旧计划" },
    ],
    draft: "草稿",
    executablePlanMessageId: "assistant-old",
  };
}

function startRequest(state: ChatSessionState, mode: "plan" | "do") {
  const modeTurn = state.mode === mode ? state.modeTurn + 1 : 1;
  return chatSessionReducer(state, {
    type: "request-started",
    mode,
    modeTurn,
    userId: "user-new",
    assistantId: "assistant-new",
    userMessage: { role: "user", content: "新计划" },
  });
}

function tool(state: ChatSessionState) {
  return state.messages
    .find((message) => message.id === "assistant-new")
    ?.toolExecutions?.[0];
}
