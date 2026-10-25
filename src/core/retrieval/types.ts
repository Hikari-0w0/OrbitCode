export type KnowledgeScope = "docs" | "code" | "tests" | "all";
export type KnowledgeErrorCode = "disabled" | "not-indexed" | "invalid-arguments" | "permission-denied" | "incompatible" | "corrupt-index" | "provider-unavailable" | "timeout" | "cancelled" | "limit-exceeded" | "busy" | "storage";
export class KnowledgeError extends Error {
  constructor(readonly code: KnowledgeErrorCode, message: string) { super(message); this.name = "KnowledgeError"; }
}
export type KnowledgeFailure = { kind: "failure"; code: KnowledgeErrorCode; message: string; retryable: boolean; nextAction: "configure" | "build" | "refresh" | "retry" | "use-file-tools" | "none" };
export function knowledgeFailure(error: unknown): KnowledgeFailure {
  const code = error instanceof KnowledgeError ? error.code : "storage";
  return { kind: "failure", code, message: error instanceof KnowledgeError ? error.message : "知识检索操作失败。", retryable: ["timeout", "busy", "provider-unavailable"].includes(code), nextAction: code === "disabled" ? "configure" : code === "not-indexed" || code === "incompatible" || code === "corrupt-index" ? "build" : code === "cancelled" ? "none" : "use-file-tools" };
}
export type KnowledgeChunk = { id: string; path: string; startLine: number; endLine: number; excerpt: string; label: string; contentHash: string; historical: boolean; scope: Exclude<KnowledgeScope, "all"> };
export type KnowledgeHit = KnowledgeChunk & { indexVersion: string; matchedBy: readonly ("keyword" | "semantic")[] };
export type KnowledgeSearchResult = KnowledgeFailure | { kind: "results"; outcome: "matches" | "no-match" | "partial"; retrieval: "hybrid" | "keyword-fallback"; indexVersion: string; hits: readonly KnowledgeHit[]; omitted: number; staleCount: number; degradedReason?: "provider-unavailable" | "semantic-budget-exhausted"; elapsedMs: number; usage: { kind: "reported"; inputTokens: number } | { kind: "unknown" } };
export interface KnowledgeReader { search(input: { query: string; scope: KnowledgeScope; limit: number }, signal: AbortSignal): Promise<KnowledgeSearchResult>; }
