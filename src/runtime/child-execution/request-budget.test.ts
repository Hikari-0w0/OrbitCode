import test from "node:test";
import assert from "node:assert/strict";
import { ModelRequestBudget } from "./request-budget";
import { ProviderError, type ChatProvider, type ModelStreamEvent } from "@/models/provider";
import { OpenAICompatibleProvider } from "@/models/openai-provider";
import { parseSubAgentLimits } from "@/core/sub-agents/types";
import { DONE_EVENT, startOpenAIMockServer, textDelta, TEXT_FINISH_EVENT, TRANSPORT_DONE_EVENT, usageEvent } from "../../../tests/helpers/openai-mock";

async function drain(events: AsyncIterable<ModelStreamEvent>) { for await (const event of events) void event; }
const options = () => ({ signal: new AbortController().signal, toolChoice: "none" as const });

test("旧配置补全组预算，新值的整数与上下界由运行时校验", () => {
  assert.equal(parseSubAgentLimits({ perTurn: 4 }).groupRequests, 128);
  assert.equal(parseSubAgentLimits({ groupRequests: 1 }).groupRequests, 1);
  for (const groupRequests of [0, 4097, 1.5, "64"]) {
    assert.throws(() => parseSubAgentLimits({ groupRequests }));
  }
});

test("父子及摘要包装器共享同步接纳，100个并发调用不超发且拒绝不调用Provider", async () => {
  const budget = new ModelRequestBudget("shared", 7); let calls = 0;
  const provider: ChatProvider = { async *stream() { calls++; await Promise.resolve(); yield { type: "done", finishReason: "stop" }; } };
  const wrappers = [budget.wrap(provider), budget.wrap(provider), budget.wrap(provider)];
  const results = await Promise.allSettled(Array.from({ length: 100 }, (_, index) => drain(wrappers[index % 3].stream([], options()))));
  assert.equal(calls, 7); assert.equal(results.filter(result => result.status === "fulfilled").length, 7);
  assert.equal(budget.snapshot().admittedAttempts, 7); assert.equal(budget.snapshot().rejectedRequests, 93);
  assert.equal(budget.snapshot().missingUsageRequests, 7); assert.equal(budget.snapshot().reportedTokens, 0);
  assert.equal(budget.snapshot().unreconciledAttempts, 7); assert.equal(budget.snapshot().inFlight, 0);
});

test("取消前未启动不扣额度，已开始取消和提前结束迭代不退款", async () => {
  const budget = new ModelRequestBudget("cancel", 1), controller = new AbortController(); controller.abort();
  const provider: ChatProvider = { async *stream() { yield { type: "text-delta", text: "部分输出" }; yield { type: "done", finishReason: "stop" }; } };
  const wrapped = budget.wrap(provider);
  await assert.rejects(drain(wrapped.stream([], { ...options(), signal: controller.signal }))); assert.equal(budget.snapshot().admittedAttempts, 0);
  const iterator = wrapped.stream([], options())[Symbol.asyncIterator](); await iterator.next(); await iterator.return?.();
  assert.equal(budget.snapshot().failedRequests, 1); assert.equal(budget.snapshot().missingUsageRequests, 1);
  await assert.rejects(drain(wrapped.stream([], options())), error => error instanceof ProviderError && error.kind === "budget" && !error.retryable);
});

test("OpenAI实际HTTP重试也竞争共享额度，耗尽后不发送下一次请求", async () => {
  const server = await startOpenAIMockServer(() => ({ status: 503, chunks: [] }));
  const budget = new ModelRequestBudget("retry", 2);
  try {
    const provider = budget.wrap(new OpenAICompatibleProvider({ model: "test", baseUrl: server.baseUrl, apiKey: "synthetic", transport: { firstByteTimeoutMs: 1000, idleTimeoutMs: 1000, totalTimeoutMs: 5000, maxRetries: 3 } }));
    await assert.rejects(drain(provider.stream([], options())), error => error instanceof ProviderError && error.kind === "budget");
    assert.equal(server.requests.length, 2); assert.equal(budget.snapshot().logicalRequests, 1); assert.equal(budget.snapshot().admittedAttempts, 2);
    assert.equal(budget.snapshot().failedRequests, 1); assert.equal(budget.snapshot().unreconciledAttempts, 2);
  } finally { await server.close(); }
});

test("重试成功只结算已报告usage，失败尝试的用量保持未结算", async () => {
  let calls = 0;
  const server = await startOpenAIMockServer(() => ++calls === 1 ? { status: 503, chunks: [] } : { chunks: [{ data: textDelta("完成") + TEXT_FINISH_EVENT + usageEvent({ promptTokens: 8, completionTokens: 2, totalTokens: 10 }) + TRANSPORT_DONE_EVENT }] });
  const budget = new ModelRequestBudget("usage", 3);
  try {
    await drain(budget.wrap(new OpenAICompatibleProvider({ model: "test", baseUrl: server.baseUrl, apiKey: "synthetic" })).stream([], options()));
    assert.equal(calls, 2); assert.equal(budget.snapshot().reportedRequests, 1); assert.equal(budget.snapshot().reportedTokens, 10);
    assert.equal(budget.snapshot().unreconciledAttempts, 1); assert.equal(budget.snapshot().missingUsageRequests, 0);
  } finally { await server.close(); }
});

test("完成事件后的异常仍计失败，独立预算不互相消耗", async () => {
  const first = new ModelRequestBudget("first", 1), second = new ModelRequestBudget("second", 1);
  const broken: ChatProvider = { async *stream() { yield { type: "done", finishReason: "stop" }; throw new Error("迟到协议错误"); } };
  await assert.rejects(drain(first.wrap(broken).stream([], options()))); assert.equal(first.snapshot().failedRequests, 1);
  const good: ChatProvider = { async *stream() { yield { type: "text-delta", text: DONE_EVENT }; yield { type: "done", finishReason: "stop" }; } };
  await drain(second.wrap(good).stream([], options())); assert.equal(second.snapshot().admittedAttempts, 1);
  assert.throws(() => new ModelRequestBudget("invalid", 0));
});

test("token不足或Provider不支持输出限制时不发送请求，旧配置可保持关闭", async () => {
  let calls = 0;
  const provider: ChatProvider = { supportsRequestTokenLimit: true, async *stream() { calls++; yield { type: "done", finishReason: "stop" }; } };
  const budget = new ModelRequestBudget("token", 20, 1);
  await assert.rejects(drain(budget.wrap(provider).stream([], options())), error => error instanceof ProviderError && error.kind === "budget");
  assert.equal(calls, 0); assert.equal(budget.snapshot().admittedAttempts, 0);
  const unsupported = new ModelRequestBudget("unsupported", 20, 100000);
  await assert.rejects(drain(unsupported.wrap({ stream: provider.stream }).stream([], options())));
  assert.equal(calls, 0); assert.equal(parseSubAgentLimits({}).groupTokens, 0);
  for (const groupTokens of [-1, 1.5, 1000000001]) assert.throws(() => parseSubAgentLimits({ groupTokens }));
});

test("OpenAI每次重试各自预留，缺失用量保持未知并将输出限制实际发到HTTP", async () => {
  let calls = 0;
  const server = await startOpenAIMockServer(() => ++calls === 1 ? { status: 503, chunks: [] } : { chunks: [{ data: textDelta("完成") + TEXT_FINISH_EVENT + usageEvent({ promptTokens: 8, completionTokens: 2, totalTokens: 10 }) + TRANSPORT_DONE_EVENT }] });
  const budget = new ModelRequestBudget("retry-tokens", 5, 10000);
  try {
    await drain(budget.wrap(new OpenAICompatibleProvider({ model: "test", baseUrl: server.baseUrl, apiKey: "synthetic", maxOutputTokens: 1000 }), 300).stream([], options()));
    assert.equal(server.requests.length, 2);
    assert.ok(server.requests.every(request => typeof request.body === "object" && request.body !== null && "max_tokens" in request.body && request.body.max_tokens === 300));
    const tokens = budget.snapshot().tokens!;
    assert.equal(tokens.reported, 10); assert.ok(tokens.unknown > 300); assert.equal(tokens.reserved, 0);
    assert.equal(tokens.available, tokens.limit - tokens.reported - tokens.unknown);
  } finally { await server.close(); }
});

test("100个并发模型调用按预留额接纳，取消与提前结束保留未知额", async () => {
  const budget = new ModelRequestBudget("concurrent-tokens", 100, 2500);
  let calls = 0;
  const provider: ChatProvider = { supportsRequestTokenLimit: true, async *stream() { calls++; await Promise.resolve(); yield { type: "text-delta", text: "部分输出" }; } };
  const wrapped = budget.wrap(provider, 100);
  const results = await Promise.allSettled(Array.from({ length: 100 }, () => drain(wrapped.stream([], options()))));
  assert.equal(calls, 2); assert.equal(results.filter(result => result.status === "fulfilled").length, 2);
  const tokens = budget.snapshot().tokens!; assert.equal(tokens.reserved, 0); assert.ok(tokens.unknown > 2000); assert.ok(tokens.available < 500);
});
