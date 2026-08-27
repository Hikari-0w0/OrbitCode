import assert from "node:assert/strict";
import test from "node:test";

import { parseServerSentEvents, SseError } from "@/models/sse";

const encoder = new TextEncoder();

async function* chunks(...values: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* values;
}

async function collect(source: AsyncIterable<string>): Promise<string[]> {
  const result: string[] = [];
  for await (const value of source) {
    result.push(value);
  }
  return result;
}

test("解析跨块事件和单块多个事件", async () => {
  const result = await collect(
    parseServerSentEvents(
      chunks(
        encoder.encode("data: fir"),
        encoder.encode("st\n\ndata: second\n\ndata: third\n\n"),
      ),
    ),
  );

  assert.deepEqual(result, ["first", "second", "third"]);
});

test("支持 CRLF、多行 data、注释和无关字段", async () => {
  const result = await collect(
    parseServerSentEvents(
      chunks(
        encoder.encode(
          ": keepalive\r\nevent: message\r\ndata: line-1\r\ndata: line-2\r\nid: 1\r\n\r\n",
        ),
      ),
    ),
  );

  assert.deepEqual(result, ["line-1\nline-2"]);
});

test("支持 UTF-8 字符跨字节块", async () => {
  const bytes = encoder.encode("data: 你好\n\n");
  const split = bytes.indexOf(0xe5) + 1;
  const result = await collect(
    parseServerSentEvents(chunks(bytes.slice(0, split), bytes.slice(split))),
  );

  assert.deepEqual(result, ["你好"]);
});

test("完整事件到达后无需等待输入流结束", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function* delayed(): AsyncIterable<Uint8Array> {
    yield encoder.encode("data: early\n\n");
    await gate;
    yield encoder.encode("data: late\n\n");
  }

  const iterator = parseServerSentEvents(delayed())[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { done: false, value: "early" });
  release();
  assert.deepEqual(await iterator.next(), { done: false, value: "late" });
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test("残缺事件和非法 UTF-8 返回安全错误", async () => {
  await assert.rejects(
    collect(parseServerSentEvents(chunks(encoder.encode("data: incomplete")))),
    SseError,
  );
  await assert.rejects(
    collect(parseServerSentEvents(chunks(Uint8Array.from([0xff, 0xfe])))),
    /无法读取 SSE 响应流/,
  );
});

test("底层读取异常不会泄露原始错误详情", async () => {
  const sentinel = "sentinel-stream-secret";
  async function* failedStream(): AsyncIterable<Uint8Array> {
    yield encoder.encode("data: safe\n\n");
    throw new Error(sentinel);
  }

  const iterator = parseServerSentEvents(failedStream())[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { done: false, value: "safe" });
  await assert.rejects(iterator.next(), (error: unknown) => {
    assert.ok(error instanceof SseError);
    assert.equal(error.message.includes(sentinel), false);
    return true;
  });
});
