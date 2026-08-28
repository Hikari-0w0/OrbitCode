import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop } from "@/core/agent-loop";
import type { AgentEvent } from "@/core/agent-events";
import { ConversationStateError } from "@/core/errors";
import {
  ProviderError,
  type ChatProvider,
  type ConversationMessage,
  type ModelStreamEvent,
} from "@/models/provider";
import { createModeToolPolicy } from "@/tools/mode-policy";
import { defineTool, successfulToolResult, ToolRegistry } from "@/tools/registry";
import { objectSchema, stringSchema } from "@/tools/schema";
import type { WorkspaceBoundary } from "@/tools/types";
import { createWorkspaceBoundary } from "@/tools/workspace";

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
      usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    },
  ]]);
  const agent = createAgent(provider, registry(), 4);
  const result = await collect(agent.streamTurn({
    input: "问题",
    mode: "do",
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
      signal: new AbortController().signal,
    }));

    const systemMessage = provider.requests[0]?.messages[0];
    assert.equal(systemMessage?.role, "system");
    assert.match(systemMessage?.content ?? "", /path 和 cwd.*Workspace.*相对路径/u);
  }
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
    signal: new AbortController().signal,
  }));

  assert.equal(provider.requests.length, 3);
  const requestMessages = provider.requests[1].messages;
  assert.deepEqual(requestMessages.at(-2), {
    role: "assistant",
    content: "先读取。",
    toolCalls: [call("read", "read_file", "a")],
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
    signal: controller.signal,
  }));
  await Promise.resolve();
  controller.abort();
  const cancelled = await pending;
  const recovered = await collect(agent.streamTurn({
    input: "继续",
    mode: "do",
    signal: new AbortController().signal,
  }));

  assert.equal(cancelled.filter((event) => event.type === "stopped").length, 1);
  assert.equal(stopReason(cancelled), "cancelled");
  assert.equal(stopReason(recovered), "final-response");
});

test("拒绝非法配置、空白输入和并发轮次", async () => {
  assert.throws(() => createAgent(new ScriptedProvider([]), registry(), 0));
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
      signal: new AbortController().signal,
    })),
    ConversationStateError,
  );
  const iterator = agent.streamTurn({
    input: "运行中",
    mode: "do",
    signal: new AbortController().signal,
  })[Symbol.asyncIterator]();
  await iterator.next();
  await assert.rejects(
    collect(agent.streamTurn({
      input: "并发",
      mode: "do",
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
    { maxIterations },
  );
}

function registry(onWrite: () => void = () => undefined): ToolRegistry {
  const read = (name: "read_file" | "find_files" | "search_code") =>
    defineTool({
      name,
      description: "只读测试工具",
      inputSchema: objectSchema({ label: stringSchema({ minLength: 1 }) }),
      mutability: "read-only" as const,
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
      async execute(input) {
        onWrite();
        return successfulToolResult({ label: input.label }, "applied");
      },
    }),
  ]);
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
