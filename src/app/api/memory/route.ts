import { webAgentRuntime } from "@/web/agent-runtime";
import { assertLocalRequest } from "@/web/local-management-guard";
import { assertSameOrigin, readBoundedJsonBody } from "@/web/request-security";
import { parseMemoryManagementRequest } from "@/web/background-http";
export async function POST(request: Request) {
    try {
        assertLocalRequest(request);
        assertSameOrigin(request);
        const body = parseMemoryManagementRequest(await readBoundedJsonBody(request, 24000));
        if (body.action === "enabled")
            await webAgentRuntime.memory.setEnabled(body.enabled);
        else {
            const store = (await webAgentRuntime.memoryStoresFor(body.conversationId))[body.scope];
            await store.update(body.expectedRevision, body.id, body.action === "delete" ? null : body.markdown ?? "");
        }
        return Response.json({ status: "saved" });
    }
    catch {
        return Response.json({ error: "记忆操作失败，请核对内容、作用域和修订后重试。" }, { status: 400 });
    }
}
