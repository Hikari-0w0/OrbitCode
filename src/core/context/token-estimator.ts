import type { ConversationMessage } from "@/models/provider";
import type { ModelToolDefinition } from "@/tools/types";
import type { TokenEstimate } from "@/core/context/types";

export type TokenEstimatorState = {
  readonly anchor?: {
    readonly promptTokens: number;
    readonly approximateTokens: number;
  };
};

export class TokenEstimator {
  private anchor: TokenEstimatorState["anchor"];

  constructor(state: TokenEstimatorState = {}) {
    this.anchor = state.anchor === undefined ? undefined : { ...state.anchor };
  }

  estimate(
    messages: readonly ConversationMessage[],
    tools: readonly ModelToolDefinition[],
  ): TokenEstimate {
    const approximateTokens = approximatePromptTokens(messages, tools);
    if (!this.anchor) {
      return { source: "approximation", tokens: approximateTokens };
    }
    const estimatedDeltaTokens = approximateTokens - this.anchor.approximateTokens;
    return {
      source: "usage-anchor",
      tokens: Math.max(0, this.anchor.promptTokens + estimatedDeltaTokens),
      anchorPromptTokens: this.anchor.promptTokens,
      estimatedDeltaTokens,
    };
  }

  recordUsage(
    promptTokens: number,
    messages: readonly ConversationMessage[],
    tools: readonly ModelToolDefinition[],
  ): void {
    if (!Number.isSafeInteger(promptTokens) || promptTokens < 0) return;
    this.anchor = {
      promptTokens,
      approximateTokens: approximatePromptTokens(messages, tools),
    };
  }

  snapshot(): TokenEstimatorState {
    return {
      anchor: this.anchor === undefined ? undefined : { ...this.anchor },
    };
  }

  restore(state: TokenEstimatorState): void {
    this.anchor = state.anchor === undefined ? undefined : { ...state.anchor };
  }
}

export function approximatePromptTokens(
  messages: readonly ConversationMessage[],
  tools: readonly ModelToolDefinition[],
): number {
  return approximateTextTokens(JSON.stringify({ messages, tools }));
}

export function approximateTextTokens(content: string): number {
  if (content.length === 0) return 0;
  const codePoints = Array.from(content).length;
  const utf8Bytes = new TextEncoder().encode(content).byteLength;
  return Math.ceil(Math.max(codePoints / 4, utf8Bytes / 4));
}
