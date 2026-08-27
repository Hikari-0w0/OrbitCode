import { SingleToolAgent } from "@/core/single-tool-agent";
import { ConfigurationError } from "@/models/config";
import { createChatProvider } from "@/models/provider-factory";
import { createDefaultToolRegistry } from "@/tools/default-registry";
import { MacOsSeatbeltCommandSandbox } from "@/tools/macos-seatbelt-sandbox";
import { createWorkspaceBoundary } from "@/tools/workspace";
import {
  MAX_WEB_CHAT_BODY_BYTES,
  parseWebChatRequest,
  WebChatContractError,
  type WebApiError,
} from "@/web/chat-contract";
import { streamAgentResponse } from "@/web/chat-handler";
import {
  loadWebProviderContext,
  resolveWebProvider,
} from "@/web/server-config";

export const dynamic = "force-dynamic";

const commandSandbox = new MacOsSeatbeltCommandSandbox();

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
    const workspace = await createWorkspaceBoundary(process.cwd());
    const agent = new SingleToolAgent(
      createChatProvider(config),
      createDefaultToolRegistry(commandSandbox),
      workspace,
      chatRequest.messages.slice(0, -1),
    );
    return streamAgentResponse({ request, agent, input: currentMessage.content });
  } catch (error) {
    return startupErrorResponse(error);
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
  if (!request.body) throw new WebChatContractError("对话请求体不能为空。");
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
