import assert from "node:assert/strict";
import test from "node:test";

import { OpenAICompatibleProvider } from "@/models/openai-provider";
import { ProviderError, type ModelStreamEvent } from "@/models/provider";
import {
  DONE_EVENT,
  startOpenAIMockServer,
  textDelta,
} from "../../tests/helpers/openai-mock";

async function collect(
  source: AsyncIterable<ModelStreamEvent>,
): Promise<ModelStreamEvent[]> {
  const result: ModelStreamEvent[] = [];
  for await (const event of source) {
    result.push(event);
  }
  return result;
}

test("发送正确请求并按网络分块实时产出文本", async () => {
  let doneWasSent = false;
  const server = await startOpenAIMockServer(() => ({
    chunks: [
      { data: textDelta("你").slice(0, 12) },
      { data: textDelta("你").slice(12) },
      { data: textDelta("好"), delayMs: 20 },
      {
        data: DONE_EVENT,
        delayMs: 40,
      },
    ],
  }));
  try {
    const provider = new OpenAICompatibleProvider({
      model: "test-model",
      baseUrl: `${server.baseUrl}/`,
      apiKey: "test-secret",
    });
    const iterator = provider
      .stream([{ role: "user", content: "问候" }], {
        signal: new AbortController().signal,
      })
      [Symbol.asyncIterator]();

    assert.deepEqual(await iterator.next(), {
      done: false,
      value: { type: "text-delta", text: "你" },
    });
    assert.equal(doneWasSent, false);
    const remaining: ModelStreamEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      remaining.push(next.value);
      if (next.value.type === "done") {
        doneWasSent = true;
      }
    }

    assert.deepEqual(remaining, [
      { type: "text-delta", text: "好" },
      { type: "done" },
    ]);
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].method, "POST");
    assert.equal(server.requests[0].url, "/v1/chat/completions");
    assert.equal(server.requests[0].authorization, "Bearer test-secret");
    assert.deepEqual(server.requests[0].body, {
      model: "test-model",
      messages: [{ role: "user", content: "问候" }],
      stream: true,
    });
  } finally {
    await server.close();
  }
});

test("忽略合法元数据并支持一个块中的多个事件", async () => {
  const server = await startOpenAIMockServer(() => ({
    chunks: [
      {
        data:
          'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
          textDelta("文本") +
          'data: {"choices":[]}\n\n' +
          DONE_EVENT,
      },
    ],
  }));
  try {
    const provider = new OpenAICompatibleProvider({
      model: "test-model",
      baseUrl: server.baseUrl,
      apiKey: "test-secret",
    });
    assert.deepEqual(
      await collect(
        provider.stream([], { signal: new AbortController().signal }),
      ),
      [{ type: "text-delta", text: "文本" }, { type: "done" }],
    );
  } finally {
    await server.close();
  }
});

test("HTTP、重定向和内容类型错误不泄露响应正文", async () => {
  const sentinel = "sentinel-response-secret";
  const scenarios = [
    { status: 401, chunks: [{ data: sentinel }] },
    {
      status: 302,
      headers: { location: "https://redirect.invalid/v1" },
      chunks: [{ data: sentinel }],
    },
    {
      headers: { "content-type": "application/json" },
      chunks: [{ data: sentinel }],
    },
  ] as const;

  for (const scenario of scenarios) {
    const server = await startOpenAIMockServer(() => scenario);
    try {
      const provider = new OpenAICompatibleProvider({
        model: "test-model",
        baseUrl: server.baseUrl,
        apiKey: "test-secret",
      });
      await assert.rejects(
        collect(provider.stream([], { signal: new AbortController().signal })),
        (error: unknown) => {
          assert.ok(error instanceof ProviderError);
          assert.equal(error.message.includes(sentinel), false);
          return true;
        },
      );
    } finally {
      await server.close();
    }
  }
});

test("非法 JSON、非法结构、完成后事件和缺少完成标记均失败", async () => {
  const scenarios = [
    "data: not-json\n\n" + DONE_EVENT,
    'data: {"invalid":true}\n\n' + DONE_EVENT,
    DONE_EVENT + textDelta("late"),
    textDelta("truncated"),
  ];

  for (const scenario of scenarios) {
    const server = await startOpenAIMockServer(() => ({
      chunks: [{ data: scenario }],
    }));
    try {
      const provider = new OpenAICompatibleProvider({
        model: "test-model",
        baseUrl: server.baseUrl,
        apiKey: "test-secret",
      });
      await assert.rejects(
        collect(provider.stream([], { signal: new AbortController().signal })),
        ProviderError,
      );
    } finally {
      await server.close();
    }
  }
});

test("流截断和用户取消分别归类", async () => {
  const truncatedServer = await startOpenAIMockServer(() => ({
    chunks: [{ data: textDelta("partial") }],
    destroyAfterChunks: true,
  }));
  try {
    const provider = new OpenAICompatibleProvider({
      model: "test-model",
      baseUrl: truncatedServer.baseUrl,
      apiKey: "test-secret",
    });
    await assert.rejects(
      collect(provider.stream([], { signal: new AbortController().signal })),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.kind, "stream");
        return true;
      },
    );
  } finally {
    await truncatedServer.close();
  }

  const cancelServer = await startOpenAIMockServer(() => ({
    chunks: [
      { data: textDelta("partial") },
      { data: DONE_EVENT, delayMs: 2_000 },
    ],
  }));
  try {
    const provider = new OpenAICompatibleProvider({
      model: "test-model",
      baseUrl: cancelServer.baseUrl,
      apiKey: "test-secret",
    });
    const controller = new AbortController();
    const iterator = provider
      .stream([], { signal: controller.signal })
      [Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, "text-delta");
    controller.abort();
    await assert.rejects(iterator.next(), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.kind, "cancelled");
      return true;
    });
  } finally {
    await cancelServer.close();
  }
});

test("连接失败被归类为可恢复网络错误", async () => {
  const closedServer = await startOpenAIMockServer(() => ({
    chunks: [{ data: DONE_EVENT }],
  }));
  const closedBaseUrl = closedServer.baseUrl;
  await closedServer.close();

  const provider = new OpenAICompatibleProvider({
    model: "test-model",
    baseUrl: closedBaseUrl,
    apiKey: "test-secret",
  });
  await assert.rejects(
    collect(provider.stream([], { signal: new AbortController().signal })),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.kind, "network");
      assert.equal(error.message.includes("test-secret"), false);
      return true;
    },
  );
});
