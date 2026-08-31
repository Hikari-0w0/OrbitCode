import {
  DEFAULT_OPERATIONAL_COMPACTION_TOKENS,
  DEFAULT_RECENT_TOOL_EXCHANGES,
  cloneManagedMessages,
  type ContextPolicyConfig,
  type ContextStore,
  type ManagedContextMessage,
} from "@/core/context/types";

type Exchange = {
  readonly start: number;
  readonly end: number;
  readonly messages: readonly ManagedContextMessage[];
  readonly toolNames: readonly string[];
  readonly successful: boolean;
  readonly failureSignature?: string;
};

export type OperationalCompactionResult = {
  readonly messages: readonly ManagedContextMessage[];
  readonly createdReferences: readonly string[];
  readonly compactedExchanges: number;
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly rolledBack: boolean;
};

export async function compactOperationalHistory(input: {
  readonly messages: readonly ManagedContextMessage[];
  readonly sessionId: string;
  readonly config: ContextPolicyConfig;
  readonly store: ContextStore;
  readonly signal: AbortSignal;
}): Promise<OperationalCompactionResult> {
  const beforeTokens = approximateTokens(input.messages);
  const threshold = input.config.operationalCompactionTokens ??
    DEFAULT_OPERATIONAL_COMPACTION_TOKENS;
  if (beforeTokens < threshold) return unchanged(input.messages, beforeTokens);

  const exchanges = findCompleteExchanges(input.messages);
  const recentCount = input.config.recentToolExchanges ?? DEFAULT_RECENT_TOOL_EXCHANGES;
  const protectedStarts = new Set(
    exchanges.slice(Math.max(0, exchanges.length - recentCount)).map((item) => item.start),
  );
  const latestFailureStarts = latestRepeatedFailureStarts(exchanges);
  const selected = exchanges.filter((exchange) => {
    if (protectedStarts.has(exchange.start)) return false;
    if (exchange.toolNames.includes("report_completion")) return false;
    if (exchange.successful) return true;
    return exchange.failureSignature !== undefined &&
      !latestFailureStarts.has(exchange.start) &&
      exchanges.filter((candidate) =>
        candidate.failureSignature === exchange.failureSignature
      ).length > 1;
  });
  if (selected.length === 0) return unchanged(input.messages, beforeTokens);

  const replacements = new Map<number, ManagedContextMessage>();
  const createdReferences: string[] = [];
  try {
    for (const exchange of selected) {
      if (input.signal.aborted) throw new Error("cancelled");
      const stored = await input.store.write({
        sessionId: input.sessionId,
        content: JSON.stringify({
          schemaVersion: 1,
          kind: "tool-exchange",
          messages: exchange.messages,
        }),
        signal: input.signal,
      });
      createdReferences.push(stored.reference);
      replacements.set(exchange.start, {
        kind: "boundary",
        content: [
          "<orbitcode_operational_compaction>",
          `tools: ${exchange.toolNames.join(", ")}`,
          `reference: ${stored.reference}`,
          `status: ${exchange.successful ? "completed" : "repeated-failure"}`,
          "较早的完整工具交换已卸载；需要原始参数或结果时使用 read_context 读取引用，不要猜测。",
          "</orbitcode_operational_compaction>",
        ].join("\n"),
      });
    }
  } catch {
    await Promise.all(createdReferences.map((reference) =>
      input.store.deleteReference({ sessionId: input.sessionId, reference })
        .catch(() => undefined)
    ));
    return { ...unchanged(input.messages, beforeTokens), rolledBack: true };
  }

  const selectedByStart = new Map(selected.map((item) => [item.start, item] as const));
  const messages: ManagedContextMessage[] = [];
  for (let index = 0; index < input.messages.length;) {
    const exchange = selectedByStart.get(index);
    if (!exchange) {
      messages.push(cloneManagedMessages([input.messages[index]])[0]);
      index += 1;
      continue;
    }
    const replacement = replacements.get(index);
    if (!replacement) throw new Error("操作压缩替换状态不完整。");
    messages.push(replacement);
    index = exchange.end;
  }
  return {
    messages,
    createdReferences,
    compactedExchanges: selected.length,
    beforeTokens,
    afterTokens: approximateTokens(messages),
    rolledBack: false,
  };
}

function findCompleteExchanges(
  messages: readonly ManagedContextMessage[],
): readonly Exchange[] {
  const exchanges: Exchange[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const assistant = messages[index];
    if (assistant?.kind !== "assistant-tool-call") continue;
    const expectedIds = assistant.toolCalls.map((call) => call.id);
    const results = messages.slice(index + 1, index + 1 + expectedIds.length);
    if (
      results.length !== expectedIds.length ||
      results.some((result, resultIndex) =>
        result.kind !== "tool-result" || result.toolCallId !== expectedIds[resultIndex]
      )
    ) continue;
    const outcomes = results.map(readResultOutcome);
    exchanges.push({
      start: index,
      end: index + 1 + results.length,
      messages: cloneManagedMessages([assistant, ...results]),
      toolNames: [...new Set(assistant.toolCalls.map((call) => call.name))],
      successful: outcomes.every((outcome) => outcome?.ok === true),
      failureSignature: failureSignature(assistant.toolCalls.map((call) => call.name), outcomes),
    });
    index += results.length;
  }
  return exchanges;
}

type ResultOutcome = {
  readonly ok: boolean;
  readonly errorKind?: string;
  readonly issuePaths: readonly string[];
};

function readResultOutcome(message: ManagedContextMessage): ResultOutcome | undefined {
  if (message.kind !== "tool-result") return undefined;
  const source = message.payload.storage === "inline"
    ? message.payload.content
    : message.payload.preview;
  try {
    const value = JSON.parse(source) as unknown;
    if (!isRecord(value) || typeof value.ok !== "boolean") return undefined;
    if (value.ok) return { ok: true, issuePaths: [] };
    const error = isRecord(value.error) ? value.error : undefined;
    const issues = Array.isArray(error?.issues) ? error.issues : [];
    return {
      ok: false,
      errorKind: typeof error?.kind === "string" ? error.kind : "unknown",
      issuePaths: issues.flatMap((issue) =>
        isRecord(issue) && typeof issue.path === "string" ? [issue.path] : []
      ),
    };
  } catch {
    return undefined;
  }
}

function failureSignature(
  toolNames: readonly string[],
  outcomes: readonly (ResultOutcome | undefined)[],
): string | undefined {
  if (outcomes.every((outcome) => outcome?.ok === true)) return undefined;
  if (outcomes.some((outcome) => outcome === undefined)) return undefined;
  return JSON.stringify({
    tools: toolNames,
    failures: outcomes.flatMap((outcome) =>
      outcome?.ok === false
        ? [{ kind: outcome.errorKind, issuePaths: outcome.issuePaths }]
        : []
    ),
  });
}

function latestRepeatedFailureStarts(exchanges: readonly Exchange[]): ReadonlySet<number> {
  const latest = new Map<string, number>();
  for (const exchange of exchanges) {
    if (exchange.failureSignature !== undefined) {
      latest.set(exchange.failureSignature, exchange.start);
    }
  }
  return new Set(latest.values());
}

function approximateTokens(messages: readonly ManagedContextMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

function unchanged(
  messages: readonly ManagedContextMessage[],
  tokens: number,
): OperationalCompactionResult {
  return {
    messages: cloneManagedMessages(messages),
    createdReferences: [],
    compactedExchanges: 0,
    beforeTokens: tokens,
    afterTokens: tokens,
    rolledBack: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
