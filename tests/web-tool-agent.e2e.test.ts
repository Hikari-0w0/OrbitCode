import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SingleToolAgent } from "@/core/single-tool-agent";
import { OpenAICompatibleProvider } from "@/models/openai-provider";
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
  type MockRequest,
} from "./helpers/openai-mock";

test(
  "Web SSE 经 Provider、Agent 和真实文件工具完成单次工具闭环",
  { timeout: 10_000 },
  async () => {
    const workspaceDirectory = await mkdtemp(
      path.join(tmpdir(), "orbitcode-web-tool-e2e-"),
    );
    await writeFile(path.join(workspaceDirectory, "note.txt"), "ORBIT-CONTENT\n");
    const server = await startOpenAIMockServer(() => {
      if (server.requests.length === 1) {
        return {
          chunks: [
            {
              data:
                textDelta("我先读取文件。") +
                toolCallDelta({ id: "call_read", name: "read_" }),
            },
            { data: toolCallDelta({ name: "file", argumentsJson: '{"path":' }) },
            { data: toolCallDelta({ argumentsJson: '"note.txt"}' }) },
            { data: TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT },
          ],
        };
      }
      return {
        chunks: [
          { data: textDelta("文件内容是 ORBIT-CONTENT。") },
          { data: 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' },
          { data: TRANSPORT_DONE_EVENT },
        ],
      };
    });

    try {
      const provider = new OpenAICompatibleProvider({
        model: "mock-model",
        baseUrl: server.baseUrl,
        apiKey: "test-key",
      });
      const workspace = await createWorkspaceBoundary(workspaceDirectory);
      const agent = new SingleToolAgent(
        provider,
        new ToolRegistry([readFileTool]),
        workspace,
      );
      const response = streamAgentResponse({
        request: new Request("http://localhost/api/chat", { method: "POST" }),
        agent,
        input: "读取 note.txt",
      });

      assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
      assert.ok(response.body);
      const events = await collect(parseWebChatEvents(readWebStream(response.body)));
      assert.deepEqual(events.map((event) => event.type), [
        "text-delta",
        "tool-started",
        "tool-completed",
        "text-delta",
        "completed",
      ]);
      const toolEvent = events[2];
      assert.equal(toolEvent?.type, "tool-completed");
      if (toolEvent?.type !== "tool-completed") return;
      assert.equal(toolEvent.name, "read_file");
      assert.equal(toolEvent.result.ok, true);
      assert.match(JSON.stringify(toolEvent.result), /ORBIT-CONTENT/);
      assert.deepEqual(events.at(-1), {
        type: "completed",
        content: "文件内容是 ORBIT-CONTENT。",
      });

      assert.equal(server.requests.length, 2);
      assert.equal(toolChoiceOf(server.requests[0]), "auto");
      assert.equal(toolChoiceOf(server.requests[1]), "none");
      assert.match(JSON.stringify(server.requests[1].body), /ORBIT-CONTENT/);
      assert.deepEqual(agent.getHistory(), [
        { role: "user", content: "读取 note.txt" },
        { role: "assistant", content: "文件内容是 ORBIT-CONTENT。" },
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
