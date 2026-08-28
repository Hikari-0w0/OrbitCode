import type { WebApiError, WorkspaceCatalogResponse } from "@/web/chat-contract";
import {
  loadWorkspaceCatalog,
  WorkspaceCatalogError,
} from "@/web/workspace-config";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const catalog = await loadWorkspaceCatalog();
    const response: WorkspaceCatalogResponse = {
      workspaces: catalog.summaries,
      defaultWorkspaceId: catalog.defaultWorkspaceId,
    };
    return Response.json(response, { headers: noStoreHeaders() });
  } catch (error) {
    const response: WebApiError = {
      error:
        error instanceof WorkspaceCatalogError
          ? error.message
          : "无法加载 Workspace 列表。",
      code: "workspace-config",
    };
    return Response.json(response, {
      status: 503,
      headers: noStoreHeaders(),
    });
  }
}

function noStoreHeaders(): HeadersInit {
  return { "cache-control": "no-store" };
}
