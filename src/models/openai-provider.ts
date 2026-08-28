import {
  ProviderError,
  type ChatProvider,
  type ConversationMessage,
  type ModelStreamEvent,
  type ModelTokenUsage,
  type ModelToolCall,
  type PromptCacheUsage,
} from "@/models/provider";
import { parseServerSentEvents, SseError } from "@/models/sse";
import type { ModelToolDefinition } from "@/tools/types";

const MAX_MODEL_TOOL_CALLS = 16;
const MAX_MODEL_TOOL_ARGUMENTS_LENGTH = 64 * 1024;
const SAFE_TOOL_CALL_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

type OpenAIProviderOptions = {
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetchImplementation?: typeof fetch;
};

type ToolCallAccumulator = {
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly argumentsJson: string;
};

type ParsedToolCallDelta = {
  readonly index: number;
  readonly id?: string;
  readonly name?: string;
  readonly argumentsJson?: string;
};

type ParsedEvent = {
  readonly content?: string;
  readonly toolCalls: readonly ParsedToolCallDelta[];
  readonly finishReason?: string;
  readonly usage?: ModelTokenUsage;
};

export class OpenAICompatibleProvider implements ChatProvider {
  private readonly model: string;
  private readonly endpoint: URL;
  private readonly apiKey: string;
  private readonly fetchImplementation: typeof fetch;

  constructor({
    model,
    baseUrl,
    apiKey,
    fetchImplementation = fetch,
  }: OpenAIProviderOptions) {
    this.model = model;
    this.endpoint = new URL(`${baseUrl.replace(/\/+$/, "")}/chat/completions`);
    this.apiKey = apiKey;
    this.fetchImplementation = fetchImplementation;
  }

  async *stream(
    messages: readonly ConversationMessage[],
    options: {
      readonly signal: AbortSignal;
      readonly tools?: readonly ModelToolDefinition[];
      readonly toolChoice: "auto" | "none";
    },
  ): AsyncIterable<ModelStreamEvent> {
    const tools = options.tools ?? [];
    if (options.toolChoice === "auto" && tools.length === 0) {
      throw new ProviderError("protocol", "启用工具选择时必须提供工具定义。");
    }

    let response: Response;
    try {
      response = await this.fetchImplementation(this.endpoint, {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: messages.map(toOpenAIMessage),
          stream: true,
          stream_options: { include_usage: true },
          tool_choice: options.toolChoice,
          ...(tools.length > 0
            ? { tools, parallel_tool_calls: true }
            : {}),
        }),
        redirect: "manual",
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal.aborted) {
        throw new ProviderError("cancelled", "模型请求已取消。", { cause: error });
      }
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("network", "无法连接模型服务，请检查网络和地址。", {
        cause: error,
      });
    }

    if (!response.ok) {
      throw new ProviderError("http", `模型服务返回 HTTP ${response.status}。`, {
        status: response.status,
        requestId: safeRequestId(response.headers.get("x-request-id")),
      });
    }
    const contentType = response.headers.get("content-type")?.toLowerCase();
    if (!contentType?.startsWith("text/event-stream")) {
      throw new ProviderError("protocol", "模型服务未返回 SSE 响应。");
    }
    if (!response.body) {
      throw new ProviderError("stream", "模型服务返回了空响应流。");
    }

    const toolCalls = new Map<number, ToolCallAccumulator>();
    let modelFinished = false;
    let transportFinished = false;
    let latestUsage: ModelTokenUsage | undefined;

    try {
      for await (const data of parseServerSentEvents(readResponseBody(response.body))) {
        if (options.signal.aborted) {
          throw new ProviderError("cancelled", "模型请求已取消。");
        }
        if (transportFinished) {
          throw new ProviderError("protocol", "模型服务在完成标记后仍返回了事件。");
        }
        if (data.trim() === "[DONE]") {
          if (!modelFinished) {
            throw new ProviderError("protocol", "模型响应缺少有效的完成原因。");
          }
          if (latestUsage !== undefined) {
            yield { type: "usage", usage: latestUsage };
          }
          transportFinished = true;
          continue;
        }

        const event = parseOpenAIEvent(data);
        if (modelFinished && eventHasModelData(event)) {
          throw new ProviderError("protocol", "模型在完成原因之后仍返回了数据。");
        }
        if (event.usage !== undefined) {
          latestUsage = acceptCumulativeUsage(latestUsage, event.usage);
        }
        if (event.content !== undefined && event.content.length > 0) {
          yield { type: "text-delta", text: event.content };
        }
        for (const delta of event.toolCalls) {
          if (options.toolChoice === "none") {
            throw new ProviderError("protocol", "模型在禁用工具时仍返回了工具调用。");
          }
          appendToolCall(toolCalls, delta);
        }
        if (event.finishReason === undefined) continue;

        modelFinished = true;
        if (event.finishReason === "stop") {
          if (toolCalls.size > 0) {
            throw new ProviderError("protocol", "工具响应使用了错误的完成原因。");
          }
          yield { type: "done", finishReason: "stop" };
          continue;
        }
        if (event.finishReason !== "tool_calls") {
          throw new ProviderError("protocol", "模型响应以非成功原因结束。");
        }
        const completedCalls = completeToolCalls(toolCalls);
        for (const call of completedCalls) {
          yield { type: "tool-call", call };
        }
        yield { type: "done", finishReason: "tool-call" };
      }
    } catch (error) {
      if (options.signal.aborted) {
        throw new ProviderError("cancelled", "模型请求已取消。", { cause: error });
      }
      if (error instanceof ProviderError) throw error;
      if (error instanceof SseError) {
        throw new ProviderError("stream", error.message, { cause: error });
      }
      throw new ProviderError("stream", "读取模型响应流失败。", { cause: error });
    }

    if (!transportFinished) {
      throw new ProviderError("stream", "模型响应缺少完成标记。");
    }
  }
}

function toOpenAIMessage(message: ConversationMessage): Record<string, unknown> {
  if (message.role === "system") {
    return { role: "system", content: message.content };
  }
  if (message.role === "user") {
    return { role: "user", content: message.content };
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
  if (!("toolCalls" in message)) {
    return { role: "assistant", content: message.content };
  }
  if (message.toolCalls.length === 0) {
    throw new ProviderError("protocol", "助手工具消息必须包含至少一个工具调用。");
  }
  return {
    role: "assistant",
    content: message.content,
    tool_calls: message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.argumentsJson },
    })),
  };
}

function parseOpenAIEvent(data: string): ParsedEvent {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch (error) {
    throw new ProviderError("protocol", "模型服务返回了无效的 JSON 增量。", {
      cause: error,
    });
  }
  if (!isRecord(value) || !Array.isArray(value.choices)) {
    throw new ProviderError("protocol", "模型服务返回了无效的增量结构。");
  }

  const usage = value.usage === undefined || value.usage === null
    ? undefined
    : parseUsage(value.usage);
  if (value.choices.length === 0) {
    return { toolCalls: [], usage };
  }
  if (value.choices.length !== 1) {
    throw new ProviderError("protocol", "模型服务返回了多个响应选项。");
  }

  const choice = value.choices[0];
  if (!isRecord(choice) || !isRecord(choice.delta)) {
    throw new ProviderError("protocol", "模型服务返回了无效的增量结构。");
  }
  const content = choice.delta.content;
  if (content !== undefined && content !== null && typeof content !== "string") {
    throw new ProviderError("protocol", "模型服务返回了非文本增量。");
  }

  const rawToolCalls = choice.delta.tool_calls;
  const toolCallDeltas: ParsedToolCallDelta[] = [];
  if (rawToolCalls !== undefined) {
    if (!Array.isArray(rawToolCalls) || rawToolCalls.length === 0) {
      throw new ProviderError("protocol", "模型服务返回了无效的工具调用。");
    }
    if (rawToolCalls.length > MAX_MODEL_TOOL_CALLS) {
      throw new ProviderError("protocol", "模型单次返回的工具调用过多。");
    }
    for (const [position, raw] of rawToolCalls.entries()) {
      toolCallDeltas.push(
        parseToolCallDelta(raw, rawToolCalls.length === 1 ? 0 : position),
      );
    }
  }

  const finishReason = choice.finish_reason;
  if (
    finishReason !== undefined &&
    finishReason !== null &&
    typeof finishReason !== "string"
  ) {
    throw new ProviderError("protocol", "模型完成原因无效。");
  }
  return {
    content: typeof content === "string" ? content : undefined,
    toolCalls: toolCallDeltas,
    finishReason: typeof finishReason === "string" ? finishReason : undefined,
    usage,
  };
}

function parseToolCallDelta(
  value: unknown,
  fallbackIndex: number,
): ParsedToolCallDelta {
  if (!isRecord(value)) {
    throw new ProviderError("protocol", "模型服务返回了无效的工具调用结构。");
  }
  if (value.type !== undefined && value.type !== null && value.type !== "function") {
    throw new ProviderError("protocol", "模型服务返回了不支持的工具调用类型。");
  }
  const index = value.index === undefined || value.index === null
    ? fallbackIndex
    : value.index;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
    throw new ProviderError("protocol", "模型服务返回了无效的工具调用索引。");
  }
  if (index >= MAX_MODEL_TOOL_CALLS) {
    throw new ProviderError("protocol", "模型单次返回的工具调用过多。");
  }
  if (value.id !== undefined && value.id !== null && typeof value.id !== "string") {
    throw new ProviderError("protocol", "工具调用标识无效。");
  }
  if (!isRecord(value.function)) {
    throw new ProviderError("protocol", "工具调用函数结构无效。");
  }
  const name = value.function.name;
  const argumentsJson = value.function.arguments;
  if (name !== undefined && name !== null && typeof name !== "string") {
    throw new ProviderError("protocol", "工具调用名称增量无效。");
  }
  if (
    argumentsJson !== undefined &&
    argumentsJson !== null &&
    typeof argumentsJson !== "string"
  ) {
    throw new ProviderError("protocol", "工具调用参数增量无效。");
  }
  return {
    index,
    id: typeof value.id === "string" ? value.id : undefined,
    name: typeof name === "string" ? name : undefined,
    argumentsJson: typeof argumentsJson === "string" ? argumentsJson : undefined,
  };
}

function appendToolCall(
  accumulators: Map<number, ToolCallAccumulator>,
  delta: ParsedToolCallDelta,
): void {
  const current = accumulators.get(delta.index);
  if (current === undefined) {
    if (accumulators.size >= MAX_MODEL_TOOL_CALLS) {
      throw new ProviderError("protocol", "模型单次返回的工具调用过多。");
    }
    accumulators.set(delta.index, {
      index: delta.index,
      id: delta.id ?? "",
      name: delta.name ?? "",
      argumentsJson: delta.argumentsJson ?? "",
    });
    return;
  }
  if (delta.id !== undefined && current.id.length > 0 && delta.id !== current.id) {
    throw new ProviderError("protocol", "工具调用标识在流中发生冲突。");
  }
  const argumentsJson = current.argumentsJson + (delta.argumentsJson ?? "");
  if (argumentsJson.length > MAX_MODEL_TOOL_ARGUMENTS_LENGTH) {
    throw new ProviderError("protocol", "工具调用参数过长。");
  }
  accumulators.set(delta.index, {
    index: current.index,
    id: current.id || delta.id || "",
    name: current.name + (delta.name ?? ""),
    argumentsJson,
  });
}

function completeToolCalls(
  accumulators: ReadonlyMap<number, ToolCallAccumulator>,
): readonly ModelToolCall[] {
  if (accumulators.size === 0) {
    throw new ProviderError("protocol", "工具完成响应没有包含工具调用。");
  }
  const ordered = [...accumulators.values()].sort((left, right) => left.index - right.index);
  const ids = new Set<string>();
  return ordered.map((call, position) => {
    if (call.index !== position) {
      throw new ProviderError("protocol", "工具调用索引不连续。");
    }
    if (!SAFE_TOOL_CALL_ID.test(call.id) || !SAFE_TOOL_NAME.test(call.name)) {
      throw new ProviderError("protocol", "工具调用标识或名称无效。");
    }
    if (call.argumentsJson.length > MAX_MODEL_TOOL_ARGUMENTS_LENGTH) {
      throw new ProviderError("protocol", "工具调用参数过长。");
    }
    if (ids.has(call.id)) {
      throw new ProviderError("protocol", "工具调用标识重复。");
    }
    ids.add(call.id);
    return {
      id: call.id,
      name: call.name,
      argumentsJson: call.argumentsJson,
    };
  });
}

function parseUsage(value: unknown): ModelTokenUsage {
  if (!isRecord(value)) {
    throw new ProviderError("protocol", "模型服务返回了无效的 Token 用量。");
  }
  const promptTokens = requireTokenCount(value.prompt_tokens);
  const completionTokens = requireTokenCount(value.completion_tokens);
  const totalTokens = requireTokenCount(value.total_tokens);
  if (promptTokens + completionTokens !== totalTokens) {
    throw new ProviderError("protocol", "模型服务返回了矛盾的 Token 用量。");
  }
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    promptCache: parsePromptCacheUsage(value, promptTokens),
  };
}

type CacheField<T> =
  | { readonly state: "absent" }
  | { readonly state: "invalid" }
  | { readonly state: "valid"; readonly value: T };

function parsePromptCacheUsage(
  usage: Readonly<Record<string, unknown>>,
  promptTokens: number,
): PromptCacheUsage {
  const standard = parseStandardCachedTokens(usage, promptTokens);
  const compatible = parseOptionalCachedTokens(
    usage,
    "prompt_cache_hit_tokens",
    promptTokens,
  );
  const status = parseOptionalCacheHit(usage);
  const fields = [standard, compatible, status];
  if (fields.some((field) => field.state === "invalid")) {
    return { availability: "unavailable" };
  }

  const numericValues = [standard, compatible].flatMap((field) =>
    field.state === "valid" ? [field.value] : [],
  );
  if (
    numericValues.length === 2 &&
    numericValues[0] !== numericValues[1]
  ) {
    return { availability: "unavailable" };
  }
  const numericValue = numericValues[0];
  if (numericValue !== undefined) {
    if (status.state === "valid" && status.value !== (numericValue > 0)) {
      return { availability: "unavailable" };
    }
    return { availability: "tokens", cachedTokens: numericValue };
  }
  if (status.state === "valid") {
    return { availability: "status", hit: status.value };
  }
  return { availability: "unavailable" };
}

function parseStandardCachedTokens(
  usage: Readonly<Record<string, unknown>>,
  promptTokens: number,
): CacheField<number> {
  if (!("prompt_tokens_details" in usage)) return { state: "absent" };
  const details = usage.prompt_tokens_details;
  if (!isRecord(details)) return { state: "invalid" };
  return parseOptionalCachedTokens(details, "cached_tokens", promptTokens);
}

function parseOptionalCachedTokens(
  source: Readonly<Record<string, unknown>>,
  key: string,
  promptTokens: number,
): CacheField<number> {
  if (!(key in source)) return { state: "absent" };
  const value = source[key];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > promptTokens
  ) {
    return { state: "invalid" };
  }
  return { state: "valid", value };
}

function parseOptionalCacheHit(
  usage: Readonly<Record<string, unknown>>,
): CacheField<boolean> {
  if (!("prompt_cache_hit" in usage)) return { state: "absent" };
  return typeof usage.prompt_cache_hit === "boolean"
    ? { state: "valid", value: usage.prompt_cache_hit }
    : { state: "invalid" };
}

function requireTokenCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ProviderError("protocol", "模型服务返回了无效的 Token 用量。");
  }
  return value;
}

function acceptCumulativeUsage(
  current: ModelTokenUsage | undefined,
  next: ModelTokenUsage,
): ModelTokenUsage {
  if (
    current !== undefined &&
    (next.promptTokens < current.promptTokens ||
      next.completionTokens < current.completionTokens ||
      next.totalTokens < current.totalTokens)
  ) {
    throw new ProviderError("protocol", "模型服务返回了递减的 Token 用量。");
  }
  return next;
}

function eventHasModelData(event: ParsedEvent): boolean {
  return (
    event.content !== undefined ||
    event.toolCalls.length > 0 ||
    event.finishReason !== undefined
  );
}

function safeRequestId(value: string | null): string | undefined {
  return value !== null && /^[A-Za-z0-9._-]{1,128}$/.test(value)
    ? value
    : undefined;
}

async function* readResponseBody(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) return;
      yield result.value;
    }
  } finally {
    reader.releaseLock();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
