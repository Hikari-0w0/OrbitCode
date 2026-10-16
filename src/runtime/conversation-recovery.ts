import type { ManagedContextMessage } from "@/core/context/types";
import { ConversationRepositoryError } from "@/core/conversations/types";
export function pendingToolCalls(messages: readonly ManagedContextMessage[]): readonly string[] {
    const pending = new Set<string>(), seen = new Set<string>();
    for (const message of messages) {
        if (message.kind === "assistant-tool-call") {
            if (pending.size)
                throw new ConversationRepositoryError("invalid-data", "工具 transcript 含歧义。");
            for (const call of message.toolCalls) {
                if (seen.has(call.id))
                    throw new ConversationRepositoryError("invalid-data", "工具调用标识重复。");
                seen.add(call.id);
                pending.add(call.id);
            }
        }
        else if (message.kind === "tool-result") {
            if (!pending.delete(message.toolCallId))
                throw new ConversationRepositoryError("invalid-data", "工具结果没有对应调用。");
        }
        else if (pending.size)
            throw new ConversationRepositoryError("invalid-data", "未完成工具调用后存在其他消息。");
    }
    return [...pending];
}
export function recoverToolCalls(messages: readonly ManagedContextMessage[]): readonly ManagedContextMessage[] {
    const ids = pendingToolCalls(messages);
    if (!ids.length)
        return messages;
    return [...messages, ...ids.map(toolCallId => ({ kind: "tool-result" as const, toolCallId, payload: { storage: "inline" as const, content: JSON.stringify({ ok: false, error: { kind: "cancelled", message: "已中断，执行结果未知。", retryable: false }, sideEffect: "possible" }) } })), { kind: "interruption", reason: "agent-error", detail: "已恢复未完成的工具调用，执行结果未知；继续前核实工作区。", sideEffect: "possible" }];
}
