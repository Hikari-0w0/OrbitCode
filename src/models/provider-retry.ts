const MAX_RETRY_DELAY_MS = 60_000;

export function parseRetryAfter(value: string | null, nowMs = Date.now()): number | undefined {
  if (value === null || !value.trim()) return undefined;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/u.test(text)) return Math.min(Math.ceil(Number(text) * 1000), Number.MAX_SAFE_INTEGER);
  // 非日期文本不借助 Date.parse 的宽松数字解析解释为等待时间。
  if (!/^[A-Za-z]{3}, /u.test(text)) return undefined;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : undefined;
}

export function providerRetryDelayMs(attempt: number, retryAfterMs?: number, random = Math.random): number | undefined {
  const exponential = Math.min(30_000, 1000 * 2 ** Math.min(Math.max(0, attempt - 1), 5));
  const backoff = Math.ceil(exponential * (0.5 + random() * 0.5));
  const delay = Math.max(backoff, retryAfterMs ?? 0);
  // 不提前违反服务端等待要求；超长等待交还调用方，避免占住一次请求。
  return delay <= MAX_RETRY_DELAY_MS ? delay : undefined;
}
