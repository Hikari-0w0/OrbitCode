import { isRecord, safeId } from "@/runtime/memory-validation";
import { WebChatContractError } from "@/web/chat-contract";
export function parseCleanupRequest(value: unknown): readonly {
    id: string;
    expectedRevision: number;
}[] {
    if (!isRecord(value) || Object.keys(value).length !== 1 || !Array.isArray(value.candidates) || !value.candidates.length || value.candidates.length > 100)
        throw new WebChatContractError("请明确选择 1 到 100 个会话。");
    return value.candidates.map(x => { if (!isRecord(x) || Object.keys(x).length !== 2 || !safeId(x.id) || typeof x.expectedRevision !== "number" || !Number.isSafeInteger(x.expectedRevision) || x.expectedRevision < 0)
        throw new WebChatContractError("清理候选无效。"); return { id: x.id, expectedRevision: x.expectedRevision }; });
}
