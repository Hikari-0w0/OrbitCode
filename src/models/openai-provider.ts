import {
  ProviderError,
  type ChatProvider,
  type ConversationMessage,
  type ModelStreamEvent,
  type ModelToolCall,
} from "@/models/provider";
import { parseServerSentEvents, SseError } from "@/models/sse";
import type { ModelToolDefinition } from "@/tools/types";

type OpenAIProviderOptions = {
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetchImplementation?: typeof fetch;
};

type ToolCallAccumulator = {
  readonly id: string;
  readonly name: string;
  readonly argumentsJson: string;
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
          tool_choice: options.toolChoice,
          ...(tools.length > 0 ? { tools, parallel_tool_calls: false } : {}),
        }),
        redirect: "manual",
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal.aborted) {
        throw new ProviderError("cancelled", "模型请求已取消。", { cause: error });
      }
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
    if (!response.body) throw new ProviderError("stream", "模型服务返回了空响应流。");

    let toolCall: ToolCallAccumulator | undefined;
    let modelFinished = false;
    let transportFinished = false;
    try {
      for await (const data of parseServerSentEvents(readResponseBody(response.body))) {
        if (options.signal.aborted) throw new ProviderError("cancelled", "模型请求已取消。");
        if (transportFinished) {
          throw new ProviderError("protocol", "模型服务在完成标记后仍返回了事件。");
        }
        if (data.trim() === "[DONE]") {
          if (!modelFinished) {
            throw new ProviderError("protocol", "模型响应缺少有效的完成原因。");
          }
          transportFinished = true;
          continue;
        }
        if (modelFinished) {
          throw new ProviderError("protocol", "模型在完成原因之后仍返回了数据。");
        }
        const delta = parseOpenAIDelta(data);
        if (!delta) continue;
        if (delta.content !== undefined && delta.content.length > 0) {
          yield { type: "text-delta", text: delta.content };
        }
        if (delta.toolCall !== undefined) {
          if (options.toolChoice === "none") {
            throw new ProviderError("protocol", "模型在禁用工具时仍返回了工具调用。");
          }
          toolCall = appendToolCall(toolCall, delta.toolCall);
        }
        if (delta.finishReason !== undefined) {
          modelFinished = true;
          if (delta.finishReason === "stop") {
            if (toolCall !== undefined) {
              throw new ProviderError("protocol", "工具响应使用了错误的完成原因。");
            }
            yield { type: "done", finishReason: "stop" };
          } else if (delta.finishReason === "tool_calls") {
            if (
              toolCall === undefined ||
              toolCall.id.length === 0 ||
              toolCall.name.length === 0
            ) {
              throw new ProviderError("protocol", "工具调用缺少标识或名称。");
            }
            const call: ModelToolCall = {
              id: toolCall.id,
              name: toolCall.name,
              argumentsJson: toolCall.argumentsJson,
            };
            yield { type: "tool-call", call };
            yield { type: "done", finishReason: "tool-call" };
          } else {
            throw new ProviderError("protocol", "模型响应以非成功原因结束。");
          }
        }
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
    if (!transportFinished) throw new ProviderError("stream", "模型响应缺少完成标记。");
  }
}

function toOpenAIMessage(message: ConversationMessage): Record<string, unknown> {
  if (message.role === "user") return { role: "user", content: message.content };
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
  if (message.content !== null) return { role: "assistant", content: message.content };
  return {
    role: "assistant",
    content: null,
    tool_calls: message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.argumentsJson },
    })),
  };
}

type ParsedDelta = {
  readonly content?: string;
  readonly toolCall?: {
    readonly index: number;
    readonly id?: string;
    readonly name?: string;
    readonly argumentsJson?: string;
  };
  readonly finishReason?: string;
};

function parseOpenAIDelta(data: string): ParsedDelta | undefined {
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
  if (value.choices.length === 0) return undefined;
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
  const toolCalls = choice.delta.tool_calls;
  let toolCall: ParsedDelta["toolCall"];
  if (toolCalls !== undefined) {
    if (!Array.isArray(toolCalls) || toolCalls.length !== 1) {
      throw new ProviderError("protocol", "模型服务返回了多个或无效的工具调用。");
    }
    const raw = toolCalls[0];
    if (!isRecord(raw)) {
      throw new ProviderError("protocol", "模型服务返回了无效的工具调用结构。");
    }
    // 已限定每个分片只有一个调用，兼容部分服务省略单调用索引或返回 null。
    if (raw.index !== undefined && raw.index !== null && raw.index !== 0) {
      throw new ProviderError("protocol", "模型服务返回了无效的工具调用索引。");
    }
    if (raw.id !== undefined && raw.id !== null && typeof raw.id !== "string") {
      throw new ProviderError("protocol", "工具调用标识无效。");
    }
    if (!isRecord(raw.function)) {
      throw new ProviderError("protocol", "工具调用函数结构无效。");
    }
    const name = raw.function.name;
    const argumentsJson = raw.function.arguments;
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
    toolCall = {
      index: 0,
      id: typeof raw.id === "string" ? raw.id : undefined,
      name: typeof name === "string" ? name : undefined,
      argumentsJson: typeof argumentsJson === "string" ? argumentsJson : undefined,
    };
  }
  const finishReason = choice.finish_reason;
  if (finishReason !== undefined && finishReason !== null && typeof finishReason !== "string") {
    throw new ProviderError("protocol", "模型完成原因无效。");
  }
  return {
    content: typeof content === "string" ? content : undefined,
    toolCall,
    finishReason: typeof finishReason === "string" ? finishReason : undefined,
  };
}

function appendToolCall(
  current: ToolCallAccumulator | undefined,
  delta: NonNullable<ParsedDelta["toolCall"]>,
): ToolCallAccumulator {
  if (current === undefined) {
    return {
      id: delta.id ?? "",
      name: delta.name ?? "",
      argumentsJson: delta.argumentsJson ?? "",
    };
  }
  if (delta.id !== undefined && current.id.length > 0 && delta.id !== current.id) {
    throw new ProviderError("protocol", "工具调用标识在流中发生冲突。");
  }
  return {
    id: current.id || delta.id || "",
    name: current.name + (delta.name ?? ""),
    argumentsJson: current.argumentsJson + (delta.argumentsJson ?? ""),
  };
}

function safeRequestId(value: string | null): string | undefined {
  return value !== null && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : undefined;
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
