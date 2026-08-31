import { randomUUID } from "node:crypto";

import type { AgentEvent } from "@/core/agent-events";
import type {
  PersistedDisplayMessage,
  PersistedMessagePart,
  PersistedToolExecution,
} from "@/core/conversations/types";
import { MAX_CONVERSATION_TITLE_LENGTH } from "@/core/conversations/types";

export function deriveConversationTitle(input: string): string {
  const firstLine = input.trim().split(/\r?\n/, 1)[0]?.trim() || "新对话";
  const limit = Math.min(40, MAX_CONVERSATION_TITLE_LENGTH);
  return firstLine.length > limit ? `${firstLine.slice(0, limit - 1)}…` : firstLine;
}

export function appendPersistedTurn(input: {
  readonly previous: readonly PersistedDisplayMessage[];
  readonly userInput: string;
  readonly events: readonly AgentEvent[];
  readonly createId?: () => string;
}): readonly PersistedDisplayMessage[] {
  const terminal = input.events.findLast(
    (event): event is Extract<AgentEvent, { type: "stopped" }> =>
      event.type === "stopped",
  );
  if (!terminal) throw new Error("持久化 Agent 轮次前必须收到停止事件。");

  const createId = input.createId ?? randomUUID;
  const parts: PersistedMessagePart[] = [];
  const toolCalls = new Map<
    string,
    Extract<AgentEvent, { type: "tool-call" }>
  >();
  const toolResults = new Map<
    string,
    Extract<AgentEvent, { type: "tool-result" }>
  >();
  let content = "";
  let usage: PersistedDisplayMessage["usage"];
  let cumulativeUsage: PersistedDisplayMessage["cumulativeUsage"];

  for (const event of input.events) {
    if (event.type === "text-delta") {
      content += event.text;
      const last = parts.at(-1);
      if (last?.type === "text" && last.iteration === event.iteration) {
        parts[parts.length - 1] = { ...last, content: last.content + event.text };
      } else {
        parts.push({ type: "text", iteration: event.iteration, content: event.text });
      }
    } else if (event.type === "tool-call") {
      toolCalls.set(event.call.id, event);
      parts.push({
        type: "tool",
        iteration: event.iteration,
        callId: event.call.id,
      });
    } else if (event.type === "tool-result") {
      toolResults.set(event.callId, event);
    } else if (event.type === "token-usage") {
      usage = event.usage;
      cumulativeUsage = event.cumulative;
    }
  }

  if (content.length === 0 && terminal.finalMessage) {
    content = terminal.finalMessage.content;
    if (content.length > 0) {
      parts.push({
        type: "text",
        iteration: Math.max(1, terminal.iterations),
        content,
      });
    }
  }

  const toolExecutions: PersistedToolExecution[] = [];
  for (const [callId, resultEvent] of toolResults) {
    const callEvent = toolCalls.get(callId);
    if (!callEvent) continue;
    toolExecutions.push({
      iteration: callEvent.iteration,
      sequence: callEvent.sequence,
      callId,
      name: callEvent.call.name,
      argumentsJson: callEvent.call.argumentsJson,
      state: toolState(resultEvent.result),
      result: resultEvent.result,
    });
  }
  const completedToolKeys = new Set(
    toolExecutions.map((tool) => `${tool.iteration}:${tool.callId}`),
  );
  const terminalParts = parts.filter(
    (part) => part.type === "text"
      ? part.content.trim().length > 0
      : completedToolKeys.has(`${part.iteration}:${part.callId}`),
  );
  const assistantState = terminal.reason === "final-response"
    ? "complete"
    : terminal.reason === "cancelled"
      ? "cancelled"
      : "failed";

  return [
    ...input.previous,
    {
      id: createId(),
      role: "user",
      content: input.userInput,
      state: "complete",
    },
    {
      id: createId(),
      role: "assistant",
      content,
      state: assistantState,
      ...(terminal.detail === undefined ? {} : { detail: terminal.detail }),
      ...(terminalParts.length === 0 ? {} : { parts: terminalParts }),
      ...(toolExecutions.length === 0 ? {} : { toolExecutions }),
      ...(usage === undefined ? {} : { usage }),
      ...(cumulativeUsage === undefined ? {} : { cumulativeUsage }),
      stopReason: terminal.reason,
      durationMs: terminal.durationMs,
      verification: terminal.verification ?? {
        status: "unverified",
        checks: [],
        blockers: [],
      },
    },
  ];
}

function toolState(
  result: Extract<AgentEvent, { type: "tool-result" }>["result"],
): PersistedToolExecution["state"] {
  if (result.ok) return "succeeded";
  if (result.error.kind === "timeout") return "timed-out";
  if (result.error.kind === "cancelled") return "cancelled";
  if (result.error.kind === "user-denied") return "skipped";
  return "failed";
}
