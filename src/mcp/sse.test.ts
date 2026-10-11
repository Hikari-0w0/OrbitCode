import assert from "node:assert/strict";
import test from "node:test";
import { readSse } from "./sse";
test("SSE 分块、CRLF、多行 data 与空事件", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({ start(c) {
    for (const chunk of [":comment\r\n\r\ndata:\n\nda", "ta: 一\r\ndata: 二\r\n\r\n"]) c.enqueue(encoder.encode(chunk));
    c.close();
  } });
  const results: string[] = [];
  for await (const item of readSse(body, new AbortController().signal)) results.push(item);
  assert.deepEqual(results, ["一\n二"]);
});

test("SSE 超限拒绝，取消释放未结束 reader", async () => {
  const body = new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode('data: '+ 'x'.repeat(2*1024*1024)));c.close();}});
  await assert.rejects(async () => { for await (const _item of readSse(body, new AbortController().signal)) void _item; }, /上限/);
  let cancelled = false; const controller = new AbortController();
  const pending = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const generator = readSse(pending, controller.signal); const next = generator.next(); controller.abort(); await next;
  assert.equal(cancelled, true); assert.equal(pending.locked, false);
});
