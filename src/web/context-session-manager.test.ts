import assert from "node:assert/strict";
import test from "node:test";

import { ContextManager } from "@/core/context/context-manager";
import type { ContextStore } from "@/core/context/types";
import type { ChatProvider } from "@/models/provider";
import {
  ContextSessionError,
  ContextSessionManager,
  type ContextSessionRuntime,
} from "@/web/context-session-manager";

test("上下文会话固定绑定并互斥 Agent 与手动压缩", () => {
  let next = 0;
  const manager = new ContextSessionManager({
    createId: () => `id-${++next}`,
    schedule: () => 1,
    cancelScheduled: () => undefined,
  });
  const binding = {
    workspace: { id: "workspace", name: "Workspace" },
    providerId: "primary",
  };
  const created = manager.createSession({
    binding,
    createRuntime: () => runtime(),
  });
  const turn = manager.beginAgentTurn(created.id, binding);
  assert.throws(() => manager.beginManualCompression(created.id), ContextSessionError);
  assert.throws(() => manager.beginAgentTurn(created.id, {
    ...binding,
    providerId: "other",
  }), ContextSessionError);
  manager.finishOperation(created.id, turn.id);
  const manual = manager.beginManualCompression(created.id);
  manager.finishOperation(created.id, manual.id);
});

test("关闭会话会取消活动操作并清理存储", async () => {
  let cleaned = false;
  const manager = new ContextSessionManager({
    createId: (() => { let value = 0; return () => `id-${++value}`; })(),
    schedule: () => 1,
    cancelScheduled: () => undefined,
  });
  const binding = {
    workspace: { id: "workspace", name: "Workspace" },
    providerId: "primary",
  };
  const created = manager.createSession({
    binding,
    createRuntime: () => runtime({
      async deleteSession() { cleaned = true; },
    }),
  });
  const operation = manager.beginAgentTurn(created.id, binding);
  await manager.closeSession(created.id);
  assert.equal(operation.signal.aborted, true);
  assert.equal(cleaned, true);
  assert.throws(() => manager.getSession(created.id), ContextSessionError);
});

test("空闲 TTL 到期后关闭会话并使引用能力失效", async () => {
  let now = 0;
  let scheduled: (() => void) | undefined;
  let cleaned = false;
  const manager = new ContextSessionManager({
    now: () => now,
    createId: (() => { let value = 0; return () => `id-${++value}`; })(),
    idleTtlMs: 100,
    schedule: (callback) => {
      scheduled = callback;
      return 1;
    },
    cancelScheduled: () => undefined,
  });
  const created = manager.createSession({
    binding: {
      workspace: { id: "workspace", name: "Workspace" },
      providerId: "primary",
    },
    createRuntime: () => runtime({
      async deleteSession() { cleaned = true; },
    }),
  });
  now = 100;
  scheduled?.();
  await Promise.resolve();
  assert.equal(cleaned, true);
  assert.throws(() => manager.getSession(created.id), ContextSessionError);
});

function runtime(storeOverrides: Partial<ContextStore> = {}): ContextSessionRuntime {
  const store: ContextStore = {
    async write() { throw new Error("unused"); },
    async read() { throw new Error("unused"); },
    async deleteReference() {},
    async deleteSession() {},
    ...storeOverrides,
  };
  return {
    provider: unusedProvider,
    context: new ContextManager({
      sessionId: "test-session",
      config: {
        windowTokens: 100_000,
        singleToolResultTokens: 8_000,
        toolResultGroupTokens: 12_000,
        recentMessagesTokens: 10_000,
        automaticReserveTokens: 13_000,
        manualReserveTokens: 3_000,
        previewChars: 2_000,
      },
      store,
      provider: unusedProvider,
    }),
    store,
  };
}

const unusedProvider: ChatProvider = {
  stream() {
    throw new Error("unused");
  },
};
