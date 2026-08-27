import {
  InMemoryConversationSession,
  type TurnEvent,
} from "@/core/conversation";
import {
  ConfigurationError,
  type ResolvedProviderConfig,
} from "@/models/config";
import { createChatProvider } from "@/models/provider-factory";
import type { ConversationMessage } from "@/models/provider";
import {
  encodeWebChatEvent,
  MAX_WEB_CHAT_BODY_BYTES,
  parseWebChatRequest,
  WebChatContractError,
  type WebApiError,
  type WebChatEvent,
} from "@/web/chat-contract";
import {
  loadWebProviderContext,
  resolveWebProvider,
} from "@/web/server-config";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    assertRequestSize(request);
    const body = await readJsonBody(request);
    const chatRequest = parseWebChatRequest(body);
    const context = await loadWebProviderContext();
    const config = resolveWebProvider(context, chatRequest.provider);
    const currentMessage = chatRequest.messages.at(-1);
    if (!currentMessage || currentMessage.role !== "user") {
      throw new WebChatContractError("对话请求必须以用户消息结束。");
    }

    const history = chatRequest.messages.slice(0, -1);
    return streamChatResponse(request, config, history, currentMessage.content);
  } catch (error) {
    return startupErrorResponse(error);
  }
}

function streamChatResponse(
  request: Request,
  config: ResolvedProviderConfig,
  history: readonly ConversationMessage[],
  input: string,
): Response {
  const abortController = new AbortController();
  let consumerClosed = false;
  const abort = (): void => {
    consumerClosed = true;
    abortController.abort();
  };
  request.signal.addEventListener("abort", abort, { once: true });

  const session = new InMemoryConversationSession(
    createChatProvider(config),
    history,
  );
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of session.streamTurn(
          input,
          abortController.signal,
        )) {
          if (consumerClosed) break;
          const webEvent = toWebEvent(event);
          if (webEvent) controller.enqueue(encodeWebChatEvent(webEvent));
        }
      } catch {
        if (!consumerClosed) {
          controller.enqueue(
            encodeWebChatEvent({
              type: "failed",
              message: "模型请求发生未知错误，请重试。",
            }),
          );
        }
      } finally {
        request.signal.removeEventListener("abort", abort);
        if (!consumerClosed) controller.close();
      }
    },
    cancel() {
      abort();
      request.signal.removeEventListener("abort", abort);
    },
  });

  return new Response(stream, {
    headers: {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}

function toWebEvent(event: TurnEvent): WebChatEvent | undefined {
  switch (event.type) {
    case "text-delta":
      return { type: "text-delta", text: event.text };
    case "completed":
      return { type: "completed" };
    case "failed":
      return { type: "failed", message: event.error.message };
    case "cancelled":
      return undefined;
  }
}

function assertRequestSize(request: Request): void {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_WEB_CHAT_BODY_BYTES)
  ) {
    throw new WebChatContractError("对话请求体过大。");
  }
}

async function readJsonBody(request: Request): Promise<unknown> {
  if (!request.body) {
    throw new WebChatContractError("对话请求体不能为空。");
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let source = "";
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_WEB_CHAT_BODY_BYTES) {
        await reader.cancel();
        throw new WebChatContractError("对话请求体过大。");
      }
      source += decoder.decode(result.value, { stream: true });
    }
    source += decoder.decode();
  } catch (error) {
    if (error instanceof WebChatContractError) throw error;
    throw new WebChatContractError("无法读取对话请求体。");
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new WebChatContractError("对话请求必须是有效 JSON。");
  }
}

function startupErrorResponse(error: unknown): Response {
  let status = 500;
  let message = "聊天服务暂时不可用。";
  if (error instanceof WebChatContractError) {
    status = 400;
    message = error.message;
  } else if (error instanceof ConfigurationError) {
    status = error.kind === "config-value" ? 400 : 503;
    message = error.message;
  }
  const response: WebApiError = { error: message };
  return Response.json(response, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
