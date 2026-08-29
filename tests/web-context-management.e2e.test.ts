import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentLoop } from "@/core/agent-loop";
import { ContextManager } from "@/core/context/context-manager";
import type { ContextPolicyConfig } from "@/core/context/types";
import { LocalContextStore } from "@/lib/local-context-store";
import { OpenAICompatibleProvider } from "@/models/openai-provider";
import { createModeToolPolicy } from "@/tools/mode-policy";
import { readFileTool } from "@/tools/read-file";
import { createReadContextTool } from "@/tools/read-context";
import { ToolRegistry } from "@/tools/registry";
import { createWorkspaceBoundary } from "@/tools/workspace";
import type { WebChatEvent } from "@/web/chat-contract";

import {
  startOpenAIMockServer,
  textDelta,
  TEXT_FINISH_EVENT,
  TOOL_FINISH_EVENT,
  toolCallDelta,
  TRANSPORT_DONE_EVENT,
  type MockRequest,
} from "./helpers/openai-mock";

test("大工具结果在下一次模型调用前卸载并可由 read_context 取回", async () => {
  const workspaceDirectory = await mkdtemp(path.join(tmpdir(), "orbitcode-context-e2e-"));
  const storeDirectory = await mkdtemp(path.join(tmpdir(), "orbitcode-context-store-"));
  const marker = "FULL_TOOL_RESULT_MARKER_" + "x".repeat(20_000);
  await writeFile(path.join(workspaceDirectory, "large.txt"), marker);
  const server = await startOpenAIMockServer((request) => {
    const requestNumber = server.requests.length;
    if (requestNumber === 1) {
      return stream(
        toolCallDelta({
          id: "read-large",
          name: "read_file",
          argumentsJson: '{"path":"large.txt"}',
        }) + TOOL_FINISH_EVENT,
      );
    }
    if (requestNumber === 2) {
      const reference = JSON.stringify(request.body).match(/context:\/\/v1\/[0-9a-f-]{36}/)?.[0];
      assert.ok(reference);
      return stream(
        toolCallDelta({
          id: "read-offloaded",
          name: "read_context",
          argumentsJson: JSON.stringify({ reference, offset: 0, limit: 32_768 }),
        }) + TOOL_FINISH_EVENT,
      );
    }
    return stream(
      textDelta("已通过上下文引用重新读取完整工具结果。") + TEXT_FINISH_EVENT,
    );
  });

  try {
    const provider = new OpenAICompatibleProvider({
      model: "mock-model",
      baseUrl: server.baseUrl,
      apiKey: "test-key",
    });
    const store = new LocalContextStore(storeDirectory);
    const workspace = await createWorkspaceBoundary(workspaceDirectory);
    const sessionId = "context-session";
    const context = new ContextManager({
      sessionId,
      config: policy({
        singleToolResultTokens: 100,
        toolResultGroupTokens: 1_000,
      }),
      store,
      provider,
    });
    const registry = new ToolRegistry([
      readFileTool,
      createReadContextTool((input) => store.read({ sessionId, ...input })),
    ]);
    const agent = createAgent(provider, registry, workspace, context);
    const events = await collect(agent.streamTurn({
      input: "读取大文件并确认其中内容",
      mode: "plan",
      modeTurn: 1,
      signal: new AbortController().signal,
    }));

    assert.equal(events.at(-1)?.type, "stopped");
    assert.equal(server.requests.length, 3);
    const secondBody = JSON.stringify(server.requests[1]?.body);
    assert.match(secondBody, /context:\/\/v1\//);
    assert.equal(secondBody.includes(marker), false);
    assert.match(JSON.stringify(server.requests[2]?.body), /FULL_TOOL_RESULT_MARKER/);
    assert.equal(
      context.snapshot().messages.filter((message) => message.kind === "tool-result").length,
      2,
    );
  } finally {
    await server.close();
    await Promise.all([
      rm(workspaceDirectory, { recursive: true, force: true }),
      rm(storeDirectory, { recursive: true, force: true }),
    ]);
  }
});

test("自动重量压缩使用无工具摘要并在同一 Agent 轮继续", async () => {
  const workspaceDirectory = await mkdtemp(path.join(tmpdir(), "orbitcode-heavy-e2e-"));
  const storeDirectory = await mkdtemp(path.join(tmpdir(), "orbitcode-heavy-store-"));
  const server = await startOpenAIMockServer((request) => {
    if (toolChoice(request) === "none") {
      assert.equal(isRecord(request.body) && "tools" in request.body, false);
      return stream(
        textDelta(JSON.stringify({
          analysisDraft: "只在本次请求内分析旧历史",
          summary: {
            taskGoals: ["延续长期任务"],
            completedWork: ["已压缩旧助手消息"],
            keyDecisions: [],
            fileChanges: [],
            toolResults: [],
            errors: [],
            nextSteps: ["继续当前轮"],
          },
        })) + TEXT_FINISH_EVENT,
      );
    }
    return stream(textDelta("压缩后继续完成。") + TEXT_FINISH_EVENT);
  });

  try {
    const provider = new OpenAICompatibleProvider({
      model: "mock-model",
      baseUrl: server.baseUrl,
      apiKey: "test-key",
    });
    const store = new LocalContextStore(storeDirectory);
    const context = new ContextManager({
      sessionId: "heavy-session",
      config: policy({
        windowTokens: 8_000,
        recentMessagesTokens: 100,
        automaticReserveTokens: 1_000,
        manualReserveTokens: 300,
      }),
      store,
      provider,
      initialHistory: Array.from({ length: 14 }, (_, index) => index % 2 === 0
        ? { role: "user" as const, content: `用户原文-${index}` }
        : { role: "assistant" as const, content: `旧助手-${index}-${"x".repeat(700)}` }),
    });
    const workspace = await createWorkspaceBoundary(workspaceDirectory);
    const registry = new ToolRegistry([readFileTool]);
    const agent = new AgentLoop(
      provider,
      (mode) => createModeToolPolicy(registry, mode),
      workspace,
      {
        maxIterations: 3,
        promptEnvironment: promptEnvironment(),
        optionalPromptContext: { longTermMemory: "m".repeat(20_000) },
        contextManager: context,
      },
    );
    const events = await collect(agent.streamTurn({
      input: "继续工作",
      mode: "plan",
      modeTurn: 1,
      signal: new AbortController().signal,
    }));

    assert.equal(events.at(-1)?.type, "stopped");
    assert.deepEqual(server.requests.map(toolChoice), ["none", "auto"]);
    const normalRequest = JSON.stringify(server.requests[1]?.body);
    assert.match(normalRequest, /orbitcode_context_summary/);
    assert.match(normalRequest, /orbitcode_context_boundary/);
    assert.match(normalRequest, /用户原文-0/);
    assert.equal(context.snapshot().messages.filter(
      (message) => message.kind === "boundary",
    ).length, 1);
  } finally {
    await server.close();
    await Promise.all([
      rm(workspaceDirectory, { recursive: true, force: true }),
      rm(storeDirectory, { recursive: true, force: true }),
    ]);
  }
});

test("连续三次真实摘要协议失败后自动路径零请求，手动成功解除熔断", async () => {
  const storeDirectory = await mkdtemp(path.join(tmpdir(), "orbitcode-breaker-store-"));
  const server = await startOpenAIMockServer(() => {
    if (server.requests.length <= 3) {
      return stream(
        toolCallDelta({
          id: `forbidden-${server.requests.length}`,
          name: "read_file",
          argumentsJson: "{}",
        }) + TOOL_FINISH_EVENT,
      );
    }
    return stream(
      textDelta(JSON.stringify({
        analysisDraft: "人工恢复压缩",
        summary: {
          taskGoals: ["恢复会话"],
          completedWork: [],
          keyDecisions: [],
          fileChanges: [],
          toolResults: [],
          errors: ["此前摘要协议失败"],
          nextSteps: ["继续"],
        },
      })) + TEXT_FINISH_EVENT,
    );
  });
  try {
    const provider = new OpenAICompatibleProvider({
      model: "mock-model",
      baseUrl: server.baseUrl,
      apiKey: "test-key",
    });
    const manager = new ContextManager({
      sessionId: "breaker-session",
      config: policy({
        windowTokens: 8_000,
        recentMessagesTokens: 100,
        automaticReserveTokens: 1_000,
        manualReserveTokens: 300,
      }),
      store: new LocalContextStore(storeDirectory),
      provider,
      initialHistory: Array.from({ length: 14 }, (_, index) => index % 2 === 0
        ? { role: "user" as const, content: `用户-${index}` }
        : { role: "assistant" as const, content: `助手-${index}-${"x".repeat(700)}` }),
    });
    const signal = new AbortController().signal;
    assert.equal((await manager.compressManually(signal)).status, "failed");
    assert.equal((await manager.compressManually(signal)).status, "failed");
    assert.equal((await manager.compressManually(signal)).status, "circuit-open");
    assert.equal(server.requests.length, 3);

    manager.beginTurn("触发自动路径");
    await assert.rejects(
      manager.prepareForModel({
        systemMessages: [{ role: "system", content: "s".repeat(40_000) }],
        tools: [],
      }, signal),
      /熔断/,
    );
    await manager.rollbackTurn();
    assert.equal(server.requests.length, 3);

    const recovered = await manager.compressManually(signal);
    assert.equal(recovered.status, "succeeded");
    assert.equal(server.requests.length, 4);
    assert.equal(manager.snapshot().consecutiveSummaryFailures, 0);
  } finally {
    await server.close();
    await rm(storeDirectory, { recursive: true, force: true });
  }
});

function createAgent(
  provider: OpenAICompatibleProvider,
  registry: ToolRegistry,
  workspace: Awaited<ReturnType<typeof createWorkspaceBoundary>>,
  context: ContextManager,
): AgentLoop {
  return new AgentLoop(
    provider,
    (mode) => createModeToolPolicy(registry, mode),
    workspace,
    {
      maxIterations: 4,
      promptEnvironment: promptEnvironment(),
      contextManager: context,
    },
  );
}

function promptEnvironment() {
  return {
    workspace: { id: "test", name: "Test Workspace" },
    platform: "darwin",
    currentDate: "2026-08-29",
    timeZone: "Asia/Shanghai",
    pathSemantics: "workspace-relative-posix" as const,
  };
}

function policy(overrides: Partial<ContextPolicyConfig> = {}): ContextPolicyConfig {
  return {
    windowTokens: 100_000,
    singleToolResultTokens: 8_000,
    toolResultGroupTokens: 12_000,
    recentMessagesTokens: 10_000,
    automaticReserveTokens: 13_000,
    manualReserveTokens: 3_000,
    previewChars: 200,
    ...overrides,
  };
}

function stream(data: string) {
  return { chunks: [{ data: data + TRANSPORT_DONE_EVENT }] };
}

function toolChoice(request: MockRequest): unknown {
  return isRecord(request.body) ? request.body.tool_choice : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function collect(source: AsyncIterable<WebChatEvent>): Promise<readonly WebChatEvent[]> {
  const events: WebChatEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}
