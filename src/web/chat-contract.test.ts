import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeWebChatEvent,
  MAX_WEB_CHAT_MESSAGE_LENGTH,
  MAX_WEB_CHAT_MESSAGES,
  parseProviderCatalogResponse,
  parseWebChatEvents,
  parseWebChatRequest,
  WebChatContractError,
  type WebChatEvent,
} from "@/web/chat-contract";

test("接受严格的多轮请求并保留消息顺序", () => {
  const result = parseWebChatRequest({
    provider: " primary ",
    messages: [
      { role: "user", content: "第一问" },
      { role: "assistant", content: "第一答" },
      { role: "user", content: "第二问" },
    ],
  });

  assert.equal(result.provider, "primary");
  assert.deepEqual(result.messages, [
    { role: "user", content: "第一问" },
    { role: "assistant", content: "第一答" },
    { role: "user", content: "第二问" },
  ]);
});

test("拒绝未知字段、非法角色顺序和空内容", () => {
  const invalidValues: readonly unknown[] = [
    null,
    { provider: "primary", messages: [], extra: true },
    { provider: "", messages: [{ role: "user", content: "问题" }] },
    { provider: "primary", messages: [{ role: "system", content: "越界" }] },
    { provider: "primary", messages: [{ role: "assistant", content: "回答" }] },
    {
      provider: "primary",
      messages: [
        { role: "user", content: "问题" },
        { role: "user", content: "重复" },
      ],
    },
    { provider: "primary", messages: [{ role: "user", content: "   " }] },
    {
      provider: "primary",
      messages: [{ role: "user", content: "问题", extra: true }],
    },
  ];

  for (const value of invalidValues) {
    assert.throws(() => parseWebChatRequest(value), WebChatContractError);
  }
});

test("拒绝超长内容和过多历史", () => {
  assert.throws(
    () =>
      parseWebChatRequest({
        provider: "primary",
        messages: [
          { role: "user", content: "x".repeat(MAX_WEB_CHAT_MESSAGE_LENGTH + 1) },
        ],
      }),
    /超过/,
  );

  const messages = Array.from({ length: MAX_WEB_CHAT_MESSAGES + 1 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: String(index),
  }));
  assert.throws(
    () => parseWebChatRequest({ provider: "primary", messages }),
    /数量/,
  );
});

test("Web SSE 事件按网络分块往返解析", async () => {
  const expected: readonly WebChatEvent[] = [
    { type: "text-delta", text: "Orbit" },
    { type: "text-delta", text: "Code" },
    { type: "completed" },
  ];
  const bytes = Buffer.concat(expected.map((event) => encodeWebChatEvent(event)));
  const chunks = [bytes.subarray(0, 9), bytes.subarray(9, 23), bytes.subarray(23)];

  const actual: WebChatEvent[] = [];
  for await (const event of parseWebChatEvents(asAsync(chunks))) {
    actual.push(event);
  }
  assert.deepEqual(actual, expected);
});

test("只接受安全的 Provider 摘要", () => {
  assert.deepEqual(
    parseProviderCatalogResponse({
      providers: [{ name: "primary", model: "model", available: true }],
    }),
    {
      providers: [{ name: "primary", model: "model", available: true }],
    },
  );
  assert.throws(
    () =>
      parseProviderCatalogResponse({
        providers: [
          {
            name: "primary",
            model: "model",
            available: true,
            apiKey: "must-not-pass",
          },
        ],
      }),
    /无效的模型配置列表/,
  );
});

test("拒绝非法 Web SSE JSON 与事件结构", async () => {
  await assert.rejects(
    collect(parseWebChatEvents(asAsync([Buffer.from("data: nope\n\n")]))),
    /无效的流式事件/,
  );
  await assert.rejects(
    collect(
      parseWebChatEvents(
        asAsync([Buffer.from('data: {"type":"completed","extra":true}\n\n')]),
      ),
    ),
    /无效的流式事件/,
  );
});

async function* asAsync(
  chunks: readonly Uint8Array[],
): AsyncIterable<Uint8Array> {
  yield* chunks;
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<readonly T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
