import { ConfigurationError } from "@/models/config";
import type { ProviderCatalogResponse, WebApiError } from "@/web/chat-contract";
import {
  loadWebProviderContext,
  summarizeProviders,
} from "@/web/server-config";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const context = await loadWebProviderContext();
    const response: ProviderCatalogResponse = {
      providers: summarizeProviders(context),
    };
    return Response.json(response, { headers: noStoreHeaders() });
  } catch (error) {
    const response: WebApiError = {
      error:
        error instanceof ConfigurationError
          ? error.message
          : "无法加载模型配置。",
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
