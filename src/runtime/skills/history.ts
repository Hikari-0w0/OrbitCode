import { SkillError, type SkillHistory } from "@/core/skills/types";
import type { ManagedContextMessage, ContextStore } from "@/core/context/types";
import { groupContextMessages } from "@/core/context/message-groups";
export async function selectSkillHistory(input: {
    messages: readonly ManagedContextMessage[];
    history: SkillHistory;
    parentId: string;
    childId: string;
    parentStore: ContextStore;
    childStore: ContextStore;
    signal: AbortSignal;
}): Promise<readonly ManagedContextMessage[]> {
    if (input.history.kind === "none")
        return [];
    let messages = structuredClone(input.messages);
    // 当前输入/未完成调用不属于可携带的完整历史，调用方只传入已提交上下文。
    groupContextMessages(messages);
    if (input.history.kind === "recent") {
        const starts = messages.flatMap((message, index) => message.kind === "user" ? [index] : []);
        const compressed = messages.some(message => message.kind === "summary");
        const available = Math.min(starts.length, input.history.turns);
        messages = starts.length ? messages.slice(starts[Math.max(0, starts.length - input.history.turns)]) : [];
        if (compressed || available < input.history.turns) messages = [{ kind: "boundary", content: `独立 Skill 请求最近 ${input.history.turns} 个完整用户回合，实际携带 ${available} 个。${compressed ? "较早历史已压缩，无法恢复为最近回合，本次不携带压缩摘要。" : "可用完整历史不足请求数量。"}` }, ...messages];
    }
    let used = 0;
    const result: ManagedContextMessage[] = [];
    for (const message of messages) {
        input.signal.throwIfAborted();
        if (message.kind === "tool-result" && message.payload.storage === "offloaded") {
            let content = "", offset = 0;
            for (;;) {
                const chunk = await input.parentStore.read({ sessionId: input.parentId, reference: message.payload.reference, offset, limit: 32 * 1024, signal: input.signal });
                used += Buffer.byteLength(chunk.content);
                if (used > 1024 * 1024)
                    throw new SkillError("capacity", "携带历史的资源展开超过 1 MiB，请缩小历史范围。");
                content += chunk.content;
                if (!chunk.hasMore)
                    break;
                if (chunk.nextOffset === null || chunk.nextOffset <= offset)
                    throw new SkillError("execution-failed", "历史引用不可完整读取。");
                offset = chunk.nextOffset;
            }
            const stored = await input.childStore.write({ sessionId: input.childId, content: scrubReferences(content), signal: input.signal });
            result.push({ ...message, payload: { ...message.payload, reference: stored.reference, preview: scrubReferences(message.payload.preview) } });
        }
        else {
            const plain = JSON.stringify(message).replace(/context:\/\/[^\s"<>\\]+/g, "[父会话引用在子会话不可用]");
            used += Buffer.byteLength(plain);
            if (used > 1024 * 1024)
                throw new SkillError("capacity", "携带历史超过 1 MiB。");
            // 只替换字符串中的引用，不改变消息判别字段与工具配对。
            result.push(JSON.parse(plain) as ManagedContextMessage);
        }
    }
    return result;
}
function scrubReferences(content: string): string { return content.replace(/context:\/\/[^\s"<>\\]+/g, "[父会话引用在子会话不可用]"); }
