import { ContextManager } from "@/core/context/context-manager";
import {
  ConversationRepositoryError,
  type ConversationSummary,
} from "@/core/conversations/types";
import { createChatProvider } from "@/models/provider-factory";
import {
  parseConversationMutationRequest,
  type ContextCompressionResponse,
} from "@/web/chat-contract";
import { conversationApiErrorResponse } from "@/web/conversation-http";
import {
  conversationOperationGuard,
  localConversationStore,
} from "@/web/conversation-store";
import type { GuardedConversationOperation } from "@/web/conversation-operation-guard";
import { assertSameOrigin, readPermissionJsonBody } from "@/web/request-security";
import { loadWebProviderContext, resolveWebProvider } from "@/web/server-config";

type RouteContext = {
  readonly params: Promise<{ readonly conversationId: string }>;
};

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  let operation: GuardedConversationOperation | undefined;
  try {
    assertSameOrigin(request);
    const { conversationId } = await context.params;
    const body = parseConversationMutationRequest(await readPermissionJsonBody(request));
    const checkpoint = await localConversationStore.load(conversationId);
    if (checkpoint.summary.revision !== body.expectedRevision) {
      throw new ConversationRepositoryError("conflict", "会话已更新，请刷新后重试。");
    }
    operation = await conversationOperationGuard.begin(conversationId, "compress");
    const providerContext = await loadWebProviderContext();
    const providerConfig = resolveWebProvider(providerContext, checkpoint.summary.providerId);
    const provider = createChatProvider(providerConfig);
    const manager = new ContextManager({
      sessionId: conversationId,
      config: providerConfig.context,
      store: localConversationStore,
      provider,
      initialState: checkpoint.context,
    });
    const report: ContextCompressionResponse = await manager.compressManually(
      AbortSignal.any([request.signal, operation.signal]),
    );
    if (report.status === "succeeded") {
      const summary = checkpointSummaryForSave(checkpoint.summary);
      const result = await localConversationStore.save({
        conversationId,
        expectedRevision: body.expectedRevision,
        checkpoint: {
          ...checkpoint,
          summary,
          context: manager.persistentSnapshot(),
        },
      });
      if (result.status === "conflict") {
        throw new ConversationRepositoryError("conflict", "会话已更新，请刷新后重试。");
      }
    }
    return Response.json(report, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return conversationApiErrorResponse(error);
  } finally {
    await operation?.finish().catch(() => undefined);
  }
}

function checkpointSummaryForSave(
  summary: ConversationSummary,
) {
  return {
    schemaVersion: summary.schemaVersion,
    id: summary.id,
    title: summary.title,
    createdAt: summary.createdAt,
    workspaceId: summary.workspaceId,
    providerId: summary.providerId,
    ...(summary.lastStopReason === undefined ? {} : { lastStopReason: summary.lastStopReason }),
  };
}
