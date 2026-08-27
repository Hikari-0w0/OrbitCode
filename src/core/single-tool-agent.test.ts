import assert from "node:assert/strict";
import test from "node:test";

import { SingleToolAgent } from "@/core/single-tool-agent";
import {
  type ChatProvider,
  type ConversationMessage,
  type ModelStreamEvent,
} from "@/models/provider";
import { defineTool, successfulToolResult, ToolRegistry } from "@/tools/registry";
import { objectSchema, stringSchema } from "@/tools/schema";
import {
  toolFailure,
  type SideEffectState,
  type ToolName,
} from "@/tools/types";
import { createWorkspaceBoundary } from "@/tools/workspace";

class ScriptedProvider implements ChatProvider {
  readonly requests: Array<{
    readonly messages: readonly ConversationMessage[];
    readonly toolChoice: "auto" | "none";
    readonly toolCount: number;
  }> = [];

  constructor(private readonly scripts: Array<readonly ModelStreamEvent[]>) {}

  async *stream(
    messages: readonly ConversationMessage[],
    options: Parameters<ChatProvider["stream"]>[1],
  ): AsyncIterable<ModelStreamEvent> {
    this.requests.push({
      messages: messages.map((message) => ({ ...message })),
      toolChoice: options.toolChoice,
      toolCount: options.tools?.length ?? 0,
    });
    const script = this.scripts.shift();
    if (!script) throw new Error("测试缺少 Provider 脚本。");
    yield* script;
  }
}

const workspace = awaitWorkspace();

test("直接文本只请求一次模型并提交普通历史", async () => {
  const provider = new ScriptedProvider([
    [
      { type: "text-delta", text: "直接" },
      { type: "text-delta", text: "回答" },
      { type: "done", finishReason: "stop" },
    ],
  ]);
  const agent = new SingleToolAgent(provider, registry(), await workspace);
  const events = await collect(agent.streamTurn("问题", new AbortController().signal));
  assert.equal(provider.requests.length, 1);
  assert.equal(provider.requests[0].toolChoice, "auto");
  assert.deepEqual(events.at(-1), {
    type: "completed",
    message: { role: "assistant", content: "直接回答" },
  });
  assert.deepEqual(agent.getHistory(), [
    { role: "user", content: "问题" },
    { role: "assistant", content: "直接回答" },
  ]);
});

test("工具成功时只执行一次并按协议请求最终文本", async () => {
  let executions = 0;
  const provider = new ScriptedProvider([
    [
      {
        type: "tool-call",
        call: { id: "call_1", name: "read_file", argumentsJson: '{"path":"README.md"}' },
      },
      { type: "done", finishReason: "tool-call" },
    ],
    [
      { type: "text-delta", text: "读取完成" },
      { type: "done", finishReason: "stop" },
    ],
  ]);
  const agent = new SingleToolAgent(
    provider,
    registry(() => executions++),
    await workspace,
  );
  const events = await collect(agent.streamTurn("读取", new AbortController().signal));
  assert.equal(executions, 1);
  assert.equal(provider.requests.length, 2);
  assert.equal(provider.requests[0].toolCount, 1);
  assert.equal(provider.requests[1].toolChoice, "none");
  const toolEvent = events.find((event) => event.type === "tool-completed");
  assert.equal(toolEvent?.type, "tool-completed");
  if (toolEvent?.type !== "tool-completed") return;
  assert.deepEqual(provider.requests[1].messages.slice(-2), [
    {
      role: "assistant",
      content: null,
      toolCalls: [
        { id: "call_1", name: "read_file", argumentsJson: '{"path":"README.md"}' },
      ],
    },
    {
      role: "tool",
      toolCallId: "call_1",
      content: JSON.stringify(toolEvent.result),
    },
  ]);
  assert.deepEqual(events.map((event) => event.type), [
    "tool-started",
    "tool-completed",
    "text-delta",
    "completed",
  ]);
});

test("工具调用前的说明文本可展示且不影响工具执行与最终历史", async () => {
  let executions = 0;
  const provider = new ScriptedProvider([
    [
      { type: "text-delta", text: "我来查看项目。" },
      {
        type: "tool-call",
        call: {
          id: "call_mixed",
          name: "read_file",
          argumentsJson: '{"path":"README.md"}',
        },
      },
      { type: "done", finishReason: "tool-call" },
    ],
    [
      { type: "text-delta", text: "入口文件是 src/app/page.tsx。" },
      { type: "done", finishReason: "stop" },
    ],
  ]);
  const agent = new SingleToolAgent(
    provider,
    registry(() => executions++),
    await workspace,
  );

  const events = await collect(agent.streamTurn("查看入口", new AbortController().signal));

  assert.equal(executions, 1);
  assert.equal(provider.requests.length, 2);
  assert.deepEqual(events.map((event) => event.type), [
    "text-delta",
    "tool-started",
    "tool-completed",
    "text-delta",
    "completed",
  ]);
  assert.deepEqual(agent.getHistory(), [
    { role: "user", content: "查看入口" },
    { role: "assistant", content: "入口文件是 src/app/page.tsx。" },
  ]);
});

test("无效参数 JSON 作为工具失败回传而不执行工具", async () => {
  let executions = 0;
  const provider = new ScriptedProvider([
    [
      {
        type: "tool-call",
        call: { id: "bad", name: "read_file", argumentsJson: "{" },
      },
      { type: "done", finishReason: "tool-call" },
    ],
    [
      { type: "text-delta", text: "参数有误" },
      { type: "done", finishReason: "stop" },
    ],
  ]);
  const agent = new SingleToolAgent(
    provider,
    registry(() => executions++),
    await workspace,
  );
  const events = await collect(agent.streamTurn("错误参数", new AbortController().signal));
  assert.equal(executions, 0);
  const toolEvent = events.find((event) => event.type === "tool-completed");
  assert.equal(
    toolEvent?.type === "tool-completed" && !toolEvent.result.ok
      ? toolEvent.result.error.kind
      : undefined,
    "invalid-arguments",
  );
  assert.equal(events.at(-1)?.type, "completed");
});

test("第二次工具调用立即失败且不提交历史", async () => {
  const provider = new ScriptedProvider([
    [
      {
        type: "tool-call",
        call: { id: "one", name: "read_file", argumentsJson: '{"path":"README.md"}' },
      },
      { type: "done", finishReason: "tool-call" },
    ],
    [
      {
        type: "tool-call",
        call: { id: "two", name: "read_file", argumentsJson: '{"path":"package.json"}' },
      },
      { type: "done", finishReason: "tool-call" },
    ],
  ]);
  const agent = new SingleToolAgent(provider, registry(), await workspace);
  const events = await collect(agent.streamTurn("两次", new AbortController().signal));
  assert.equal(provider.requests.length, 2);
  assert.equal(events.at(-1)?.type, "failed");
  assert.deepEqual(agent.getHistory(), []);
});

test("取消工具结果终止轮次且不请求最终模型", async () => {
  const provider = new ScriptedProvider([
    [
      {
        type: "tool-call",
        call: { id: "cancel", name: "read_file", argumentsJson: '{"path":"README.md"}' },
      },
      { type: "done", finishReason: "tool-call" },
    ],
  ]);
  const controller = new AbortController();
  const cancellingRegistry = registry(() => controller.abort());
  const agent = new SingleToolAgent(provider, cancellingRegistry, await workspace);
  const events = await collect(agent.streamTurn("取消", controller.signal));
  assert.equal(provider.requests.length, 1);
  assert.equal(events.at(-1)?.type, "cancelled");
  assert.deepEqual(agent.getHistory(), []);
});

test("最终模型失败时保留工具真实副作用等级", async () => {
  const scenarios: ReadonlyArray<{
    readonly name: ToolName;
    readonly sideEffect: SideEffectState;
  }> = [
    { name: "read_file", sideEffect: "none" },
    { name: "run_command", sideEffect: "possible" },
    { name: "write_file", sideEffect: "applied" },
  ];

  for (const scenario of scenarios) {
    const provider = new ScriptedProvider([
      [
        {
          type: "tool-call",
          call: {
            id: `call_${scenario.name}`,
            name: scenario.name,
            argumentsJson: '{"path":"target.txt"}',
          },
        },
        { type: "done", finishReason: "tool-call" },
      ],
      [],
    ]);
    const agent = new SingleToolAgent(
      provider,
      sideEffectFailureRegistry(scenario.name, scenario.sideEffect),
      await workspace,
    );
    const events = await collect(
      agent.streamTurn("触发失败", new AbortController().signal),
    );
    const toolCompleted = events.find((event) => event.type === "tool-completed");
    assert.equal(
      toolCompleted?.type === "tool-completed"
        ? toolCompleted.result.sideEffect
        : undefined,
      scenario.sideEffect,
    );
    assert.deepEqual(events.at(-1), {
      type: "failed",
      error: { kind: "stream", message: "模型响应在完成事件前中断。" },
      sideEffect: scenario.sideEffect,
    });
    assert.deepEqual(agent.getHistory(), []);
  }
});

function registry(onExecute: () => void = () => undefined): ToolRegistry {
  return new ToolRegistry([
    defineTool({
      name: "read_file",
      description: "读取",
      inputSchema: objectSchema({ path: stringSchema({ minLength: 1 }) }),
      mutability: "read-only",
      async execute() {
        onExecute();
        return successfulToolResult({ content: "ok" });
      },
    }),
  ]);
}

function sideEffectFailureRegistry(
  name: ToolName,
  sideEffect: SideEffectState,
): ToolRegistry {
  return new ToolRegistry([
    defineTool({
      name,
      description: "副作用测试工具",
      inputSchema: objectSchema({ path: stringSchema({ minLength: 1 }) }),
      mutability:
        name === "run_command"
          ? "command"
          : name === "write_file"
            ? "workspace-write"
            : "read-only",
      async execute() {
        return toolFailure("execution-failed", "测试工具失败。", { sideEffect });
      },
    }),
  ]);
}

async function awaitWorkspace() {
  return createWorkspaceBoundary(process.cwd());
}

async function collect<T>(source: AsyncIterable<T>): Promise<readonly T[]> {
  const result: T[] = [];
  for await (const item of source) result.push(item);
  return result;
}
