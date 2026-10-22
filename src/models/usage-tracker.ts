import type { ChatProvider, ModelTokenUsage } from "./provider";

export type ModelUsagePurpose = "agent" | "summary" | "memory";
export type ModelUsageSummary = {
  readonly scope: "self";
  readonly categories: readonly {
    readonly cache?: { readonly tokenRequests:number; readonly cachedTokens:number; readonly hitRequests:number; readonly missRequests:number; readonly unknownRequests:number };
    readonly purpose: ModelUsagePurpose;
    readonly requests: number;
    readonly reportedRequests: number;
    readonly failedRequests: number;
    readonly durationMs: number;
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  }[];
};
type Category = { -readonly [K in keyof ModelUsageSummary["categories"][number]]: ModelUsageSummary["categories"][number][K] };

// 同一 Provider 可被主循环与摘要共享；按调用用途计量，缺失 usage 不补估算。
export class ModelUsageTracker {
  private readonly categories = new Map<ModelUsagePurpose, Category>();
  wrap(provider: ChatProvider, purpose: ModelUsagePurpose): ChatProvider {
    const categories = this.categories;
    return {
      supportsRequestTokenLimit: provider.supportsRequestTokenLimit,
      async *stream(messages, options) {
        let category = categories.get(purpose);
        if (!category) {
          category = { purpose, requests: 0, reportedRequests: 0, failedRequests: 0, durationMs: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
          categories.set(purpose, category);
        }
        category.requests++;
        const started = Date.now();
        let usage: ModelTokenUsage | undefined;
        let completed = false;
        let failed = false;
        try {
          for await (const event of provider.stream(messages, options)) {
            if (event.type === "usage") usage = event.usage;
            if (event.type === "done") completed = true;
            yield event;
          }
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          category.durationMs += Math.max(0, Date.now() - started);
          if (failed || !completed) category.failedRequests++;
          const cache=category.cache??{tokenRequests:0,cachedTokens:0,hitRequests:0,missRequests:0,unknownRequests:0};
          const observation=usage?.promptCache;
          category.cache={tokenRequests:cache.tokenRequests+(observation?.availability==="tokens"?1:0),cachedTokens:cache.cachedTokens+(observation?.availability==="tokens"?observation.cachedTokens:0),hitRequests:cache.hitRequests+(observation?.availability==="status"&&observation.hit?1:0),missRequests:cache.missRequests+(observation?.availability==="status"&&!observation.hit?1:0),unknownRequests:cache.unknownRequests+(!observation||observation.availability==="unavailable"?1:0)};
          if (usage) {
            category.reportedRequests++;
            category.promptTokens += usage.promptTokens;
            category.completionTokens += usage.completionTokens;
            category.totalTokens += usage.totalTokens;
          }
        }
      },
    };
  }
  snapshot(): ModelUsageSummary {
    return { scope: "self", categories: [...this.categories.values()].map(category => ({ ...category })) };
  }
}

export function isModelUsageSummary(value: unknown): value is ModelUsageSummary {
  if (typeof value !== "object" || value === null || !("scope" in value) || value.scope !== "self" ||
    !("categories" in value) || !Array.isArray(value.categories) || value.categories.length > 3 ||
    Object.keys(value).some(key => key !== "scope" && key !== "categories")) return false;
  const purposes = new Set<unknown>();
  return value.categories.every((category: unknown) => {
    if (!isRecord(category) ||
      !["agent", "summary", "memory"].includes(String(category.purpose)) || purposes.has(category.purpose)) return false;
    purposes.add(category.purpose);
    const numbers = ["requests", "reportedRequests", "failedRequests", "durationMs", "promptTokens", "completionTokens", "totalTokens"];
    const cache = category.cache;
    if (Object.keys(category).some(key => ![...numbers, "purpose", "cache"].includes(key)) || (cache !== undefined && (!isRecord(cache) || Object.keys(cache).length !== 5 || !["tokenRequests","cachedTokens","hitRequests","missRequests","unknownRequests"].every(key=>isCount(cache[key])))) || !numbers.every(key => isCount(category[key]))) return false;
    return isCount(category.requests) && isCount(category.reportedRequests) && isCount(category.failedRequests) &&
      category.reportedRequests <= category.requests && category.failedRequests <= category.requests;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isCount(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
