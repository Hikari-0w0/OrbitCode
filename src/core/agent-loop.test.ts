import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop } from "@/core/agent-loop";
import type { AgentEvent } from "@/core/agent-events";
import { AgentConfigurationError, ConversationStateError } from "@/core/errors";
import {
  ProviderError,
  type ChatProvider,
  type ConversationMessage,
  type ModelStreamEvent,
} from "@/models/provider";
import { createModeToolPolicy } from "@/tools/mode-policy";
import { PermissionGateway } from "@/tools/permission-gateway";
import { defineTool, successfulToolResult, ToolRegistry } from "@/tools/registry";
import { objectSchema, stringSchema } from "@/tools/schema";
import type { WorkspaceBoundary } from "@/tools/types";
import { createWorkspaceBoundary } from "@/tools/workspace";
import { PermissionSessionManager } from "@/web/permission-session-manager";

class ScriptedProvider implements ChatProvider {
  readonly requests: Array<{
    readonly messages: readonly ConversationMessage[];
    readonly toolNames: readonly string[];
  }> = [];

  constructor(
    private readonly scripts: Array<
      | readonly ModelStreamEvent[]
      | ((signal: AbortSignal) => AsyncIterable<ModelStreamEvent>)
    >,
  ) {}

  stream(
    messages: readonly ConversationMessage[],
    options: Parameters<ChatProvider["stream"]>[1],
  ): AsyncIterable<ModelStreamEvent> {
    this.requests.push({
      messages: messages.map((message) => ({ ...message })),
      toolNames: (options.tools ?? []).map((tool) => tool.function.name),
    });
    const script = this.scripts.shift();
    if (!script) throw new Error("测试缺少 Provider 脚本。");
    return typeof script === "function"
      ? script(options.signal)
      : events(...script);
  }
}

let workspace: WorkspaceBoundary | undefined;
test.before(async () => {
  workspace = await createWorkspaceBoundary(process.cwd());
});

test("直接最终回复产生 Usage 和唯一停止事件并提交历史", async () => {
  const provider = new ScriptedProvider([[
    { type: "text-delta", text: "完成" },
    { type: "done", finishReason: "stop" },
    {
      type: "usage",
      usage: {
        promptTokens: 3,
        completionTokens: 2,
        totalTokens: 5,
        promptCache: { availability: "unavailable" },
      },
    },
  ]]);
  const agent = createAgent(provider, registry(), 4);
  const result = await collect(agent.streamTurn({
    input: "问题",
    mode: "do",
    modeTurn: 1,
    signal: new AbortController().signal,
  }));

  assert.deepEqual(result.map((event) => event.type), [
    "progress",
    "text-delta",
    "token-usage",
    "stopped",
  ]);
  assert.deepEqual(result.at(-1), {
    type: "stopped",
    reason: "final-response",
    iterations: 1,
    sideEffect: "none",
    finalMessage: { role: "assistant", content: "完成" },
  });
  assert.deepEqual(agent.getHistory(), [
    { role: "user", content: "问题" },
    { role: "assistant", content: "完成" },
  ]);
});

test("Plan 和 Do 系统消息都声明 Workspace 相对路径契约", async () => {
  for (const mode of ["plan", "do"] as const) {
    const provider = new ScriptedProvider([[
      { type: "text-delta", text: "完成" },
      { type: "done", finishReason: "stop" },
    ]]);
    const agent = createAgent(provider, registry(), 1);

    await collect(agent.streamTurn({
      input: "处理文件",
      mode,
      modeTurn: 1,
      signal: new AbortController().signal,
    }));

    const messages = provider.requests[0]?.messages ?? [];
    assert.equal(messages[0]?.role, "system");
    assert.match(messages[0]?.content ?? "", /path 和 cwd.*Workspace.*相对路径/u);
    assert.match(messages[1]?.content ?? "", /^<orbitcode_environment>/u);
    assert.match(messages[2]?.content ?? "", /^<orbitcode_session_instructions>/u);
  }
});

test("累计缓存 Token，并在混合数量与命中状态时保守降级为状态", async () => {
  const provider = new ScriptedProvider([
    [
      { type: "tool-call", call: call("read-1", "read_file", "a") },
      { type: "done", finishReason: "tool-call" },
      {
        type: "usage",
        usage: {
          promptTokens: 10,
          completionTokens: 2,
          totalTokens: 12,
          promptCache: { availability: "tokens", cachedTokens: 4 },
        },
      },
    ],
    [
      { type: "tool-call", call: call("read-2", "read_file", "b") },
      { type: "done", finishReason: "tool-call" },
      {
        type: "usage",
        usage: {
          promptTokens: 20,
          completionTokens: 3,
          totalTokens: 23,
          promptCache: { availability: "tokens", cachedTokens: 6 },
        },
      },
    ],
    [
      { type: "text-delta", text: "完成" },
      { type: "done", finishReason: "stop" },
      {
        type: "usage",
        usage: {
          promptTokens: 30,
          completionTokens: 4,
          totalTokens: 34,
          promptCache: { availability: "status", hit: false },
        },
      },
    ],
  ]);
  const agent = createAgent(provider, registry(), 4);
  const result = await collect(agent.streamTurn({
    input: "读取后回答",
    mode: "do",
    modeTurn: 1,
    signal: new AbortController().signal,
  }));
  const usageEvents = result.filter((event) => event.type === "token-usage");

  assert.deepEqual(usageEvents[1]?.cumulative, {
    availability: "reported",
    promptTokens: 30,
    completionTokens: 5,
    totalTokens: 35,
    promptCache: { availability: "tokens", cachedTokens: 10 },
  });
  assert.deepEqual(usageEvents[2]?.cumulative, {
    availability: "reported",
    promptTokens: 60,
    completionTokens: 9,
    totalTokens: 69,
    promptCache: { availability: "status", hit: true },
  });
});

test("连续工具迭代把原调用和有序结果写回模型", async () => {
  const provider = new ScriptedProvider([
    [
      { type: "text-delta", text: "先读取。" },
      { type: "tool-call", call: call("read", "read_file", "a") },
      { type: "done", finishReason: "tool-call" },
    ],
    [
      { type: "tool-call", call: call("write", "write_file", "b") },
      { type: "done", finishReason: "tool-call" },
    ],
    [
      { type: "text-delta", text: "任务完成" },
      { type: "done", finishReason: "stop" },
    ],
  ]);
  const agent = createAgent(provider, registry(), 5);
  const result = await collect(agent.streamTurn({
    input: "执行任务",
    mode: "do",
    modeTurn: 1,
    signal: new AbortController().signal,
  }));

  assert.equal(provider.requests.length, 3);
  assert.deepEqual(
    provider.requests.map((request) => request.messages.slice(0, 3)),
    [
      provider.requests[0].messages.slice(0, 3),
      provider.requests[0].messages.slice(0, 3),
      provider.requests[0].messages.slice(0, 3),
    ],
  );
  const requestMessages = provider.requests[1].messages;
  assert.deepEqual(requestMessages.at(-2), {
    role: "assistant",
    content: "先读取。",
    toolCalls: [{ id: "read", name: "read_file", argumentsJson: "{}" }],
  });
  const toolMessage = requestMessages.at(-1);
  assert.equal(toolMessage?.role, "tool");
  if (toolMessage?.role !== "tool") return;
  assert.equal(toolMessage.toolCallId, "read");
  assert.match(toolMessage.content, /"label":"a"/);
  assert.match(toolMessage.content, /"sideEffect":"none"/);
  assert.equal(
    result.filter((event) => event.type === "stopped").length,
    1,
  );
  assert.equal(stopReason(result), "final-response");
});

test("用户拒绝权限后 Agent Loop 收到结构化工具结果并继续模型迭代", async () => {
  const provider = new ScriptedProvider([
    [
      { type: "tool-call", call: call("write-denied", "write_file", "package.json") },
      { type: "done", finishReason: "tool-call" },
    ],
    [
      { type: "text-delta", text: "未修改文件，已改用说明方案。" },
      { type: "done", finishReason: "stop" },
    ],
  ]);
  let executions = 0;
  const toolRegistry = registry(() => executions++);
  const manager = new PermissionSessionManager();
  const session = manager.createSession();
  const turn = manager.beginTurn(session.id, {
    workspace: { id: "test", name: "Test Workspace" },
    providerId: "test-provider",
  });
  const permissionGateway = new PermissionGateway({
    agentMode: "do",
    permissionMode: "default",
    workspace: requireWorkspace(),
    broker: turn.broker,
    loadRules: async () => [],
  });
  const agent = new AgentLoop(
    provider,
    (mode) => createModeToolPolicy(toolRegistry, mode),
    requireWorkspace(),
    {
      maxIterations: 3,
      promptEnvironment: {
        workspace: { id: "test", name: "Test Workspace" },
        platform: "darwin",
        currentDate: "2026-08-28",
        timeZone: "Asia/Shanghai",
        pathSemantics: "workspace-relative-posix",
      },
      permissionGatewayForMode: () => permissionGateway,
    },
  );
  const iterator = agent.streamTurn({
    input: "尝试修改",
    mode: "do",
    modeTurn: 1,
    signal: new AbortController().signal,
  })[Symbol.asyncIterator]();
  const observed: AgentEvent[] = [];
  for (;;) {
    const next = await iterator.next();
    assert.equal(next.done, false);
    if (!next.value) continue;
    observed.push(next.value);
    if (next.value.type === "permission-requested") {
      manager.resolveDecision(session.id, next.value.prompt.requestId, "deny");
      break;
    }
  }
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    observed.push(next.value);
  }

  assert.equal(executions, 0);
  assert.equal(observed.some((event) => event.type === "tool-started"), false);
  assert.equal(
    observed.some(
      (event) =>
        event.type === "tool-result" &&
        !event.result.ok &&
        event.result.error.kind === "user-denied",
    ),
    true,
  );
  assert.equal(observed.at(-1)?.type, "stopped");
  assert.equal(provider.requests.length, 2);
  assert.match(
    provider.requests[1].messages.at(-1)?.content ?? "",
    /user-denied/u,
  );
  manager.closeSession(session.id);
});

test("最后允许迭代仍请求工具时不执行并停止", async () => {
  let executions = 0;
  const provider = new ScriptedProvider([[
    { type: "tool-call", call: call("late", "read_file", "late") },
    { type: "done", finishReason: "tool-call" },
  ]]);
  const agent = createAgent(provider, registry(() => executions++), 1);
  const result = await collect(agent.streamTurn({
    input: "不要无限循环",
    mode: "do",
    modeTurn: 1,
    signal: new AbortController().signal,
  }));

  assert.equal(executions, 0);
  assert.equal(result.some((event) => event.type === "tool-call"), true);
  assert.equal(result.some((event) => event.type === "tool-started"), false);
  assert.equal(stopReason(result), "max-iterations");
  assert.deepEqual(agent.getHistory(), []);
});

test("连续两个全未知工具迭代停止，合法调用会重置计数", async () => {
  const provider = new ScriptedProvider([
    [
      { type: "tool-call", call: call("u1", "invented", "x") },
      { type: "done", finishReason: "tool-call" },
    ],
    [
      { type: "tool-call", call: call("known", "read_file", "ok") },
      { type: "done", finishReason: "tool-call" },
    ],
    [
      { type: "tool-call", call: call("u2", "invented", "x") },
      { type: "done", finishReason: "tool-call" },
    ],
    [
      { type: "tool-call", call: call("u3", "invented_again", "x") },
      { type: "done", finishReason: "tool-call" },
    ],
  ]);
  const agent = createAgent(provider, registry(), 6);
  const result = await collect(agent.streamTurn({
    input: "未知工具",
    mode: "do",
    modeTurn: 1,
    signal: new AbortController().signal,
  }));

  assert.equal(provider.requests.length, 4);
  assert.equal(
    stopReason(result),
    "repeated-unknown-tool",
  );
  assert.equal(
    result.filter(
      (event) =>
        event.type === "tool-result" &&
        !event.result.ok &&
        event.result.error.kind === "unknown-tool",
    ).length,
    3,
  );
});

test("Plan 模式拒绝的工具调用会中断连续未知工具计数", async () => {
  const provider = new ScriptedProvider([
    [
      { type: "tool-call", call: call("u1", "invented", "x") },
      { type: "done", finishReason: "tool-call" },
    ],
    [
      { type: "tool-call", call: call("denied", "write_file", "x") },
      { type: "done", finishReason: "tool-call" },
    ],
    [
      { type: "tool-call", call: call("u2", "invented_again", "x") },
      { type: "done", finishReason: "tool-call" },
    ],
    [
      { type: "text-delta", text: "计划完成" },
      { type: "done", finishReason: "stop" },
    ],
  ]);
  const agent = createAgent(provider, registry(), 6);
  const result = await collect(agent.streamTurn({
    input: "规划任务",
    mode: "plan",
    modeTurn: 1,
    signal: new AbortController().signal,
  }));

  assert.equal(provider.requests.length, 4);
  assert.equal(stopReason(result), "final-response");
});

test("Plan 只向模型公开只读工具并结构化拒绝伪造写入", async () => {
  let writes = 0;
  const provider = new ScriptedProvider([
    [
      { type: "tool-call", call: call("denied", "write_file", "x") },
      { type: "done", finishReason: "tool-call" },
    ],
    [
      { type: "text-delta", text: "只生成计划" },
      { type: "done", finishReason: "stop" },
    ],
  ]);
  const agent = createAgent(provider, registry(() => writes++), 4);
  const result = await collect(agent.streamTurn({
    input: "规划",
    mode: "plan",
    modeTurn: 1,
    signal: new AbortController().signal,
  }));

  assert.deepEqual(provider.requests[0].toolNames, [
    "read_file",
    "find_files",
    "search_code",
  ]);
  assert.equal(writes, 0);
  const denied = result.find((event) => event.type === "tool-result");
  assert.equal(
    denied?.type === "tool-result" && !denied.result.ok
      ? denied.result.error.kind
      : undefined,
    "permission-denied",
  );
});

test("Provider 流错误映射为 model-error 且不提交历史", async () => {
  const provider = new ScriptedProvider([
    async function* () {
      yield { type: "text-delta", text: "部分" } as const;
      throw new ProviderError("stream", "模型流中断。");
    },
  ]);
  const agent = createAgent(provider, registry(), 3);
  const result = await collect(agent.streamTurn({
    input: "失败",
    mode: "do",
    modeTurn: 1,
    signal: new AbortController().signal,
  }));
  assert.deepEqual(result.at(-1), {
    type: "stopped",
    reason: "model-error",
    iterations: 0,
    sideEffect: "none",
    detail: "模型流中断。",
  });
  assert.deepEqual(agent.getHistory(), []);
});

test("模型阶段取消产生唯一 cancelled 并可继续下一轮", async () => {
  const provider = new ScriptedProvider([
    async function* (signal) {
      yield { type: "text-delta", text: "部分" };
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new ProviderError("cancelled", "已取消");
    },
    [
      { type: "text-delta", text: "恢复" },
      { type: "done", finishReason: "stop" },
    ],
  ]);
  const agent = createAgent(provider, registry(), 3);
  const controller = new AbortController();
  const pending = collect(agent.streamTurn({
    input: "取消",
    mode: "do",
    modeTurn: 1,
    signal: controller.signal,
  }));
  await Promise.resolve();
  controller.abort();
  const cancelled = await pending;
  const recovered = await collect(agent.streamTurn({
    input: "继续",
    mode: "do",
    modeTurn: 2,
    signal: new AbortController().signal,
  }));

  assert.equal(cancelled.filter((event) => event.type === "stopped").length, 1);
  assert.equal(stopReason(cancelled), "cancelled");
  assert.equal(stopReason(recovered), "final-response");
});

test("拒绝非法配置、空白输入和并发轮次", async () => {
  assert.throws(() => createAgent(new ScriptedProvider([]), registry(), 0));
  const invalidPromptProvider = new ScriptedProvider([]);
  const invalidPromptAgent = createAgent(invalidPromptProvider, registry(), 3);
  await assert.rejects(
    collect(invalidPromptAgent.streamTurn({
      input: "非法轮次",
      mode: "do",
      modeTurn: 0,
      signal: new AbortController().signal,
    })),
    AgentConfigurationError,
  );
  assert.equal(invalidPromptProvider.requests.length, 0);
  const release = deferred<void>();
  const provider = new ScriptedProvider([
    async function* () {
      yield { type: "text-delta", text: "等待" };
      await release.promise;
      yield { type: "done", finishReason: "stop" };
    },
  ]);
  const agent = createAgent(provider, registry(), 3);
  await assert.rejects(
    collect(agent.streamTurn({
      input: "  ",
      mode: "do",
      modeTurn: 1,
      signal: new AbortController().signal,
    })),
    ConversationStateError,
  );
  const iterator = agent.streamTurn({
    input: "运行中",
    mode: "do",
    modeTurn: 1,
    signal: new AbortController().signal,
  })[Symbol.asyncIterator]();
  await iterator.next();
  await assert.rejects(
    collect(agent.streamTurn({
      input: "并发",
      mode: "do",
      modeTurn: 2,
      signal: new AbortController().signal,
    })),
    ConversationStateError,
  );
  release.resolve();
  for (;;) {
    if ((await iterator.next()).done) break;
  }
});

function createAgent(
  provider: ChatProvider,
  registry: ToolRegistry,
  maxIterations: number,
) {
  return new AgentLoop(
    provider,
    (mode) => createModeToolPolicy(registry, mode),
    requireWorkspace(),
    {
      maxIterations,
      promptEnvironment: {
        workspace: { id: "test", name: "Test Workspace" },
        platform: "darwin",
        currentDate: "2026-08-28",
        timeZone: "Asia/Shanghai",
        pathSemantics: "workspace-relative-posix",
      },
    },
  );
}

function registry(onWrite: () => void = () => undefined): ToolRegistry {
  const read = (name: "read_file" | "find_files" | "search_code") =>
    defineTool({
      name,
      description: "只读测试工具",
      inputSchema: objectSchema({ label: stringSchema({ minLength: 1 }) }),
      mutability: "read-only" as const,
      permission: testPathPermission("label"),
      async execute(input) {
        return successfulToolResult({ label: input.label });
      },
    });
  return new ToolRegistry([
    read("read_file"),
    read("find_files"),
    read("search_code"),
    defineTool({
      name: "write_file",
      description: "写入测试工具",
      inputSchema: objectSchema({ label: stringSchema({ minLength: 1 }) }),
      mutability: "workspace-write",
      permission: testPathPermission("label"),
      async execute(input) {
        onWrite();
        return successfulToolResult({ label: input.label }, "applied");
      },
    }),
  ]);
}

function testPathPermission(field: "label") {
  return {
    targetKind: "path" as const,
    resolve(input: { readonly label: string }) {
      return {
        kind: "path" as const,
        requestedPath: input[field],
        resolution: "existing-file" as const,
      };
    },
  };
}

function call(id: string, name: string, label: string) {
  return { id, name, argumentsJson: JSON.stringify({ label }) };
}

function requireWorkspace(): WorkspaceBoundary {
  if (!workspace) throw new Error("测试工作区尚未初始化。");
  return workspace;
}

async function* events(
  ...items: readonly ModelStreamEvent[]
): AsyncIterable<ModelStreamEvent> {
  yield* items;
}

async function collect<T>(source: AsyncIterable<T>): Promise<readonly T[]> {
  const result: T[] = [];
  for await (const item of source) result.push(item);
  return result;
}

function stopReason(events: readonly AgentEvent[]) {
  const event = events.at(-1);
  return event?.type === "stopped" ? event.reason : undefined;
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}
