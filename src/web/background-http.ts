import { isRecord, safeId } from "@/runtime/memory-validation";
import { WebChatContractError } from "@/web/chat-contract";
export type MemoryManagementRequest = {
    action: "enabled";
    enabled: boolean;
} | {
    action: "update" | "delete";
    conversationId: string;
    scope: "user" | "project";
    id: string;
    expectedRevision: string;
    markdown?: string;
};
export function parseMemoryManagementRequest(value: unknown): MemoryManagementRequest {
    if (!isRecord(value))
        throw new WebChatContractError("记忆管理请求无效。");
    if (value.action === "enabled" && typeof value.enabled === "boolean" && Object.keys(value).every(x => ["action", "enabled"].includes(x)))
        return { action: "enabled", enabled: value.enabled };
    if ((value.action !== "update" && value.action !== "delete") || !safeId(value.conversationId) || !safeId(value.id) || !safeId(value.expectedRevision) || (value.scope !== "user" && value.scope !== "project") || Object.keys(value).some(x => !["action", "conversationId", "scope", "id", "expectedRevision", "markdown"].includes(x)) || (value.action === "update" && (typeof value.markdown !== "string" || Buffer.byteLength(value.markdown) > 16000)))
        throw new WebChatContractError("记忆管理参数无效或超限。");
    return { action: value.action, conversationId: value.conversationId, scope: value.scope, id: value.id, expectedRevision: value.expectedRevision, ...(typeof value.markdown === "string" ? { markdown: value.markdown } : {}) };
}
