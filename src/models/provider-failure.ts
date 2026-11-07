import type { ProviderFailureKind } from "@/models/provider";

const SHAPES = ["missing", "null", "array", "object", "string", "number", "boolean"] as const;
type Shape = typeof SHAPES[number];
const FRAME_FIELDS = ["jsonType", "choicesType", "choiceType", "deltaType", "contentType", "toolCallsType", "errorType"] as const;

export type ProviderFrameDiagnostic = {
  readonly reason: "invalid-json" | "invalid-chunk" | "server-error";
  readonly eventIndex: number;
  readonly chars: number;
} & Readonly<Record<typeof FRAME_FIELDS[number], Shape>>;

export type ProviderFailure = {
  readonly kind: ProviderFailureKind;
  readonly retryable: boolean;
  readonly action: "retry" | "stop";
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly frame?: ProviderFrameDiagnostic;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shape(value: unknown): Shape {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (record(value)) return "object";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  return "boolean";
}

export function describeProviderFrame(data: string, eventIndex: number, serverError = false): ProviderFrameDiagnostic {
  let value: unknown;
  let validJson = true;
  try { value = JSON.parse(data); } catch { validJson = false; }
  const choices = record(value) ? value.choices : undefined;
  const choice: unknown = Array.isArray(choices) ? choices[0] : undefined;
  const delta = record(choice) ? choice.delta : undefined;
  // 只记录固定字段的类型，不收录服务端文本、任意键名、工具参数或异常原文。
  return {
    reason: !validJson ? "invalid-json" : serverError || (record(value) && value.error !== undefined) ? "server-error" : "invalid-chunk",
    eventIndex, chars: data.length,
    jsonType: shape(value), choicesType: shape(choices), choiceType: shape(choice), deltaType: shape(delta),
    contentType: shape(record(delta) ? delta.content : undefined),
    toolCallsType: shape(record(delta) ? delta.tool_calls : undefined),
    errorType: shape(record(value) ? value.error : undefined),
  };
}

export function isProviderFailure(value: unknown): value is ProviderFailure {
  if (!record(value) || Object.keys(value).some(key => !["kind", "retryable", "action", "status", "retryAfterMs", "frame"].includes(key))) return false;
  if (!["network", "http", "protocol", "stream", "timeout", "budget", "cancelled"].includes(String(value.kind)) ||
    typeof value.retryable !== "boolean" || (value.action !== "retry" && value.action !== "stop")) return false;
  if (value.status !== undefined && (typeof value.status !== "number" || !Number.isInteger(value.status) || value.status < 100 || value.status > 599)) return false;
  if (value.retryAfterMs !== undefined && (typeof value.retryAfterMs !== "number" || !Number.isSafeInteger(value.retryAfterMs) || value.retryAfterMs < 0)) return false;
  if (value.frame === undefined) return true;
  const frame = value.frame;
  return record(frame) && Object.keys(frame).length === FRAME_FIELDS.length + 3 &&
    Object.keys(frame).every(key => ["reason", "eventIndex", "chars", ...FRAME_FIELDS].includes(key)) &&
    ["invalid-json", "invalid-chunk", "server-error"].includes(String(frame.reason)) &&
    typeof frame.eventIndex === "number" && Number.isSafeInteger(frame.eventIndex) && frame.eventIndex > 0 &&
    typeof frame.chars === "number" && Number.isSafeInteger(frame.chars) && frame.chars >= 0 &&
    FRAME_FIELDS.every(key => SHAPES.some(type => type === frame[key]));
}

export function copyProviderFailure(value: ProviderFailure): ProviderFailure {
  if (!isProviderFailure(value)) throw new Error("模型失败诊断结构无效。");
  return {
    kind: value.kind, retryable: value.retryable, action: value.action,
    ...(value.status === undefined ? {} : { status: value.status }),
    ...(value.retryAfterMs === undefined ? {} : { retryAfterMs: value.retryAfterMs }),
    ...(value.frame === undefined ? {} : { frame: { ...value.frame } }),
  };
}

export function providerStreamErrorStatus(value: unknown): { readonly status?: number; readonly retryable: boolean } {
  if (!record(value)) return { retryable: false };
  const code = typeof value.code === "string" ? value.code : value.type;
  let status: number | undefined;
  for (const candidate of [value.status, value.status_code, value.code]) {
    const number = typeof candidate === "number" ? candidate : typeof candidate === "string" && /^\d{3}$/.test(candidate) ? Number(candidate) : undefined;
    if (number !== undefined && Number.isInteger(number) && number >= 400 && number <= 599) { status = number; break; }
  }
  if (status === undefined) {
    if (code === "rate_limit_exceeded" || code === "rate_limit_error") status = 429;
    else if (code === "server_error" || code === "internal_server_error") status = 500;
    else if (code === "service_unavailable" || code === "overloaded_error") status = 503;
  }
  return { ...(status === undefined ? {} : { status }), retryable: code !== "insufficient_quota" && status !== undefined && (status === 408 || status === 429 || status >= 500) };
}
