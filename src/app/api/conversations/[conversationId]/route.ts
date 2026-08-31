import {
  parseConversationMutationRequest,
  parseConversationRenameRequest,
  type ConversationDetailResponse,
} from "@/web/chat-contract";
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
import { loadWebProviderContext, summarizeProviders } from "@/web/server-config";
import { loadWorkspaceCatalog } from "@/web/workspace-config";

type RouteContext = {
  readonly params: Promise<{ readonly conversationId: string }>;
};

export async function GET(
  _request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { conversationId } = await context.params;
    const checkpoint = await localConversationStore.load(conversationId);
    const activity = await conversationOperationGuard.inspect(conversationId);
    let available = false;
    try {
      const [providerContext, workspaceCatalog] = await Promise.all([
        loadWebProviderContext(),
        loadWorkspaceCatalog(),
      ]);
      const provider = summarizeProviders(providerContext).find(
        (item) => item.name === checkpoint.summary.providerId,
      );
      const workspace = workspaceCatalog.summaries.find(
        (item) => item.id === checkpoint.summary.workspaceId,
      );
      available = provider?.available === true && workspace?.available === true;
    } catch {
      // 历史读取不依赖当前运行配置；配置异常时只关闭继续执行能力。
    }
    const response: ConversationDetailResponse = toConversationDetailResponse(checkpoint, {
      availability: available ? "ready" : "read-only",
      activity,
      ...(available
        ? {}
        : { unavailableReason: "绑定的 Workspace 或 Provider 当前不可用；历史仍可读取。" }),
    });
    return Response.json(response, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return conversationApiErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  let operation: GuardedConversationOperation | undefined;
  try {
    assertSameOrigin(request);
    const { conversationId } = await context.params;
    const body = parseConversationRenameRequest(await readPermissionJsonBody(request));
    operation = await conversationOperationGuard.begin(conversationId, "rename");
    const result = await localConversationStore.rename({ conversationId, ...body });
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

export async function DELETE(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  let operation: GuardedConversationOperation | undefined;
  try {
    assertSameOrigin(request);
    const { conversationId } = await context.params;
    const body = parseConversationMutationRequest(await readPermissionJsonBody(request));
    operation = await conversationOperationGuard.begin(conversationId, "delete");
    await localConversationStore.delete({ conversationId, ...body });
    return new Response(null, { status: 204 });
  } catch (error) {
    return conversationApiErrorResponse(error);
  } finally {
    await operation?.finish().catch(() => undefined);
  }
}
