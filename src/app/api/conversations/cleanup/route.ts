import { webConversationService } from "@/web/agent-runtime";
import { ConversationCleanup } from "@/runtime/conversation-cleanup";
import { assertLocalRequest } from "@/web/local-management-guard";
import { assertSameOrigin, readBoundedJsonBody } from "@/web/request-security";
import { parseCleanupRequest } from "@/web/conversation-cleanup-http";
const cleanup = new ConversationCleanup(webConversationService);
export const dynamic = "force-dynamic";
export async function GET(request: Request) { try {
    assertLocalRequest(request);
    return Response.json({ candidates: await cleanup.preview() }, { headers: { "cache-control": "no-store" } });
}
catch {
    return Response.json({ error: "无法预览会话清理。" }, { status: 400 });
} }
export async function POST(request: Request) { try {
    assertLocalRequest(request);
    assertSameOrigin(request);
    const candidates = parseCleanupRequest(await readBoundedJsonBody(request, 24000));
    return Response.json({ results: await cleanup.execute(candidates, new Date(), request.signal) });
}
catch {
    return Response.json({ error: "无法执行选定会话清理。" }, { status: 400 });
} }
