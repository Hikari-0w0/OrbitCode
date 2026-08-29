import assert from "node:assert/strict";
import test from "node:test";

import {
  DELETE as closeContextSession,
  GET as getContextSession,
} from "@/app/api/context-sessions/[sessionId]/route";
import { POST as compressContext } from "@/app/api/context-sessions/[sessionId]/compress/route";
import { ContextManager } from "@/core/context/context-manager";
import type { ContextStore } from "@/core/context/types";
import type { ChatProvider, ModelStreamEvent } from "@/models/provider";
import { contextSessionManager } from "@/web/context-session-store";

test("上下文 Route 可查看、手动压缩、拒绝并发并同源关闭", async () => {
  const binding = {
    workspace: { id: "workspace", name: "Workspace" },
    providerId: "primary",
  };
  const store = memoryStore();
  const provider = summaryProvider();
  const created = contextSessionManager.createSession({
    binding,
    createRuntime: (sessionId) => ({
      provider,
      store,
      context: new ContextManager({
        sessionId,
        provider,
        store,
        config: {
          windowTokens: 100_000,
          singleToolResultTokens: 8_000,
          toolResultGroupTokens: 12_000,
          recentMessagesTokens: 100,
          automaticReserveTokens: 13_000,
          manualReserveTokens: 3_000,
          previewChars: 100,
        },
        initialHistory: Array.from({ length: 20 }, (_, index) => index % 2 === 0
          ? { role: "user" as const, content: `用户-${index}` }
          : { role: "assistant" as const, content: `助手-${index}-${"x".repeat(1_000)}` }),
      }),
    }),
  });
  const routeContext = {
    params: Promise.resolve({ sessionId: created.id }),
  };

  const viewed = await getContextSession(
    new Request(`http://localhost/api/context-sessions/${created.id}`),
    routeContext,
  );
  assert.equal(viewed.status, 200);
  assert.deepEqual(await viewed.json(), {
    sessionId: created.id,
    provider: "primary",
    workspaceId: "workspace",
  });

  const compressed = await compressContext(
    sameOriginRequest(`${created.id}/compress`, "POST"),
    routeContext,
  );
  assert.equal(compressed.status, 200);
  assert.equal((await compressed.json() as { status: string }).status, "succeeded");

  const operation = contextSessionManager.beginAgentTurn(created.id, binding);
  const conflicting = await compressContext(
    sameOriginRequest(`${created.id}/compress`, "POST"),
    routeContext,
  );
  assert.equal(conflicting.status, 409);
  contextSessionManager.finishOperation(created.id, operation.id);

  const closed = await closeContextSession(
    sameOriginRequest(created.id, "DELETE"),
    routeContext,
  );
  assert.equal(closed.status, 204);
  const missing = await getContextSession(
    new Request(`http://localhost/api/context-sessions/${created.id}`),
    routeContext,
  );
  assert.equal(missing.status, 404);
});

function sameOriginRequest(path: string, method: string): Request {
  return new Request(`http://localhost/api/context-sessions/${path}`, {
    method,
    headers: { origin: "http://localhost" },
  });
}

function memoryStore(): ContextStore {
  return {
    async write() { throw new Error("unused"); },
    async read() { throw new Error("unused"); },
    async deleteReference() {},
    async deleteSession() {},
  };
}

function summaryProvider(): ChatProvider {
  return {
    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield {
        type: "text-delta",
        text: JSON.stringify({
          analysisDraft: "分析",
          summary: {
            taskGoals: ["目标"],
            completedWork: ["完成"],
            keyDecisions: [],
            fileChanges: [],
            toolResults: [],
            errors: [],
            nextSteps: ["继续"],
          },
        }),
      };
      yield { type: "done", finishReason: "stop" };
    },
  };
}
