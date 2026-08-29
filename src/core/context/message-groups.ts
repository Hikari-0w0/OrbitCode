import { ContextManagementError } from "@/core/context/context-errors";
import type { ManagedContextMessage } from "@/core/context/types";

export type ContextMessageGroup = {
  readonly start: number;
  readonly end: number;
  readonly messages: readonly ManagedContextMessage[];
  readonly originalMessageCount: number;
};

export type ContextTailSelection = {
  readonly older: readonly ManagedContextMessage[];
  readonly recent: readonly ManagedContextMessage[];
  readonly recentMessageCount: number;
  readonly recentTokens: number;
};

export function groupContextMessages(
  messages: readonly ManagedContextMessage[],
): readonly ContextMessageGroup[] {
  const groups: ContextMessageGroup[] = [];
  for (let index = 0; index < messages.length;) {
    const message = messages[index];
    if (!message) break;
    if (message.kind === "tool-result") {
      throw protocolError("工具结果缺少对应的助手工具调用消息。");
    }
    if (message.kind !== "assistant-tool-call") {
      groups.push({
        start: index,
        end: index + 1,
        messages: [message],
        originalMessageCount: isOriginalMessage(message) ? 1 : 0,
      });
      index += 1;
      continue;
    }

    if (message.toolCalls.length === 0) {
      throw protocolError("助手工具调用消息不能为空。");
    }
    const expected = new Set(message.toolCalls.map((call) => call.id));
    if (expected.size !== message.toolCalls.length) {
      throw protocolError("助手工具调用标识重复。");
    }
    const seen = new Set<string>();
    let end = index + 1;
    while (end < messages.length && messages[end]?.kind === "tool-result") {
      const result = messages[end];
      if (!result || result.kind !== "tool-result") break;
      if (!expected.has(result.toolCallId) || seen.has(result.toolCallId)) {
        throw protocolError("工具结果与助手工具调用无法唯一配对。");
      }
      seen.add(result.toolCallId);
      end += 1;
    }
    if (seen.size !== expected.size) {
      throw protocolError("助手工具调用缺少完整结果。");
    }
    groups.push({
      start: index,
      end,
      messages: messages.slice(index, end),
      originalMessageCount: end - index,
    });
    index = end;
  }
  return groups;
}

export function selectRecentContextTail(
  messages: readonly ManagedContextMessage[],
  options: {
    readonly targetTokens: number;
    readonly minimumMessages: number;
    readonly estimate: (messages: readonly ManagedContextMessage[]) => number;
  },
): ContextTailSelection {
  const groups = groupContextMessages(messages);
  let startGroup = groups.length;
  let recentMessageCount = 0;
  let recentTokens = 0;

  while (
    startGroup > 0 &&
    (recentMessageCount < options.minimumMessages ||
      recentTokens < options.targetTokens)
  ) {
    startGroup -= 1;
    const group = groups[startGroup];
    if (!group) break;
    recentMessageCount += group.originalMessageCount;
    recentTokens += options.estimate(group.messages);
  }

  const boundary = groups[startGroup]?.start ?? messages.length;
  return {
    older: messages.slice(0, boundary),
    recent: messages.slice(boundary),
    recentMessageCount,
    recentTokens,
  };
}

function isOriginalMessage(message: ManagedContextMessage): boolean {
  return message.kind !== "summary" && message.kind !== "boundary";
}

function protocolError(message: string): ContextManagementError {
  return new ContextManagementError("capacity", message);
}
