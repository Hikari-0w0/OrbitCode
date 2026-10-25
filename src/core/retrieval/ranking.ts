import { tokenize } from "./tokenizer";
export type Ranked = { index: number; score: number };
export function keywordRanking(texts: readonly string[], query: string): Ranked[] {
  const documents = texts.map(tokenize), terms = [...new Set(tokenize(query))];
  const average = documents.reduce((sum, terms) => sum + terms.length, 0) / (documents.length || 1) || 1;
  const frequencies = new Map(terms.map(term => [term, documents.filter(document => document.includes(term)).length]));
  return documents.map((document, index) => ({ index, score: terms.reduce((sum, term) => {
    const frequency = document.filter(word => word === term).length, df = frequencies.get(term) ?? 0;
    return sum + Math.log(1 + (documents.length - df + 0.5) / (df + 0.5)) * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * document.length / average));
  }, 0) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
}
export function vectorRanking(vectors: readonly (readonly number[])[], query: readonly number[]): Ranked[] {
  return vectors.map((vector, index) => ({ index, score: vector.reduce((sum, value, i) => sum + value * query[i], 0) })).sort((a, b) => b.score - a.score || a.index - b.index);
}
export function fuseRankings(keyword: readonly Ranked[], semantic: readonly Ranked[]): Ranked[] {
  const scores = new Map<number, number>();
  for (const ranking of [keyword, semantic]) ranking.forEach((hit, rank) => scores.set(hit.index, (scores.get(hit.index) ?? 0) + 1 / (60 + rank + 1)));
  return Array.from(scores, ([index, score]) => ({ index, score })).sort((a, b) => b.score - a.score || a.index - b.index);
}
