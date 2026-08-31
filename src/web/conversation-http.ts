import { ConversationRepositoryError } from "@/core/conversations/types";
import type { ConversationCheckpoint } from "@/core/conversations/types";
import { ConversationRuntimeError } from "@/web/conversation-runtime-manager";
import {
  WebChatContractError,
  type WebApiError,
  type ConversationDetailResponse,
} from "@/web/chat-contract";
import { WebRequestSecurityError } from "@/web/request-security";

export function conversationApiErrorResponse(error: unknown): Response {
  let status = 500;
  let response: WebApiError = {
    error: "本地会话服务暂时不可用。",
    code: "conversation-storage",
  };
  if (error instanceof WebChatContractError) {
    status = 400;
    response = { error: error.message, code: "invalid-request" };
  } else if (error instanceof WebRequestSecurityError) {
    status = error.kind === "forbidden-origin" ? 403 : 400;
    response = {
      error: error.message,
      code: error.kind === "forbidden-origin" ? "forbidden" : "invalid-request",
    };
  } else if (error instanceof ConversationRuntimeError) {
    status = 409;
    response = { error: error.message, code: "conversation-busy" };
  } else if (error instanceof ConversationRepositoryError) {
    status = error.kind === "not-found"
      ? 404
      : error.kind === "conflict" || error.kind === "busy"
        ? 409
        : error.kind === "invalid-data"
          ? 422
          : 500;
    response = {
      error: error.message,
      code: error.kind === "not-found"
        ? "conversation-not-found"
        : error.kind === "conflict"
          ? "conversation-conflict"
          : error.kind === "busy"
            ? "conversation-busy"
            : "conversation-storage",
    };
  }
  return Response.json(response, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export function toConversationDetailResponse(
  checkpoint: ConversationCheckpoint,
  input: {
    readonly availability: "ready" | "read-only";
    readonly unavailableReason?: string;
    readonly activity?: ConversationDetailResponse["activity"];
  },
): ConversationDetailResponse {
  return {
    schemaVersion: checkpoint.schemaVersion,
    summary: checkpoint.summary,
    mode: checkpoint.mode,
    modeTurn: checkpoint.modeTurn,
    displayMessages: checkpoint.displayMessages,
    availability: input.availability,
    activity: input.activity ?? { status: "idle" },
    ...(input.unavailableReason === undefined
      ? {}
      : { unavailableReason: input.unavailableReason }),
  };
}
