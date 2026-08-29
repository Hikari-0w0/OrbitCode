import { ContextManagementError } from "@/core/context/context-errors";
import { selectRecentContextTail } from "@/core/context/message-groups";
import {
  approximatePromptTokens,
  approximateTextTokens,
  type TokenEstimator,
} from "@/core/context/token-estimator";
import type { ToolFreeSummaryGenerator } from "@/core/context/tool-free-summary-generator";
import {
  CONTEXT_BOUNDARY_MESSAGE,
  cloneManagedMessages,
  renderContextPayload,
  toConversationMessage,
  type CompressionTrigger,
  type ContextPolicyConfig,
  type ManagedContextMessage,
  type PromptEnvelope,
  type TokenEstimate,
} from "@/core/context/types";

export type HeavyCompactionResult = {
  readonly messages: readonly ManagedContextMessage[];
  readonly before: TokenEstimate;
  readonly after: TokenEstimate;
  readonly retiredReferences: readonly string[];
};

export async function compactOlderHistory(input: {
  readonly messages: readonly ManagedContextMessage[];
  readonly envelope: PromptEnvelope;
  readonly config: ContextPolicyConfig;
  readonly estimator: TokenEstimator;
  readonly generator: ToolFreeSummaryGenerator;
  readonly trigger: CompressionTrigger;
  readonly signal: AbortSignal;
}): Promise<HeavyCompactionResult> {
  const beforeMessages = providerMessages(input.messages, input.envelope);
  const before = input.estimator.estimate(beforeMessages, input.envelope.tools);
  const selection = selectRecentContextTail(input.messages, {
    targetTokens: input.config.recentMessagesTokens,
    minimumMessages: 5,
    estimate: estimateManagedMessages,
  });
  const summaryEvidence = input.messages.filter((message, index) =>
    index < selection.older.length
      ? message.kind !== "boundary"
      : message.kind === "summary",
  );
  const recentOriginal = selection.recent.filter(
    (message) => message.kind !== "summary" && message.kind !== "boundary",
  );
  const replaceable = summaryEvidence.filter(
    (message) => message.kind !== "user",
  );
  if (replaceable.length === 0) {
    throw capacityError("较早历史中没有可由摘要替换的非用户消息。");
  }

  const summaryInputTokens = approximatePromptTokens(
    [
      { role: "system", content: "OrbitCode context summary" },
      {
        role: "user",
        content: JSON.stringify(summaryEvidence.map(toConversationMessage)),
      },
    ],
    [],
  );
  const reserve = input.trigger === "automatic"
    ? input.config.automaticReserveTokens
    : input.config.manualReserveTokens;
  if (summaryInputTokens >= input.config.windowTokens - reserve) {
    throw capacityError("待摘要旧历史超过本次摘要请求的安全预算。");
  }

  const summary = await input.generator.generate(summaryEvidence, input.signal);
  const olderUsers = summaryEvidence.filter(
    (message): message is Extract<ManagedContextMessage, { readonly kind: "user" }> =>
      message.kind === "user",
  );
  const candidate: ManagedContextMessage[] = [
    ...cloneManagedMessages(olderUsers),
    { kind: "summary", summary },
    { kind: "boundary", content: CONTEXT_BOUNDARY_MESSAGE },
    ...cloneManagedMessages(recentOriginal),
  ];
  const afterMessages = providerMessages(candidate, input.envelope);
  const after = input.estimator.estimate(afterMessages, input.envelope.tools);
  if (after.tokens >= before.tokens) {
    throw capacityError("摘要没有产生有效的上下文缩减。");
  }
  if (
    input.trigger === "automatic" &&
    after.tokens >= input.config.windowTokens - input.config.automaticReserveTokens
  ) {
    throw capacityError("摘要后上下文仍超过自动安全预算。");
  }

  const retainedReferences = new Set(contextReferences(candidate));
  const retiredReferences = contextReferences(input.messages).filter(
    (reference) => !retainedReferences.has(reference),
  );
  return { messages: candidate, before, after, retiredReferences };
}

export function providerMessages(
  messages: readonly ManagedContextMessage[],
  envelope: PromptEnvelope,
) {
  return [
    ...envelope.systemMessages,
    ...messages.map(toConversationMessage),
  ];
}

function estimateManagedMessages(
  messages: readonly ManagedContextMessage[],
): number {
  return messages.reduce((total, message) => {
    if (message.kind === "tool-result") {
      return total + approximateTextTokens(renderContextPayload(message.payload));
    }
    return total + approximateTextTokens(JSON.stringify(toConversationMessage(message)));
  }, 0);
}

function contextReferences(
  messages: readonly ManagedContextMessage[],
): string[] {
  return messages.flatMap((message) =>
    message.kind === "tool-result" && message.payload.storage === "offloaded"
      ? [message.payload.reference]
      : [],
  );
}

function capacityError(message: string): ContextManagementError {
  return new ContextManagementError("capacity", message);
}
