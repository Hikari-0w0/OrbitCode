import assert from "node:assert/strict";
import test from "node:test";
import { OpenAICompatibleProvider } from "@/models/openai-provider";
import { ProviderError, type ModelStreamEvent } from "@/models/provider";
import { isProviderFailure } from "@/models/provider-failure";
import { startOpenAIMockServer, textDelta, DONE_EVENT, TOOL_FINISH_EVENT, TRANSPORT_DONE_EVENT } from "../../tests/helpers/openai-mock";

const policy = { firstByteTimeoutMs: 2000, idleTimeoutMs: 2000, totalTimeoutMs: 5000, maxRetries: 1 };
const options = () => ({ signal: new AbortController().signal, toolChoice: "none" as const });

for (const [name, failureFrame] of [
  ["异常结构", 'data: {"choices":[{"delta":null}]}\n\n'],
  ["流内限流", 'data: {"error":{"code":"rate_limit_exceeded"}}\n\n'],
] as const) {
  test(`空内容完成后收到${name}保留失败诊断且不重试`, async () => {
    const events: ModelStreamEvent[] = [];
    const finish = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
    const server = await startOpenAIMockServer(() => ({ chunks: [{ data: finish + failureFrame }] }));
    try {
      const provider = new OpenAICompatibleProvider({ model: "fixture", baseUrl: server.baseUrl, apiKey: "fixture-key", transport: policy });
      await assert.rejects(async () => {
        for await (const event of provider.stream([], options())) events.push(event);
      }, ProviderError);
      assert.equal(server.requests.length, 1);
      assert.equal(events.filter(event => event.type === "done").length, 1);
      const failures = events.flatMap(event => event.type === "request-progress" && event.failure ? [event.failure] : []);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].retryable, true);
      assert.equal(failures[0].action, "stop");
    } finally { await server.close(); }
  });
}

test("流内服务错误保留状态分类且不输出正文", async () => {
  const secret = "private-upstream-message";
  const server = await startOpenAIMockServer(() => ({ chunks: [{ data: `data: ${JSON.stringify({ error: { status: 401, message: secret } })}\n\n` }] }));
  const events: ModelStreamEvent[] = [];
  try {
    const provider = new OpenAICompatibleProvider({ model: "fixture", baseUrl: server.baseUrl, apiKey: "fixture-key", transport: policy });
    await assert.rejects(async () => { for await (const event of provider.stream([], options())) events.push(event); }, (error: unknown) => {
      assert.ok(error instanceof ProviderError); assert.equal(error.kind, "http"); assert.equal(error.status, 401); assert.equal(error.retryable, false);
      assert.equal(JSON.stringify(error).includes(secret), false); return true;
    });
    assert.equal(server.requests.length, 1);
    assert.ok(events.some(event => event.type === "request-progress" && "failure" in event));
    assert.equal(JSON.stringify(events).includes(secret), false);
  } finally { await server.close(); }
});

test("首次异常结构有界重试，诊断仍可保留", async () => {
  let requests = 0;
  const server = await startOpenAIMockServer(() => ({ chunks: [{ data: ++requests === 1 ? 'data: {"choices":[{"delta":null}]}\n\n' : textDelta("成功") + DONE_EVENT }] }));
  const events: ModelStreamEvent[] = [];
  try {
    const provider = new OpenAICompatibleProvider({ model: "fixture", baseUrl: server.baseUrl, apiKey: "fixture-key", transport: policy });
    for await (const event of provider.stream([], options())) events.push(event);
    assert.equal(server.requests.length, 2);
    assert.ok(events.some(event => event.type === "text-delta" && event.text === "成功"));
    assert.ok(events.some(event => event.type === "request-progress" && "failure" in event));
  } finally { await server.close(); }
});

test("输出正文后收到流内429不会重放已展示内容", async () => {
  const server = await startOpenAIMockServer(() => ({ chunks: [{ data: textDelta("已显示") + 'data: {"error":{"code":"rate_limit_exceeded","message":"private"}}\n\n' }] }));
  const events: ModelStreamEvent[] = [];
  try {
    const provider = new OpenAICompatibleProvider({ model: "fixture", baseUrl: server.baseUrl, apiKey: "fixture-key", transport: policy });
    await assert.rejects(async () => { for await (const event of provider.stream([], options())) events.push(event); }, (error: unknown) => error instanceof ProviderError && error.status === 429);
    assert.equal(server.requests.length, 1);
    assert.equal(events.filter(event => event.type === "text-delta").length, 1);
  } finally { await server.close(); }
});

test("命名error事件被识别为服务错误而非结构错误", async () => {
  const server = await startOpenAIMockServer(() => ({ chunks: [{ data: 'event: error\ndata: {"status":403,"message":"private"}\n\n' }] }));
  try {
    const provider = new OpenAICompatibleProvider({ model: "fixture", baseUrl: server.baseUrl, apiKey: "fixture-key", transport: policy });
    await assert.rejects(async () => { for await (const event of provider.stream([], options())) void event; }, (error: unknown) => error instanceof ProviderError && error.status === 403);
  } finally { await server.close(); }
});

test("持续异常结构耗尽上限，诊断只含类型且旧分片不会执行", async () => {
  const secret = "secret-key-and-content";
  const server = await startOpenAIMockServer(() => ({ chunks: [{ data: `data: ${JSON.stringify({ [secret]: secret, choices: [{ delta: secret }] })}\n\n` }] }));
  const events: ModelStreamEvent[] = [];
  try {
    const provider = new OpenAICompatibleProvider({ model: "fixture", baseUrl: server.baseUrl, apiKey: "fixture-key", transport: policy });
    await assert.rejects(async () => { for await (const event of provider.stream([], options())) events.push(event); }, ProviderError);
    assert.equal(server.requests.length, 2);
    const failures = events.flatMap(event => event.type === "request-progress" && event.failure ? [event.failure] : []);
    assert.deepEqual(failures.map(failure => failure.action), ["retry", "stop"]);
    assert.equal(failures[0].frame?.deltaType, "string");
    assert.ok(failures.every(isProviderFailure));
    assert.equal(JSON.stringify(failures).includes(secret), false);
    assert.equal(events.some(event => event.type === "tool-call"), false);
  } finally { await server.close(); }
});

test("未完成工具参数遇到异常后可重试且不混入旧分片", async () => {
  let requests = 0;
  const chunk = (id: string, args: string) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name: "read_file", arguments: args } }] } }] })}\n\n`;
  const server = await startOpenAIMockServer(() => ({ chunks: [{ data: ++requests === 1
    ? chunk("discarded", '{"path":') + 'data: {"choices":[{"delta":null}]}\n\n'
    : chunk("fresh", '{"path":"README.md"}') + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT }] }));
  const events: ModelStreamEvent[] = [];
  try {
    const provider = new OpenAICompatibleProvider({ model: "fixture", baseUrl: server.baseUrl, apiKey: "fixture-key", transport: policy });
    for await (const event of provider.stream([], { ...options(), toolChoice: "auto", tools: [{ type: "function", function: { name: "read_file", description: "读取", parameters: { type: "object" } } }] })) events.push(event);
    const calls = events.flatMap(event => event.type === "tool-call" ? [event.call] : []);
    assert.equal(server.requests.length, 2); assert.equal(calls.length, 1);
    assert.equal(calls[0].id, "fresh"); assert.equal(calls[0].argumentsJson, '{"path":"README.md"}');
  } finally { await server.close(); }
});

test("明确额度不足不因429状态盲目重试", async () => {
  const server = await startOpenAIMockServer(() => ({ chunks: [{ data: 'data: {"error":{"status":429,"code":"insufficient_quota"}}\n\n' }] }));
  try {
    const provider = new OpenAICompatibleProvider({ model: "fixture", baseUrl: server.baseUrl, apiKey: "fixture-key", transport: policy });
    await assert.rejects(async () => { for await (const event of provider.stream([], options())) void event; }, (error: unknown) => error instanceof ProviderError && error.status === 429 && !error.retryable);
    assert.equal(server.requests.length, 1);
  } finally { await server.close(); }
});

test("重试前取消异常响应的读取，不遗留旧连接", async () => {
  let requests = 0;
  let cancelled = 0;
  const provider = new OpenAICompatibleProvider({ model: "fixture", baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture-key", transport: policy,
    fetchImplementation: async () => ++requests === 1
      ? new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":null}]}\n\n')); }, cancel() { cancelled += 1; } }), { headers: { "content-type": "text/event-stream" } })
      : new Response(textDelta("成功") + DONE_EVENT, { headers: { "content-type": "text/event-stream" } }),
  });
  for await (const event of provider.stream([], options())) void event;
  assert.equal(requests, 2); assert.equal(cancelled, 1);
});
