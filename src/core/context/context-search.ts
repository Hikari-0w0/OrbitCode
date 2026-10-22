import { ContextManagementError } from "./context-errors";

export type ContextSearchInput = {
  readonly reference: string;
  readonly query: string;
  readonly signal: AbortSignal;
};
export type ContextSearchResult = {
  readonly mode: "search";
  readonly query: string;
  readonly totalCharacters: number;
  readonly searchedFrom: 0;
  readonly searchedUntil: number;
  readonly complete: true;
  readonly matchCount: number;
  readonly matches: readonly { readonly offset: number; readonly endOffset: number; readonly excerpt: string }[];
  readonly matchesOmitted: number;
};

// 引用正文由存储适配器校验后一次读取；全量字面量搜索与模型分页阅读分别记录，避免把末页当作全量证据。
export function searchContextContent(content: string, input: ContextSearchInput): ContextSearchResult {
  if (!input.query.length || input.query.length > 128) throw new ContextManagementError("storage", "搜索词长度必须为 1–128。");
  if (input.signal.aborted) throw new ContextManagementError("cancelled", "上下文搜索已取消。");
  const characters = Array.from(content);
  const query = Array.from(input.query);
  const matches: { offset: number; endOffset: number; excerpt: string }[] = [];
  let matchCount = 0;
  // KMP 保证重复文本和长前缀下仍为线性扫描；按 Unicode 码点返回与 read_context 相同的偏移。
  const prefix = new Array<number>(query.length).fill(0);
  for (let i = 1, j = 0; i < query.length; i++) {
    while (j > 0 && query[i] !== query[j]) j = prefix[j - 1];
    if (query[i] === query[j]) j++;
    prefix[i] = j;
  }
  for (let i = 0, j = 0; i < characters.length; i++) {
    while (j > 0 && characters[i] !== query[j]) j = prefix[j - 1];
    if (characters[i] === query[j]) j++;
    if (j !== query.length) continue;
    const offset = i - query.length + 1;
    matchCount++;
    if (matches.length < 4) matches.push({ offset, endOffset: i + 1, excerpt: characters.slice(Math.max(0, offset - 48), i + 49).join("") });
    j = prefix[j - 1];
  }
  return { mode: "search", query: input.query, totalCharacters: characters.length, searchedFrom: 0, searchedUntil: characters.length, complete: true, matchCount, matches, matchesOmitted: matchCount - matches.length };
}
