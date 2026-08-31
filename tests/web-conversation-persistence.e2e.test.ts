import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentLoop } from "@/core/agent-loop";
import { ContextManager } from "@/core/context/context-manager";
import { appendPersistedTurn } from "@/core/conversations/display-timeline";
import type { ConversationCheckpoint } from "@/core/conversations/types";
import { LocalConversationStore } from "@/lib/local-conversation-store";
import { OpenAICompatibleProvider } from "@/models/openai-provider";
import { createModeToolPolicy } from "@/tools/mode-policy";
import { readFileTool } from "@/tools/read-file";
import { ToolRegistry } from "@/tools/registry";
import { createWorkspaceBoundary } from "@/tools/workspace";
import { parseWebChatEvents, readWebStream } from "@/web/chat-contract";
import { streamAgentResponse } from "@/web/chat-handler";

import {
  startOpenAIMockServer,
  textDelta,
  TEXT_FINISH_EVENT,
  TOOL_FINISH_EVENT,
  toolCallDelta,
  TRANSPORT_DONE_EVENT,
} from "./helpers/openai-mock";

test("工具对话落盘后丢弃内存 Runtime，重建仍携带完整协议继续", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "orbitcode-persist-workspace-"));
  const conversationRoot = await mkdtemp(path.join(tmpdir(), "orbitcode-persist-store-"));
  await writeFile(path.join(workspaceRoot, "note.txt"), "持久化内容\n");
  const server = await startOpenAIMockServer(() => {
    if (server.requests.length === 1) {
      return { chunks: [{ data: toolCallDelta({
        id: "read-note",
        name: "read_file",
        argumentsJson: '{"path":"note.txt"}',
      }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT }] };
    }
    if (server.requests.length === 2) {
      return { chunks: [{ data: textDelta("已读取并保存。") + TEXT_FINISH_EVENT + TRANSPORT_DONE_EVENT }] };
    }
    return { chunks: [{ data: textDelta("可以继续开发。") + TEXT_FINISH_EVENT + TRANSPORT_DONE_EVENT }] };
  });

  try {
    const store = new LocalConversationStore(conversationRoot);
    const created = await store.create({ workspaceId: "project", providerId: "mock" });
    const first = await runTurn(created, "读取 note.txt", 1, store, workspaceRoot, server.baseUrl);
    assert.equal(first.summary.revision, 1);
    assert.equal(first.displayMessages[1]?.toolExecutions?.[0]?.result.ok, true);

    const restartedStore = new LocalConversationStore(conversationRoot);
    const restored = await restartedStore.load(created.summary.id);
    const second = await runTurn(restored, "根据刚才结果继续", 2, restartedStore, workspaceRoot, server.baseUrl);
    assert.equal(second.summary.revision, 2);
    assert.equal(second.displayMessages.at(-1)?.content, "可以继续开发。");
    assert.match(JSON.stringify(server.requests[2]?.body), /read-note/);
    assert.match(JSON.stringify(server.requests[2]?.body), /持久化内容/);
  } finally {
    await server.close();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(conversationRoot, { recursive: true, force: true });
  }
});

async function runTurn(
  checkpoint: ConversationCheckpoint,
  input: string,
  modeTurn: number,
  store: LocalConversationStore,
  workspaceRoot: string,
  baseUrl: string,
): Promise<ConversationCheckpoint> {
  const provider = new OpenAICompatibleProvider({
    model: "mock-model",
    baseUrl,
    apiKey: "test-key",
  });
  const context = new ContextManager({
    sessionId: checkpoint.summary.id,
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
    provider,
    initialState: checkpoint.context,
  });
  const workspace = await createWorkspaceBoundary(workspaceRoot);
  const registry = new ToolRegistry([readFileTool]);
  const agent = new AgentLoop(
    provider,
    (mode) => createModeToolPolicy(registry, mode),
    workspace,
    {
      maxIterations: 4,
      contextManager: context,
      promptEnvironment: {
        workspace: { id: "project", name: "Project" },
        platform: "darwin",
        currentDate: "2026-08-30",
        timeZone: "Asia/Shanghai",
        pathSemantics: "workspace-relative-posix",
      },
    },
  );
  let saved: ConversationCheckpoint | undefined;
  const response = streamAgentResponse({
    request: new Request("http://localhost/api/chat", { method: "POST" }),
    agent,
    input,
    mode: "do",
    modeTurn,
    persistTurn: async (events) => {
      const result = await store.save({
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
            lastStopReason: "final-response",
          },
          mode: "do",
          modeTurn,
          displayMessages: appendPersistedTurn({
            previous: checkpoint.displayMessages,
            userInput: input,
            events,
          }),
          context: context.persistentSnapshot(),
        },
      });
      assert.equal(result.status, "saved");
      if (result.status !== "saved") throw new Error("unexpected conflict");
      saved = result.checkpoint;
      return { status: "saved", revision: result.checkpoint.summary.revision };
    },
  });
  assert.ok(response.body);
  const events = [];
  for await (const event of parseWebChatEvents(readWebStream(response.body))) {
    events.push(event);
  }
  assert.equal(events.at(-1)?.type, "stopped");
  if (!saved) throw new Error("conversation was not saved");
  return saved;
}
