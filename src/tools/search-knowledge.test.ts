import test from "node:test";
import assert from "node:assert/strict";
import { createWorkspaceBoundary } from "@/tools/workspace";
import { createModeToolPolicy } from "@/tools/mode-policy";
import { ToolRegistry } from "@/tools/registry";
import type { KnowledgeHit, KnowledgeSearchResult } from "@/core/retrieval/types";
import { createSearchKnowledgeTool } from "./search-knowledge";

test("工具引用标明真实行号，行号前缀不进入原文或指纹", async () => {
  const excerpt = "# 契约\n入口说明\n状态结构\n无效的新凭证数量抛出异常。";
  const hit: KnowledgeHit = { id: "chunk", path: "docs/contract.md", startLine: 20, endLine: 23, excerpt,
    label: "契约", contentHash: "source-hash", historical: false, scope: "docs", indexVersion: "index", matchedBy: ["semantic"] };
  const data: KnowledgeSearchResult = { kind: "results", outcome: "matches", retrieval: "hybrid", indexVersion: "index",
    hits: [hit], omitted: 0, staleCount: 0, elapsedMs: 1, usage: { kind: "unknown" } };
  const registry = new ToolRegistry([createSearchKnowledgeTool({ search: async () => data })]);
  const result = await createModeToolPolicy(registry, "plan").execute("search_knowledge", { query: "异常契约" }, {
    workspace: await createWorkspaceBoundary(process.cwd()), signal: new AbortController().signal, deadlineMs: Date.now() + 5000,
  });
  assert.ok(result.ok);
  const { excerpt: raw, ...reference } = hit;
  assert.deepEqual(result.output, { ...data, hits: [{ ...reference, citation: "docs/contract.md:20-23",
    sourceLines: "20|# 契约\n21|入口说明\n22|状态结构\n23|无效的新凭证数量抛出异常。" }] });
  assert.equal(raw, excerpt);
  assert.equal(data.hits[0].excerpt, excerpt);
  assert.equal(data.hits[0].contentHash, "source-hash");
});
