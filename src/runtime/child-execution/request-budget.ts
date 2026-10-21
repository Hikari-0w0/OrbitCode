import { ProviderError, MAX_MODEL_OUTPUT_TOKENS, type ChatProvider, type ModelTokenUsage } from "@/models/provider";
import { TokenReservationBudget, type TokenBudgetSnapshot } from "@/core/sub-agents/token-budget";

export type RequestBudgetSnapshot = {
  readonly tokens?: TokenBudgetSnapshot;
  readonly id: string;
  readonly limit: number;
  readonly admittedAttempts: number;
  readonly logicalRequests: number;
  readonly rejectedRequests: number;
  readonly inFlight: number;
  readonly reportedRequests: number;
  readonly missingUsageRequests: number;
  readonly failedRequests: number;
  readonly reportedTokens: number;
  readonly unreconciledAttempts: number;
};

// 同一父轮及其存活子执行共享账本。接纳计数不退款，失败与取消不能重新获得额度。
export class ModelRequestBudget {
  private admittedAttempts = 0;
  private logicalRequests = 0;
  private rejectedRequests = 0;
  private inFlight = 0;
  private reportedRequests = 0;
  private missingUsageRequests = 0;
  private failedRequests = 0;
  private reportedTokens = 0;
  private readonly tokens?: TokenReservationBudget;

  constructor(readonly id: string, readonly limit: number, readonly tokenLimit?: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("任务组请求预算必须是正整数。");
    if (tokenLimit !== undefined && tokenLimit !== 0) this.tokens = new TokenReservationBudget(tokenLimit);
  }

  private reserve(tokens: number): ReturnType<TokenReservationBudget["reserve"]> {
    if (this.admittedAttempts >= this.limit) {
      this.rejectedRequests++;
      throw new ProviderError("budget", "任务组模型请求预算已耗尽；本轮父执行、子任务、独立 Skill 和摘要共享额度。", { retryable: false });
    }
    const reservation = this.tokens?.reserve(tokens);
    if (this.tokens && !reservation) {
      this.rejectedRequests++;
      throw new ProviderError("budget", "任务组token预算不足；缺失usage的尝试保留预留额，不能据此推断零消耗。", { retryable: false });
    }
    this.admittedAttempts++;
    return reservation;
  }

  wrap(provider: ChatProvider, maxOutputTokens = 8192): ChatProvider {
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > MAX_MODEL_OUTPUT_TOKENS) throw new Error("预算输出预留上限无效。");
    return { supportsRequestTokenLimit: provider.supportsRequestTokenLimit, stream: (messages, options) => this.stream(provider, messages, options, maxOutputTokens) };
  }

  private async *stream(provider: ChatProvider, messages: Parameters<ChatProvider["stream"]>[0], options: Parameters<ChatProvider["stream"]>[1], outputLimit: number) {
      options.signal.throwIfAborted();
      if (this.tokens && !provider.supportsRequestTokenLimit) {
        this.rejectedRequests++;
        throw new ProviderError("budget", "该Provider未声明支持单次输出限制，不能接纳启用token预算的请求。", { retryable: false });
      }
      const maxOutputTokens = Math.min(outputLimit, options.maxOutputTokens ?? outputLimit);
      const reservedTokens = new TextEncoder().encode(JSON.stringify({ messages, tools: options.tools ?? [] })).byteLength + 1024 + messages.length * 32 + maxOutputTokens;
      let reservation = this.reserve(reservedTokens);
      this.logicalRequests++; this.inFlight++;
      let usage: ModelTokenUsage | undefined, completed = false, failed = false;
      try {
        for await (const event of provider.stream(messages, { ...options, ...(this.tokens ? { maxOutputTokens } : {}), beforeRequest: attempt => {
          options.signal.throwIfAborted();
          if (attempt > 1) { reservation?.settle(usage?.totalTokens); reservation = undefined; usage = undefined; reservation = this.reserve(reservedTokens); }
          options.beforeRequest?.(attempt);
        } })) {
          if (event.type === "usage") usage = event.usage;
          if (event.type === "done") completed = true;
          yield event;
        }
      } catch (error) { failed = true; throw error; }
      finally {
        this.inFlight--;
        reservation?.settle(usage?.totalTokens);
        if (failed || !completed) this.failedRequests++;
        if (usage) { this.reportedRequests++; this.reportedTokens += usage.totalTokens; }
        else this.missingUsageRequests++;
      }
  }

  snapshot(): RequestBudgetSnapshot {
    return { ...(this.tokens ? { tokens: this.tokens.snapshot() } : {}), id: this.id, limit: this.limit, admittedAttempts: this.admittedAttempts, logicalRequests: this.logicalRequests,
      rejectedRequests: this.rejectedRequests, inFlight: this.inFlight, reportedRequests: this.reportedRequests,
      missingUsageRequests: this.missingUsageRequests, failedRequests: this.failedRequests, reportedTokens: this.reportedTokens,
      unreconciledAttempts: this.admittedAttempts - this.reportedRequests };
  }
}
