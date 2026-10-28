import assert from "node:assert/strict";
import test from "node:test";
import { parseRetryAfter, providerRetryDelayMs } from "./provider-retry";

test("Retry-After 解析秒数、HTTP日期与无效值，不保留原始响应正文", () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(parseRetryAfter("2"), 2000);
  assert.equal(parseRetryAfter("0.25"), 250);
  assert.equal(parseRetryAfter(new Date(now + 5000).toUTCString(), now), 5000);
  assert.equal(parseRetryAfter(new Date(now - 5000).toUTCString(), now), 0);
  for (const text of [null, "", "-1", "NaN", "invalid-date"]) assert.equal(parseRetryAfter(text, now), undefined);
  assert.equal(providerRetryDelayMs(1, parseRetryAfter("9999999999999999999999")), undefined);
});

test("退避带抖动并有界，不早于服务端要求，超长等待放弃自动重试", () => {
  assert.equal(providerRetryDelayMs(1, undefined, () => 0), 500);
  assert.equal(providerRetryDelayMs(1, undefined, () => 1), 1000);
  assert.equal(providerRetryDelayMs(3, undefined, () => 0), 2000);
  assert.equal(providerRetryDelayMs(100, undefined, () => 1), 30000);
  assert.equal(providerRetryDelayMs(1, 5000, () => 0), 5000);
  assert.equal(providerRetryDelayMs(1, 60001), undefined);
});
