import { ContextManagementError } from "@/core/context/context-errors";
import { groupContextMessages } from "@/core/context/message-groups";
import { approximateTextTokens } from "@/core/context/token-estimator";
import {
  cloneManagedMessages,
  renderContextPayload,
  type ContextPolicyConfig,
  type ContextStore,
  type ManagedContextMessage,
} from "@/core/context/types";

export type LightweightCompactionResult = {
  readonly messages: readonly ManagedContextMessage[];
  readonly createdReferences: readonly string[];
};

export async function compactToolResults(
  input: {
    readonly messages: readonly ManagedContextMessage[];
    readonly sessionId: string;
    readonly config: ContextPolicyConfig;
    readonly store: ContextStore;
    readonly signal: AbortSignal;
  },
): Promise<LightweightCompactionResult> {
  const messages = cloneManagedMessages(input.messages);
  const createdReferences: string[] = [];
  const groups = groupContextMessages(messages);

  try {
    for (const group of groups) {
      if (group.messages[0]?.kind !== "assistant-tool-call") continue;
      const resultIndexes: number[] = [];
      for (let index = group.start + 1; index < group.end; index += 1) {
        const message = messages[index];
        if (message?.kind === "tool-result") resultIndexes.push(index);
      }

      for (const index of resultIndexes) {
        const result = messages[index];
        if (
          result?.kind === "tool-result" &&
          result.payload.storage === "inline" &&
          approximateTextTokens(result.payload.content) >
            input.config.singleToolResultTokens
        ) {
          const compacted = await offload(result, input, createdReferences);
          messages[index] = compacted;
        }
      }

      while (
        totalResultTokens(messages, resultIndexes) >
        input.config.toolResultGroupTokens
      ) {
        const candidate = resultIndexes
          .map((index) => ({ index, message: messages[index] }))
          .filter(
            (item): item is {
              readonly index: number;
              readonly message: Extract<
                ManagedContextMessage,
                { readonly kind: "tool-result" }
              >;
            } =>
              item.message?.kind === "tool-result" &&
              item.message.payload.storage === "inline",
          )
          .map((item) => ({
            ...item,
            tokens: approximateTextTokens(
              item.message.payload.storage === "inline"
                ? item.message.payload.content
                : "",
            ),
          }))
          .sort((left, right) => right.tokens - left.tokens || left.index - right.index)[0];
        if (!candidate) break;
        messages[candidate.index] = await offload(
          candidate.message,
          input,
          createdReferences,
        );
      }
      shrinkPreviewsToBudget(
        messages,
        resultIndexes,
        input.config.toolResultGroupTokens,
      );
    }
    return { messages, createdReferences };
  } catch (error) {
    await Promise.all(
      createdReferences.map((reference) =>
        input.store.deleteReference({ sessionId: input.sessionId, reference }),
      ),
    );
    if (error instanceof ContextManagementError) throw error;
    throw new ContextManagementError(
      "storage",
      "无法卸载工具结果。",
      { cause: error },
    );
  }
}

function shrinkPreviewsToBudget(
  messages: ManagedContextMessage[],
  indexes: readonly number[],
  budgetTokens: number,
): void {
  const candidates = indexes
    .map((index) => ({ index, message: messages[index] }))
    .filter(
      (item): item is {
        readonly index: number;
        readonly message: Extract<
          ManagedContextMessage,
          { readonly kind: "tool-result" }
        >;
      } => item.message?.kind === "tool-result",
    )
    .filter((item) => item.message.payload.storage === "offloaded")
    .sort((left, right) => {
      const leftLength = left.message.payload.storage === "offloaded"
        ? Array.from(left.message.payload.preview).length
        : 0;
      const rightLength = right.message.payload.storage === "offloaded"
        ? Array.from(right.message.payload.preview).length
        : 0;
      return rightLength - leftLength || left.index - right.index;
    });

  for (const candidate of candidates) {
    if (totalResultTokens(messages, indexes) <= budgetTokens) return;
    if (candidate.message.payload.storage !== "offloaded") continue;
    messages[candidate.index] = {
      ...candidate.message,
      payload: { ...candidate.message.payload, preview: "" },
    };
  }
  if (totalResultTokens(messages, indexes) > budgetTokens) {
    throw new ContextManagementError(
      "capacity",
      "工具结果引用占位本身超过批次上下文预算。",
    );
  }
}

async function offload(
  message: Extract<ManagedContextMessage, { readonly kind: "tool-result" }>,
  input: {
    readonly sessionId: string;
    readonly config: ContextPolicyConfig;
    readonly store: ContextStore;
    readonly signal: AbortSignal;
  },
  createdReferences: string[],
): Promise<ManagedContextMessage> {
  if (message.payload.storage === "offloaded") return message;
  const content = message.payload.content;
  const stored = await input.store.write({
    sessionId: input.sessionId,
    content,
    signal: input.signal,
  });
  createdReferences.push(stored.reference);
  return {
    kind: "tool-result",
    toolCallId: message.toolCallId,
    payload: {
      storage: "offloaded",
      reference: stored.reference,
      preview: createPreview(content, input.config.previewChars),
      originalBytes: stored.byteLength,
      estimatedTokens: approximateTextTokens(content),
    },
  };
}

function totalResultTokens(
  messages: readonly ManagedContextMessage[],
  indexes: readonly number[],
): number {
  return indexes.reduce((total, index) => {
    const message = messages[index];
    return message?.kind === "tool-result"
      ? total + approximateTextTokens(renderContextPayload(message.payload))
      : total;
  }, 0);
}

function createPreview(content: string, maximumCharacters: number): string {
  const characters = Array.from(content);
  if (characters.length <= maximumCharacters) return content;
  const headLength = Math.ceil(maximumCharacters / 2);
  const tailLength = Math.floor(maximumCharacters / 2);
  return [
    characters.slice(0, headLength).join(""),
    "\n…[内容已卸载]…\n",
    characters.slice(characters.length - tailLength).join(""),
  ].join("");
}
