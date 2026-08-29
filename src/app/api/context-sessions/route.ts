import { ContextManager } from "@/core/context/context-manager";
import { CONTEXT_SESSION_IDLE_TTL_MS } from "@/web/context-session-manager";
import { createChatProvider } from "@/models/provider-factory";
import {
  parseContextSessionCreateRequest,
  type ContextSessionResponse,
} from "@/web/chat-contract";
import { contextApiErrorResponse } from "@/web/context-http";
import {
  contextSessionManager,
  localContextStore,
} from "@/web/context-session-store";
import { assertSameOrigin, readPermissionJsonBody } from "@/web/request-security";
import {
  loadWebProviderContext,
  resolveWebProvider,
} from "@/web/server-config";
import {
  loadWorkspaceCatalog,
  resolveWorkspaceBoundary,
  WorkspaceCatalogError,
} from "@/web/workspace-config";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body = parseContextSessionCreateRequest(
      await readPermissionJsonBody(request),
    );
    const [providerContext, workspaceCatalog] = await Promise.all([
      loadWebProviderContext(),
      loadWorkspaceCatalog(),
    ]);
    const config = resolveWebProvider(providerContext, body.provider);
    await resolveWorkspaceBoundary(workspaceCatalog, body.workspaceId);
    const workspace = workspaceCatalog.entries.find(
      (entry) => entry.id === body.workspaceId,
    );
    if (!workspace) {
      throw new WorkspaceCatalogError(
        "unknown-workspace",
        "选择的 Workspace 未经服务端授权。",
      );
    }
    await localContextStore.cleanupExpiredSessions({
      olderThanMs: CONTEXT_SESSION_IDLE_TTL_MS,
      protectedSessionIds: contextSessionManager.sessionIds(),
    });
    const binding = {
      workspace: { id: workspace.id, name: workspace.name },
      providerId: body.provider,
    } as const;
    const session = contextSessionManager.createSession({
      binding,
      createRuntime: (sessionId) => {
        const provider = createChatProvider(config);
        return {
          provider,
          store: localContextStore,
          context: new ContextManager({
            sessionId,
            config: config.context,
            store: localContextStore,
            provider,
          }),
        };
      },
    });
    const response: ContextSessionResponse = {
      sessionId: session.id,
      provider: session.binding.providerId,
      workspaceId: session.binding.workspace.id,
    };
    return Response.json(response, {
      status: 201,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return contextApiErrorResponse(error);
  }
}
