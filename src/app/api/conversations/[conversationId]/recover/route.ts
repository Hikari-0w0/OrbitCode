import { parseConversationMutationRequest } from "@/web/chat-contract";
import {
  conversationApiErrorResponse,
  toConversationDetailResponse,
} from "@/web/conversation-http";
import type { GuardedConversationOperation } from "@/web/conversation-operation-guard";
import {
  conversationOperationGuard,
  localConversationStore,
} from "@/web/conversation-store";
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
    operation = await conversationOperationGuard.begin(conversationId, "recover");
    const current = await localConversationStore.load(conversationId);
    if (current.summary.revision !== body.expectedRevision) {
      return Response.json(
        { error: "会话已在其他页面更新，请刷新后重试。", code: "conversation-conflict" },
        { status: 409, headers: { "cache-control": "no-store" } },
      );
    }
    const checkpoint = await localConversationStore.recoverInterruptedTurn(
      conversationId,
      operation.lease,
    );
    return Response.json(
      toConversationDetailResponse(checkpoint, {
        availability: "ready",
        activity: { status: "idle" },
      }),
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return conversationApiErrorResponse(error);
  } finally {
    await operation?.finish().catch(() => undefined);
  }
}
