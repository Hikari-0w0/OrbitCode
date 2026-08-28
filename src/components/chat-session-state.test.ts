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
  assert.deepEqual(switched.history, []);

  const cleared = chatSessionReducer(populatedState(), {
    type: "conversation-cleared",
  });
  assert.equal(cleared.selectedWorkspaceId, "alpha");
  assert.equal(cleared.selectedProvider, "primary");
  assert.equal(cleared.mode, "do");
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
  assert.equal(byControl.executablePlanMessageId, undefined);

  const byCommand = chatSessionReducer(populatedState(), {
    type: "mode-selected",
    mode: "plan",
    clearDraft: true,
  });
  assert.equal(byCommand.draft, "");
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

function populatedState(): ChatSessionState {
  return {
    ...INITIAL_CHAT_SESSION_STATE,
    selectedWorkspaceId: "alpha",
    selectedProvider: "primary",
    mode: "plan",
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
  return chatSessionReducer(state, {
    type: "request-started",
    mode,
    userId: "user-new",
    assistantId: "assistant-new",
    userMessage: { role: "user", content: "新计划" },
  });
}
