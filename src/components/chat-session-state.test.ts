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
  });
  assert.equal(doCompleted.executablePlanMessageId, undefined);
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
