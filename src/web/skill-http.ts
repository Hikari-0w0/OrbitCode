import type { AgentRuntime } from "@/runtime/agent-runtime";
import { LocalManagementError, assertLocalRequest } from "@/web/local-management-guard";
import { readPermissionJsonBody } from "@/web/request-security";
import { WebChatContractError } from "@/web/chat-contract";
import { conversationApiErrorResponse } from "@/web/conversation-http";
import { ConversationRepositoryError } from "@/core/conversations/types";
import { record } from "@/runtime/skills/definition";
export async function skillHttp(request: Request, conversationId: string, runtime: Pick<AgentRuntime, "inspectSkills" | "deactivateSkill">): Promise<Response> {
    try {
        assertLocalRequest(request);
        if (request.method === "POST") {
            const body: unknown = await readPermissionJsonBody(request);
            if (!record(body) || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0 || Object.keys(body).some(key => !["action", "name", "expectedRevision", "catalogRevision"].includes(key)))
                throw new WebChatContractError("Skill 管理参数无效。");
            if (body.action === "deactivate" && typeof body.name === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(body.name))
                await runtime.deactivateSkill({ conversationId, expectedRevision: Number(body.expectedRevision), name: body.name });
            else if (body.action !== "refresh")
                throw new WebChatContractError("Skill 管理操作无效。");
            else if ((await runtime.inspectSkills(conversationId)).conversationRevision !== body.expectedRevision)
                throw new ConversationRepositoryError("conflict", "会话已更新，请刷新后重试。");
        }
        return Response.json(await runtime.inspectSkills(conversationId), { headers: { "cache-control": "no-store" } });
    }
    catch (error) {
        if (error instanceof LocalManagementError)
            return Response.json({ error: error.message, code: "forbidden" }, { status: 403 });
        return conversationApiErrorResponse(error);
    }
}
