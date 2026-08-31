import { parseConversationMutationRequest } from "@/web/chat-contract";
import {
  conversationApiErrorResponse,
  toConversationDetailResponse,
} from "@/web/conversation-http";
import {
  conversationOperationGuard,
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
    operation = await conversationOperationGuard.begin(conversationId, "clear");
    const result = await localConversationStore.clear({ conversationId, ...body });
    if (result.status === "conflict") {
      return Response.json(
        { error: "会话已在其他页面更新，请刷新后重试。", code: "conversation-conflict" },
        { status: 409 },
      );
    }
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
