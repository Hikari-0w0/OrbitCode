import { ConversationRepositoryError, type ConversationSummary } from "@/core/conversations/types";
import type { ConversationService } from "@/runtime/conversation-service";
import { pendingToolCalls } from "@/runtime/conversation-recovery";
export const SESSION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
export type CleanupCandidate = {
    summary: ConversationSummary;
    eligible: boolean;
    reason: string;
};
export type CleanupResult = {
    id: string;
    status: "deleted" | "skipped" | "failed";
    reason: string;
};
export class ConversationCleanup {
    constructor(private readonly conversations: ConversationService) { }
    async preview(now = new Date()): Promise<readonly CleanupCandidate[]> {
        const result: CleanupCandidate[] = [];
        for (const summary of await this.conversations.list()) {
            let reason = "已至少 30 天未更新。", eligible = true;
            const stamp = Date.parse(summary.updatedAt);
            if (!Number.isFinite(stamp) || stamp > now.getTime()) {
                eligible = false;
                reason = "更新时间无效或来自未来。";
            }
            else if (now.getTime() - stamp < SESSION_EXPIRY_MS) {
                eligible = false;
                reason = "尚未达到 30 天。";
            }
            else
                try {
                    if (this.conversations.manager.pendingSave(summary.id)) {
                        eligible = false;
                        reason = "有待重试保存的结果。";
                    }
                    else if ((await this.conversations.guard.inspect(summary.id)).status !== "idle") {
                        eligible = false;
                        reason = "正在运行或待恢复。";
                    }
                    else if (pendingToolCalls((await this.conversations.load(summary.id)).context.messages).length) {
                        eligible = false;
                        reason = "有待恢复工具调用。";
                    }
                }
                catch {
                    eligible = false;
                    reason = "会话状态无法检查。";
                }
            result.push({ summary, eligible, reason });
        }
        return result;
    }
    async execute(candidates: readonly {
        id: string;
        expectedRevision: number;
    }[], now = new Date(), signal?: AbortSignal): Promise<readonly CleanupResult[]> {
        if (candidates.length > 100 || new Set(candidates.map(x => x.id)).size !== candidates.length)
            throw new Error("清理最多选择 100 个不同会话。");
        const result: CleanupResult[] = [];
        for (const item of candidates) {
            if (signal?.aborted) {
                result.push({ id: item.id, status: "skipped", reason: "清理已取消。" });
                continue;
            }
            try {
                await this.conversations.deleteExpired({ conversationId: item.id, expectedRevision: item.expectedRevision }, now.getTime() - SESSION_EXPIRY_MS);
                result.push({ id: item.id, status: "deleted", reason: "会话已删除。" });
            }
            catch (error) {
                const skipped = error instanceof ConversationRepositoryError && ["busy", "conflict", "not-found"].includes(error.kind);
                result.push({ id: item.id, status: skipped ? "skipped" : "failed", reason: skipped ? error.message : "删除失败；请检查本地会话状态。" });
            }
        }
        return result;
    }
}
