import assert from "node:assert/strict";
import test from "node:test";
import { searchContextContent } from "./context-search";
import { fitContextReadPayload } from "./context-read-payload";
import { approximateTextTokens } from "./token-estimator";

const input = { reference: "context://fixture", signal: new AbortController().signal };
test("全文搜索覆盖跳读盲区、跨页文本与Unicode，缺失只表明字面量无匹配", () => {
  const prefix = "😀中".repeat(16383);
  const content = prefix + "跨页😀标记" + "尾部".repeat(30000);
  const found = searchContextContent(content, { ...input, query: "跨页😀标记" });
  assert.equal(found.matches[0].offset, Array.from(prefix).length);
  assert.equal(found.matches[0].endOffset - found.matches[0].offset, 5);
  assert.equal(found.matchCount, 1);
  assert.equal(found.complete, true);
  assert.equal(found.searchedUntil, Array.from(content).length);
  const absent = searchContextContent(content, { ...input, query: "不存在" });
  assert.equal(absent.matchCount, 0);
  assert.equal(absent.searchedFrom, 0);
  assert.equal(absent.searchedUntil, absent.totalCharacters);
});

test("搜索支持重叠字面量并限制摘录，低预算压缩保留精确计数和完整范围", () => {
  const output = { reference: input.reference, ...searchContextContent("😀".repeat(2000), { ...input, query: "😀😀" }) };
  assert.equal(output.matchCount, 1999);
  assert.equal(output.matches.length, 4);
  const serialized = JSON.stringify({ ok: true, output });
  const budget = approximateTextTokens(JSON.stringify({ ok: true, output: { ...output, matches: [], matchesOmitted: 1999 } }));
  const fitted = JSON.parse(fitContextReadPayload(serialized, budget));
  assert.equal(fitted.output.complete, true);
  assert.equal(fitted.output.searchedUntil, 2000);
  assert.equal(fitted.output.matchCount, 1999);
  assert.equal(fitted.output.matchesOmitted + fitted.output.matches.length, 1999);
  assert.ok(approximateTextTokens(JSON.stringify(fitted)) <= budget);
  assert.throws(() => fitContextReadPayload(serialized, 1), /预算/);
});

test("搜索拒绝空查询、超长查询与取消，不解释正则", () => {
  for (const query of ["", "a".repeat(129)]) assert.throws(() => searchContextContent("text", { ...input, query }));
  assert.throws(() => searchContextContent("text", { ...input, query: "text", signal: AbortSignal.abort() }), /取消/);
  assert.equal(searchContextContent("a.*b", { ...input, query: ".*" }).matchCount, 1);
  assert.equal(searchContextContent("ABC", { ...input, query: "abc" }).matchCount, 0);
});
