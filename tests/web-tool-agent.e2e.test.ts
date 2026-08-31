import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentLoop } from "@/core/agent-loop";
import { OpenAICompatibleProvider } from "@/models/openai-provider";
import { editFileTool } from "@/tools/edit-file";
import { createModeToolPolicy } from "@/tools/mode-policy";
import { readFileTool } from "@/tools/read-file";
import { ToolRegistry } from "@/tools/registry";
import { createWorkspaceBoundary } from "@/tools/workspace";
import {
  parseWebChatEvents,
  readWebStream,
  type WebChatEvent,
} from "@/web/chat-contract";
import { streamAgentResponse } from "@/web/chat-handler";

import {
  startOpenAIMockServer,
  textDelta,
  TEXT_FINISH_EVENT,
  TOOL_FINISH_EVENT,
  toolCallDelta,
  TRANSPORT_DONE_EVENT,
  usageEvent,
  type MockRequest,
} from "./helpers/openai-mock";

test(
  "Web SSE 经 Provider、Agent Loop 和真实文件工具完成多迭代闭环",
  { timeout: 10_000 },
  async () => {
    const workspaceDirectory = await mkdtemp(
      path.join(tmpdir(), "orbitcode-web-agent-e2e-"),
    );
    await writeFile(path.join(workspaceDirectory, "settings.ts"), "timeoutMs = 1000\n");
    const server = await startOpenAIMockServer(() => {
      if (server.requests.length === 1) {
        return {
          chunks: [{
            data:
              textDelta("先读取最新内容。") +
              toolCallDelta({
                id: "call_read_before",
                name: "read_file",
                argumentsJson: '{"path":"settings.ts"}',
              }) +
              TOOL_FINISH_EVENT +
              usageEvent({
                promptTokens: 10,
                completionTokens: 5,
                totalTokens: 15,
                promptTokensDetails: { cached_tokens: 4 },
              }) +
              TRANSPORT_DONE_EVENT,
          }],
        };
      }
      if (server.requests.length === 2) {
        return {
          chunks: [{
            data:
              toolCallDelta({
                id: "call_edit",
                name: "edit_file",
                argumentsJson:
                  '{"path":"settings.ts","old_text":"timeoutMs = 1000","new_text":"timeoutMs = 1500"}',
              }) +
              TOOL_FINISH_EVENT +
              usageEvent({
                promptTokens: 20,
                completionTokens: 4,
                totalTokens: 24,
                promptCacheHitTokens: 10,
              }) +
              TRANSPORT_DONE_EVENT,
          }],
        };
      }
      if (server.requests.length === 3) {
        return {
          chunks: [{
            data:
              toolCallDelta({
                id: "call_read_after",
                name: "read_file",
                argumentsJson: '{"path":"settings.ts"}',
              }) +
              TOOL_FINISH_EVENT +
              usageEvent({
                promptTokens: 30,
                completionTokens: 3,
                totalTokens: 33,
                promptTokensDetails: { cached_tokens: 15 },
              }) +
              TRANSPORT_DONE_EVENT,
          }],
        };
      }
      return {
        chunks: [{
          data:
            textDelta("已将 timeoutMs 改为 1500，并读取最终文件确认。") +
            TEXT_FINISH_EVENT +
            usageEvent({
              promptTokens: 40,
              completionTokens: 8,
              totalTokens: 48,
              promptTokensDetails: { cached_tokens: 20 },
            }) +
            TRANSPORT_DONE_EVENT,
        }],
      };
    });

    try {
      const provider = new OpenAICompatibleProvider({
        model: "mock-model",
        baseUrl: server.baseUrl,
        apiKey: "test-key",
      });
      const workspace = await createWorkspaceBoundary(workspaceDirectory);
      const registry = new ToolRegistry([readFileTool, editFileTool]);
      const agent = new AgentLoop(
        provider,
        (mode) => createModeToolPolicy(registry, mode),
        workspace,
        {
          maxIterations: 5,
          promptEnvironment: {
            workspace: { id: "test", name: "Test Workspace" },
            platform: "darwin",
            currentDate: "2026-08-28",
            timeZone: "Asia/Shanghai",
            pathSemantics: "workspace-relative-posix",
          },
        },
      );
      const response = streamAgentResponse({
        request: new Request("http://localhost/api/chat", { method: "POST" }),
        agent,
        input: "把 timeoutMs 从 1000 改为 1500，并验证结果",
        mode: "do",
        modeTurn: 1,
      });

      assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
      assert.ok(response.body);
      const events = await collect(parseWebChatEvents(readWebStream(response.body)));
      assert.equal(events.filter((event) => event.type === "tool-call").length, 3);
      assert.equal(events.filter((event) => event.type === "tool-started").length, 3);
      assert.equal(events.filter((event) => event.type === "tool-result").length, 3);
      const usageEvents = events.filter((event) => event.type === "token-usage");
      assert.equal(usageEvents.length, 4);
      assert.deepEqual(usageEvents[1]?.cumulative, {
        availability: "reported",
        promptTokens: 30,
        completionTokens: 9,
        totalTokens: 39,
        promptCache: { availability: "tokens", cachedTokens: 14 },
      });
      assert.deepEqual(usageEvents[3]?.cumulative, {
        availability: "reported",
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        promptCache: { availability: "tokens", cachedTokens: 49 },
      });
      const toolResults = events.filter((event) => event.type === "tool-result");
      assert.match(JSON.stringify(toolResults[0]), /timeoutMs = 1000/);
      assert.match(JSON.stringify(toolResults[1]), /"replacements":1/);
      assert.match(JSON.stringify(toolResults[2]), /timeoutMs = 1500/);
      const finalEvent = events.at(-1);
      assert.equal(finalEvent?.type, "stopped");
      assert.ok(finalEvent?.type === "stopped" && finalEvent.durationMs >= 0);
      assert.deepEqual(finalEvent, {
        type: "stopped",
        reason: "final-response",
        iterations: 4,
        durationMs: finalEvent?.type === "stopped" ? finalEvent.durationMs : -1,
        sideEffect: "applied",
        finalMessage: {
          role: "assistant",
          content: "已将 timeoutMs 改为 1500，并读取最终文件确认。",
        },
        verification: { status: "unverified", checks: [], blockers: [] },
      });

      assert.equal(server.requests.length, 4);
      assert.ok(server.requests.every((request) => toolChoiceOf(request) === "auto"));
      const requestBodies = server.requests.map((request) => requestBody(request));
      const firstPrefix = messagesOf(requestBodies[0]).slice(0, 3);
      for (const body of requestBodies) {
        assert.deepEqual(messagesOf(body).slice(0, 3), firstPrefix);
        assert.deepEqual(body.tools, requestBodies[0].tools);
        assert.equal(JSON.stringify(body).includes("cache_control"), false);
        assert.equal(JSON.stringify(body).includes(workspaceDirectory), false);
      }
      assert.match(JSON.stringify(firstPrefix[0]), /你是 OrbitCode/u);
      assert.match(JSON.stringify(firstPrefix[1]), /^\{"role":"system","content":"<orbitcode_environment>/u);
      assert.match(JSON.stringify(firstPrefix[2]), /^\{"role":"system","content":"<orbitcode_session_instructions>/u);
      assert.match(JSON.stringify(server.requests[1].body), /timeoutMs = 1000/);
      assert.match(JSON.stringify(server.requests[3].body), /timeoutMs = 1500/);
      assert.deepEqual(agent.getHistory(), [
        { role: "user", content: "把 timeoutMs 从 1000 改为 1500，并验证结果" },
        {
          role: "assistant",
          content: "已将 timeoutMs 改为 1500，并读取最终文件确认。",
        },
      ]);
    } finally {
      await server.close();
      await rm(workspaceDirectory, { recursive: true, force: true });
    }
  },
);

function toolChoiceOf(request: MockRequest): unknown {
  if (!isRecord(request.body)) return undefined;
  return request.body.tool_choice;
}

function requestBody(request: MockRequest): Record<string, unknown> {
  assert.ok(isRecord(request.body));
  return request.body;
}

function messagesOf(body: Record<string, unknown>): readonly unknown[] {
  assert.ok(Array.isArray(body.messages));
  return body.messages;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function collect(source: AsyncIterable<WebChatEvent>): Promise<readonly WebChatEvent[]> {
  const events: WebChatEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}
