import {
  ProviderError,
  type ChatProvider,
  type ConversationMessage,
  type ModelStreamEvent,
} from "@/models/provider";
import { parseServerSentEvents, SseError } from "@/models/sse";

type OpenAIProviderOptions = {
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetchImplementation?: typeof fetch;
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
    options: { readonly signal: AbortSignal },
  ): AsyncIterable<ModelStreamEvent> {
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
          messages,
          stream: true,
        }),
        redirect: "manual",
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal.aborted) {
        throw new ProviderError("cancelled", "模型请求已取消。", {
          cause: error,
        });
      }
      throw new ProviderError("network", "无法连接模型服务，请检查网络和地址。", {
        cause: error,
      });
    }

    if (!response.ok) {
      throw new ProviderError(
        "http",
        `模型服务返回 HTTP ${response.status}。`,
        {
          status: response.status,
          requestId: safeRequestId(response.headers.get("x-request-id")),
        },
      );
    }

    const contentType = response.headers.get("content-type")?.toLowerCase();
    if (!contentType?.startsWith("text/event-stream")) {
      throw new ProviderError(
        "protocol",
        "模型服务未返回 SSE 响应。",
      );
    }
    if (!response.body) {
      throw new ProviderError("stream", "模型服务返回了空响应流。");
    }

    let completed = false;
    try {
      for await (const data of parseServerSentEvents(readResponseBody(response.body))) {
        if (options.signal.aborted) {
          throw new ProviderError("cancelled", "模型请求已取消。");
        }
        if (completed) {
          throw new ProviderError(
            "protocol",
            "模型服务在完成标记后仍返回了事件。",
          );
        }
        if (data.trim() === "[DONE]") {
          completed = true;
          yield { type: "done" };
          continue;
        }

        const delta = parseOpenAITextDelta(data);
        if (delta !== undefined && delta.length > 0) {
          yield { type: "text-delta", text: delta };
        }
      }
    } catch (error) {
      if (options.signal.aborted) {
        throw new ProviderError("cancelled", "模型请求已取消。", {
          cause: error,
        });
      }
      if (error instanceof ProviderError) {
        throw error;
      }
      if (error instanceof SseError) {
        throw new ProviderError("stream", error.message, { cause: error });
      }
      throw new ProviderError("stream", "读取模型响应流失败。", {
        cause: error,
      });
    }

    if (!completed) {
      throw new ProviderError("stream", "模型响应缺少完成标记。");
    }
  }
}

function parseOpenAITextDelta(data: string): string | undefined {
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
  if (value.choices.length === 0) {
    return undefined;
  }

  const choice = value.choices[0];
  if (!isRecord(choice) || !isRecord(choice.delta)) {
    throw new ProviderError("protocol", "模型服务返回了无效的增量结构。");
  }

  const content = choice.delta.content;
  if (content === undefined || content === null) {
    return undefined;
  }
  if (typeof content !== "string") {
    throw new ProviderError("protocol", "模型服务返回了非文本增量。");
  }
  return content;
}

function safeRequestId(value: string | null): string | undefined {
  if (value === null || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    return undefined;
  }
  return value;
}

async function* readResponseBody(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        return;
      }
      yield result.value;
    }
  } finally {
    reader.releaseLock();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
