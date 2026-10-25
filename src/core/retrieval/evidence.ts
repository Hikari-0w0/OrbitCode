import type { KnowledgeHit } from "./types";

export function knowledgeEvidenceForModel(hit: KnowledgeHit) {
  const { excerpt, ...reference } = hit;
  return {
    ...reference,
    citation: `${hit.path}:${hit.startLine}-${hit.endLine}`,
    sourceLines: excerpt.split(/\r?\n/).map((line, index) => `${hit.startLine + index}|${line}`).join("\n"),
  };
}

export function selectEvidence(hits: readonly KnowledgeHit[], limit: number, maxCharacters: number): KnowledgeHit[] {
  const selected: KnowledgeHit[] = []; let used = 0;
  for (const hit of hits) {
    const same = selected.filter(item => item.path === hit.path);
    if (same.length >= 2 || same.some(item => hit.startLine <= item.endLine && hit.endLine >= item.startLine)) continue;
    const size = Array.from(JSON.stringify(knowledgeEvidenceForModel(hit))).length;
    if (used + size > maxCharacters) continue;
    selected.push(hit); used += size;
    if (selected.length >= limit) break;
  }
  return selected;
}
