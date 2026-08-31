import { ConfigurationError } from "@/models/config";
import {
  parseConversationCreateRequest,
  type ConversationCatalogResponse,
} from "@/web/chat-contract";
import {
  conversationApiErrorResponse,
  toConversationDetailResponse,
} from "@/web/conversation-http";
import {
  cleanupLegacyContextSessions,
  localConversationStore,
} from "@/web/conversation-store";
import { assertSameOrigin, readPermissionJsonBody } from "@/web/request-security";
import {
  loadWebProviderContext,
  resolveWebProvider,
} from "@/web/server-config";
import {
  loadWorkspaceCatalog,
  resolveWorkspaceBoundary,
} from "@/web/workspace-config";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    await cleanupLegacyContextSessions().catch(() => undefined);
    const response: ConversationCatalogResponse = {
      conversations: await localConversationStore.list(),
    };
    return Response.json(response, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return conversationApiErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body = parseConversationCreateRequest(await readPermissionJsonBody(request));
    const [providerContext, workspaceCatalog] = await Promise.all([
      loadWebProviderContext(),
      loadWorkspaceCatalog(),
    ]);
    resolveWebProvider(providerContext, body.providerId);
    await resolveWorkspaceBoundary(workspaceCatalog, body.workspaceId);
    const checkpoint = await localConversationStore.create({
      providerId: body.providerId,
      workspaceId: body.workspaceId,
      ...(body.title === undefined ? {} : { title: body.title }),
    });
    return Response.json(toConversationDetailResponse(checkpoint, { availability: "ready" }), {
      status: 201,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return Response.json({ error: error.message, code: "invalid-request" }, { status: 400 });
    }
    return conversationApiErrorResponse(error);
  }
}
