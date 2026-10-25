import test from "node:test";
import assert from "node:assert/strict";
import { keywordRanking, vectorRanking, fuseRankings } from "./ranking";
import { tokenize } from "./tokenizer";
import { knowledgeEvidenceForModel, selectEvidence } from "./evidence";
import type { KnowledgeHit } from "./types";
test("中文与标识符、BM25、语义融合和同分稳定排序", () => {
  assert.ok(tokenize("工作区 readFile read_file").includes("工作"));
  assert.ok(tokenize("readFile").includes("readfile"));
  const keyword = keywordRanking(["command timeout timeout", "workspace session", "timeout"], "timeout");
  assert.equal(keyword[0].index, 2); assert.equal(keyword.length, 2);
  assert.deepEqual(keywordRanking(["hello"], "missing"), []);
  const vector = vectorRanking([[1, 0], [0, 1], [0.6, 0.8]], [0, 1]);
  assert.equal(vector[0].index, 1); assert.equal(fuseRankings(keyword, vector).length, 3);
  assert.deepEqual(fuseRankings([{index: 0, score: 1}], [{index: 1, score: 1}]).map(hit => hit.index), [0, 1]);
});
test("证据去重、每文件限制与总预算", () => {
  const hit: KnowledgeHit = { id: "1", path: "a.ts", startLine: 1, endLine: 5, excerpt: "hello", label: "a", contentHash: "h", historical: false, scope: "code", indexVersion: "v", matchedBy: ["keyword"] };
  assert.equal(selectEvidence([hit, {...hit,id: "2",startLine: 3}, {...hit,id: "3",startLine: 10,endLine: 15}, {...hit,id: "4",startLine: 20,endLine: 25}], 6, 10000).length, 2);
  assert.equal(selectEvidence([hit], 6, 1).length, 0);
  const formattedSize = Array.from(JSON.stringify(knowledgeEvidenceForModel(hit))).length;
  assert.equal(selectEvidence([hit], 6, formattedSize - 1).length, 0);
  assert.equal(selectEvidence([hit], 6, formattedSize).length, 1);
});
