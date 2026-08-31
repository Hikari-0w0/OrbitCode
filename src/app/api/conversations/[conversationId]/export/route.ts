import {
  ConversationExportError,
  LocalConversationExporter,
} from "@/lib/local-conversation-exporter";
import { localAgentRunLog } from "@/web/agent-run-log-store";
import { conversationApiErrorResponse } from "@/web/conversation-http";
import { localConversationStore } from "@/web/conversation-store";
import { assertSameOrigin } from "@/web/request-security";

type RouteContext = {
  readonly params: Promise<{ readonly conversationId: string }>;
};

const exporter = new LocalConversationExporter(localAgentRunLog, localConversationStore);

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { conversationId } = await context.params;
    const result = await exporter.createExport(conversationId);
    const content = `${JSON.stringify(result, null, 2)}\n`;
    return new Response(content, {
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="orbitcode-conversation-${conversationId}.json"`,
        "content-length": String(Buffer.byteLength(content, "utf8")),
        "content-type": "application/json; charset=utf-8",
      },
    });
  } catch (error) {
    if (error instanceof ConversationExportError) {
      const status = error.kind === "not-found" ? 404 : error.kind === "invalid-data" ? 422 : 500;
      return Response.json(
        { error: error.message, code: "conversation-storage" },
        { status, headers: { "cache-control": "no-store" } },
      );
    }
    return conversationApiErrorResponse(error);
  }
}
