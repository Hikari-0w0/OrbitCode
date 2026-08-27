import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryConversationSession } from "@/core/conversation";
import { ConversationStateError } from "@/core/errors";
import {
  ProviderError,
  type ChatProvider,
  type ConversationMessage,
  type ModelStreamEvent,
} from "@/models/provider";

class ScriptedProvider implements ChatProvider {
  readonly requests: ConversationMessage[][] = [];
  private readonly scripts: Array<
    (signal: AbortSignal) => AsyncIterable<ModelStreamEvent>
  >;

  constructor(
    ...scripts: Array<(signal: AbortSignal) => AsyncIterable<ModelStreamEvent>>
  ) {
    this.scripts = scripts;
  }

  stream(
    messages: readonly ConversationMessage[],
    options: {
      readonly signal: AbortSignal;
      readonly toolChoice: "auto" | "none";
    },
  ): AsyncIterable<ModelStreamEvent> {
    this.requests.push(messages.map((message) => ({ ...message })));
    const script = this.scripts.shift();
    if (!script) {
      throw new Error("测试缺少 Provider 脚本");
    }
    return script(options.signal);
  }
}

async function* events(
  ...items: readonly ModelStreamEvent[]
): AsyncIterable<ModelStreamEvent> {
  yield* items;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of source) {
    result.push(item);
  }
  return result;
}

test("完成两轮后按顺序提交完整历史", async () => {
  const provider = new ScriptedProvider(
    () =>
      events(
        { type: "text-delta", text: "你" },
        { type: "text-delta", text: "好" },
        { type: "done", finishReason: "stop" },
      ),
    () =>
      events(
        { type: "text-delta", text: "继续" },
        { type: "done", finishReason: "stop" },
      ),
  );
  const session = new InMemoryConversationSession(provider);

  const first = await collect(
    session.streamTurn("第一问", new AbortController().signal),
  );
  const second = await collect(
    session.streamTurn("第二问", new AbortController().signal),
  );

  assert.deepEqual(first, [
    { type: "text-delta", text: "你" },
    { type: "text-delta", text: "好" },
    {
      type: "completed",
      message: { role: "assistant", content: "你好" },
    },
  ]);
  assert.deepEqual(second.at(-1), {
    type: "completed",
    message: { role: "assistant", content: "继续" },
  });
  assert.deepEqual(provider.requests[1], [
    { role: "user", content: "第一问" },
    { role: "assistant", content: "你好" },
    { role: "user", content: "第二问" },
  ]);
  assert.deepEqual(session.getHistory(), [
    { role: "user", content: "第一问" },
    { role: "assistant", content: "你好" },
    { role: "user", content: "第二问" },
    { role: "assistant", content: "继续" },
  ]);
});

test("历史快照不能修改会话内部状态", async () => {
  const provider = new ScriptedProvider(
    () =>
      events(
        { type: "text-delta", text: "答" },
        { type: "done", finishReason: "stop" },
      ),
  );
  const session = new InMemoryConversationSession(provider);
  await collect(session.streamTurn("问", new AbortController().signal));

  const snapshot = session.getHistory();
  const mutable = snapshot as ConversationMessage[];
  mutable.push({ role: "user", content: "篡改" });

  assert.equal(session.getHistory().length, 2);
});

test("可从已提交历史开始新的无状态 Web 轮次", async () => {
  const requests: ConversationMessage[][] = [];
  const session = new InMemoryConversationSession(
    {
      async *stream(messages) {
        requests.push(messages.map((message) => ({ ...message })));
        yield { type: "text-delta", text: "继续回答" };
        yield { type: "done", finishReason: "stop" };
      },
    },
    [
      { role: "user", content: "第一问" },
      { role: "assistant", content: "第一答" },
    ],
  );

  await collect(session.streamTurn("第二问", new AbortController().signal));

  assert.deepEqual(requests[0], [
    { role: "user", content: "第一问" },
    { role: "assistant", content: "第一答" },
    { role: "user", content: "第二问" },
  ]);
});

test("Provider 失败或缺少完成标记时回滚整轮", async () => {
  const provider = new ScriptedProvider(
    async function* () {
      yield { type: "text-delta", text: "半段" };
      throw new ProviderError("network", "网络连接失败。");
    },
    () => events({ type: "text-delta", text: "仍未完成" }),
  );
  const session = new InMemoryConversationSession(provider);

  const failed = await collect(
    session.streamTurn("失败轮", new AbortController().signal),
  );
  const truncated = await collect(
    session.streamTurn("截断轮", new AbortController().signal),
  );

  assert.equal(failed.at(-1)?.type, "failed");
  assert.deepEqual(failed.at(-1), {
    type: "failed",
    error: { kind: "network", message: "网络连接失败。" },
  });
  assert.deepEqual(truncated.at(-1), {
    type: "failed",
    error: { kind: "stream", message: "模型响应在完成标记前中断。" },
  });
  assert.deepEqual(session.getHistory(), []);
});

test("重复完成或完成后数据被视为协议失败", async () => {
  const provider = new ScriptedProvider(
    () =>
      events(
        { type: "done", finishReason: "stop" },
        { type: "done", finishReason: "stop" },
      ),
    () =>
      events(
        { type: "done", finishReason: "stop" },
        { type: "text-delta", text: "额外数据" },
      ),
  );
  const session = new InMemoryConversationSession(provider);

  const duplicate = await collect(
    session.streamTurn("重复", new AbortController().signal),
  );
  const extra = await collect(
    session.streamTurn("额外", new AbortController().signal),
  );

  assert.equal(duplicate.at(-1)?.type, "failed");
  assert.equal(extra.at(-1)?.type, "failed");
  assert.deepEqual(session.getHistory(), []);
});

test("取消轮次后可以继续完成下一轮", async () => {
  const provider = new ScriptedProvider(
    async function* (signal) {
      yield { type: "text-delta", text: "部分" };
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new ProviderError("cancelled", "已取消");
    },
    () =>
      events(
        { type: "text-delta", text: "成功" },
        { type: "done", finishReason: "stop" },
      ),
  );
  const session = new InMemoryConversationSession(provider);
  const controller = new AbortController();
  const pending = collect(session.streamTurn("取消我", controller.signal));
  await Promise.resolve();
  controller.abort();

  const cancelled = await pending;
  const recovered = await collect(
    session.streamTurn("继续", new AbortController().signal),
  );

  assert.equal(cancelled.at(-1)?.type, "cancelled");
  assert.equal(recovered.at(-1)?.type, "completed");
  assert.deepEqual(session.getHistory(), [
    { role: "user", content: "继续" },
    { role: "assistant", content: "成功" },
  ]);
});

test("拒绝空白输入和并发轮次", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider = new ScriptedProvider(async function* () {
    yield { type: "text-delta", text: "等待" };
    await gate;
    yield { type: "done", finishReason: "stop" };
  });
  const session = new InMemoryConversationSession(provider);

  await assert.rejects(
    collect(session.streamTurn("   ", new AbortController().signal)),
    ConversationStateError,
  );

  const iterator = session
    .streamTurn("进行中", new AbortController().signal)
    [Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: "text-delta", text: "等待" },
  });
  await assert.rejects(
    collect(session.streamTurn("并发", new AbortController().signal)),
    ConversationStateError,
  );
  release();
  await iterator.next();
  await iterator.next();
});
