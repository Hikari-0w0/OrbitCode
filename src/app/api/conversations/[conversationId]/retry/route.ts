import { ConversationRepositoryError } from "@/core/conversations/types";
import { parseConversationMutationRequest } from "@/web/chat-contract";
import {
  conversationApiErrorResponse,
  toConversationDetailResponse,
} from "@/web/conversation-http";
import {
  conversationOperationGuard,
  conversationRuntimeManager,
  localConversationStore,
} from "@/web/conversation-store";
import type { GuardedConversationOperation } from "@/web/conversation-operation-guard";
import { assertSameOrigin, readPermissionJsonBody } from "@/web/request-security";

type RouteContext = {
  readonly params: Promise<{ readonly conversationId: string }>;
};

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  let operation: GuardedConversationOperation | undefined;
  try {
    assertSameOrigin(request);
    const { conversationId } = await context.params;
    const body = parseConversationMutationRequest(await readPermissionJsonBody(request));
    operation = await conversationOperationGuard.begin(conversationId, "retry-save");
    const pending = conversationRuntimeManager.pendingSave(conversationId);
    if (!pending || pending.expectedRevision !== body.expectedRevision) {
      throw new ConversationRepositoryError("not-found", "没有可重试的未保存轮次。");
    }
    const result = await localConversationStore.save(pending);
    if (result.status === "conflict") {
      throw new ConversationRepositoryError("conflict", "会话已更新，无法重试旧轮次。");
    }
    conversationRuntimeManager.clearPendingSave(conversationId);
    await localConversationStore.clearTurnMarker(conversationId);
    return Response.json(
      toConversationDetailResponse(result.checkpoint, { availability: "ready" }),
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return conversationApiErrorResponse(error);
  } finally {
    await operation?.finish().catch(() => undefined);
  }
}
