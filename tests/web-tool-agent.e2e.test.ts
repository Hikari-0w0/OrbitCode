import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentLoop } from "@/core/agent-loop";
import { OpenAICompatibleProvider } from "@/models/openai-provider";
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
    await writeFile(path.join(workspaceDirectory, "note-a.txt"), "ORBIT-A\n");
    await writeFile(path.join(workspaceDirectory, "note-b.txt"), "ORBIT-B\n");
    const server = await startOpenAIMockServer(() => {
      if (server.requests.length === 1) {
        return {
          chunks: [{
            data:
              textDelta("我先并发读取两个文件。") +
              toolCallDelta({
                index: 0,
                id: "call_a",
                name: "read_file",
                argumentsJson: '{"path":"note-a.txt"}',
              }) +
              toolCallDelta({
                index: 1,
                id: "call_b",
                name: "read_file",
                argumentsJson: '{"path":"note-b.txt"}',
              }) +
              TOOL_FINISH_EVENT +
              usageEvent({ promptTokens: 10, completionTokens: 5, totalTokens: 15 }) +
              TRANSPORT_DONE_EVENT,
          }],
        };
      }
      if (server.requests.length === 2) {
        return {
          chunks: [{
            data:
              toolCallDelta({
                id: "call_again",
                name: "read_file",
                argumentsJson: '{"path":"note-a.txt"}',
              }) +
              TOOL_FINISH_EVENT +
              usageEvent({ promptTokens: 20, completionTokens: 4, totalTokens: 24 }) +
              TRANSPORT_DONE_EVENT,
          }],
        };
      }
      return {
        chunks: [{
          data:
            textDelta("两个文件分别包含 ORBIT-A 和 ORBIT-B，复核完成。") +
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
            usageEvent({ promptTokens: 30, completionTokens: 8, totalTokens: 38 }) +
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
      const registry = new ToolRegistry([readFileTool]);
      const agent = new AgentLoop(
        provider,
        (mode) => createModeToolPolicy(registry, mode),
        workspace,
        { maxIterations: 5 },
      );
      const response = streamAgentResponse({
        request: new Request("http://localhost/api/chat", { method: "POST" }),
        agent,
        input: "读取并复核两个文件",
        mode: "do",
      });

      assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
      assert.ok(response.body);
      const events = await collect(parseWebChatEvents(readWebStream(response.body)));
      assert.equal(events.filter((event) => event.type === "tool-call").length, 3);
      assert.equal(events.filter((event) => event.type === "tool-started").length, 3);
      assert.equal(events.filter((event) => event.type === "tool-result").length, 3);
      assert.equal(events.filter((event) => event.type === "token-usage").length, 3);
      const firstResults = events.filter(
        (event) => event.type === "tool-result" && event.iteration === 1,
      );
      assert.equal(firstResults.length, 2);
      assert.match(JSON.stringify(firstResults), /ORBIT-A/);
      assert.match(JSON.stringify(firstResults), /ORBIT-B/);
      assert.deepEqual(events.at(-1), {
        type: "stopped",
        reason: "final-response",
        iterations: 3,
        sideEffect: "none",
        finalMessage: {
          role: "assistant",
          content: "两个文件分别包含 ORBIT-A 和 ORBIT-B，复核完成。",
        },
      });

      assert.equal(server.requests.length, 3);
      assert.equal(toolChoiceOf(server.requests[0]), "auto");
      assert.equal(toolChoiceOf(server.requests[1]), "auto");
      assert.equal(toolChoiceOf(server.requests[2]), "auto");
      assert.match(JSON.stringify(server.requests[1].body), /ORBIT-A/);
      assert.match(JSON.stringify(server.requests[1].body), /ORBIT-B/);
      assert.deepEqual(agent.getHistory(), [
        { role: "user", content: "读取并复核两个文件" },
        {
          role: "assistant",
          content: "两个文件分别包含 ORBIT-A 和 ORBIT-B，复核完成。",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function collect(source: AsyncIterable<WebChatEvent>): Promise<readonly WebChatEvent[]> {
  const events: WebChatEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}
