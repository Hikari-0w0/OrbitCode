import assert from "node:assert/strict";
import { PassThrough, Readable, Writable } from "node:stream";
import test from "node:test";

import type { ConversationSession, TurnEvent } from "@/core/conversation";
import type { ConversationMessage } from "@/models/provider";
import { runTerminalChat } from "@/cli/terminal-chat";

class MemoryWritable extends Writable {
  value = "";

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.value += chunk.toString();
    callback();
  }
}

class FakeSession implements ConversationSession {
  readonly inputs: string[] = [];
  private readonly turns: Array<
    (signal: AbortSignal) => AsyncIterable<TurnEvent>
  >;

  constructor(
    ...turns: Array<(signal: AbortSignal) => AsyncIterable<TurnEvent>>
  ) {
    this.turns = turns;
  }

  getHistory(): readonly ConversationMessage[] {
    return [];
  }

  streamTurn(input: string, signal: AbortSignal): AsyncIterable<TurnEvent> {
    this.inputs.push(input);
    const turn = this.turns.shift();
    if (!turn) {
      throw new Error("测试缺少对话脚本");
    }
    return turn(signal);
  }
}

async function* successful(text: string): AsyncIterable<TurnEvent> {
  yield { type: "text-delta", text };
  yield {
    type: "completed",
    message: { role: "assistant", content: text },
  };
}

test("空白输入不请求模型且显式退出", async () => {
  const output = new MemoryWritable();
  const errorOutput = new MemoryWritable();
  const session = new FakeSession(() => successful("回答"));

  await runTerminalChat({
    session,
    input: Readable.from(["   \n", "问题\n", "/exit\n"]),
    output,
    errorOutput,
    terminal: false,
    registerInterrupt: () => () => undefined,
  });

  assert.deepEqual(session.inputs, ["问题"]);
  assert.match(output.value, /OrbitCode 已启动/);
  assert.match(output.value, /助手> 回答\n你> 再见/);
  assert.equal((output.value.match(/你> /g) ?? []).length, 3);
  assert.equal(errorOutput.value, "");
});

test("失败后整理换行并恢复提示符", async () => {
  const output = new MemoryWritable();
  const errorOutput = new MemoryWritable();
  const session = new FakeSession(async function* () {
    yield { type: "text-delta", text: "部分" };
    yield {
      type: "failed",
      error: { kind: "network", message: "网络错误" },
    };
  });

  await runTerminalChat({
    session,
    input: Readable.from(["问题\n", "/exit\n"]),
    output,
    errorOutput,
    terminal: false,
    registerInterrupt: () => () => undefined,
  });

  assert.match(output.value, /助手> 部分\n你> /);
  assert.equal(errorOutput.value, "错误：网络错误\n");
});

test("流中中断只取消当前轮并允许继续", async () => {
  const output = new MemoryWritable();
  const errorOutput = new MemoryWritable();
  let interrupt: () => void = () => undefined;
  let partialWritten: () => void = () => undefined;
  const partial = new Promise<void>((resolve) => {
    partialWritten = resolve;
  });
  const input = new Readable({ read() {} });
  const session = new FakeSession(
    async function* (signal) {
      yield { type: "text-delta", text: "部分" };
      partialWritten();
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "cancelled" };
    },
    () => successful("恢复"),
  );

  const running = runTerminalChat({
    session,
    input,
    output,
    errorOutput,
    terminal: false,
    registerInterrupt: (listener) => {
      interrupt = listener;
      return () => undefined;
    },
  });
  input.push("取消\n");
  await partial;
  interrupt();
  input.push("继续\n");
  input.push("/exit\n");
  input.push(null);
  await running;

  assert.deepEqual(session.inputs, ["取消", "继续"]);
  assert.match(output.value, /部分\n\[当前回复已取消\]\n你> /);
  assert.match(output.value, /助手> 恢复\n你> 再见/);
  assert.equal(errorOutput.value, "");
});

test("TTY 中的 Ctrl-C 通过 readline 事件取消当前轮", async () => {
  const output = new MemoryWritable();
  const errorOutput = new MemoryWritable();
  let partialWritten: () => void = () => undefined;
  const partial = new Promise<void>((resolve) => {
    partialWritten = resolve;
  });
  const input = new PassThrough();
  const session = new FakeSession(
    async function* (signal) {
      yield { type: "text-delta", text: "TTY部分" };
      partialWritten();
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "cancelled" };
    },
    () => successful("恢复"),
  );

  const running = runTerminalChat({
    session,
    input,
    output,
    errorOutput,
    terminal: true,
    registerInterrupt: () => () => undefined,
  });
  input.write("取消\r");
  await partial;
  input.write("\x03");
  await waitForOutput(output, "[当前回复已取消]");
  input.write("继续\r");
  input.write("/exit\r");
  input.end();
  await running;

  assert.deepEqual(session.inputs, ["取消", "继续"]);
  assert.match(output.value, /TTY部分\n\[当前回复已取消\]\n你> /);
  assert.match(output.value, /助手> 恢复\n你> 再见/);
  assert.equal(errorOutput.value, "");
});

async function waitForOutput(
  output: MemoryWritable,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!output.value.includes(expected)) {
    if (Date.now() >= deadline) {
      throw new Error(`等待终端输出超时：${expected}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("空闲中断关闭输入并清理监听器", async () => {
  const output = new MemoryWritable();
  const input = new Readable({ read() {} });
  let interrupt: () => void = () => undefined;
  let removed = false;

  const running = runTerminalChat({
    session: new FakeSession(),
    input,
    output,
    errorOutput: new MemoryWritable(),
    terminal: false,
    registerInterrupt: (listener) => {
      interrupt = listener;
      return () => {
        removed = true;
      };
    },
  });
  interrupt();
  await running;

  assert.equal(removed, true);
  assert.match(output.value, /你> \n$/);
});

test("输入 EOF 时正常结束等待", async () => {
  const output = new MemoryWritable();
  let removed = false;

  await runTerminalChat({
    session: new FakeSession(),
    input: Readable.from([]),
    output,
    errorOutput: new MemoryWritable(),
    terminal: false,
    registerInterrupt: () => () => {
      removed = true;
    },
  });

  assert.equal(removed, true);
  assert.match(output.value, /你> $/);
});
