import assert from "node:assert/strict";
import test from "node:test";

import { createReadContextTool } from "@/tools/read-context";
import { createWorkspaceBoundary } from "@/tools/workspace";

test("read_context 只通过绑定 reader 分块读取", async () => {
  const tool = createReadContextTool(async (input) => ({
    content: "内容",
    offset: input.offset,
    nextOffset: input.offset + 2,
    totalCharacters: 4,
    hasMore: true,
  }));
  const workspace = await createWorkspaceBoundary(process.cwd());
  const result = await tool.execute(
    { reference: "context://v1/00000000-0000-4000-8000-000000000001", offset: 0, limit: 2 },
    { workspace, signal: new AbortController().signal, deadlineMs: Date.now() + 1000 },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.output, {
      reference: "context://v1/00000000-0000-4000-8000-000000000001",
      content: "内容",
      offset: 0,
      nextOffset: 2,
      totalCharacters: 4,
      hasMore: true,
    });
  }
});

test("reader 拒绝引用时返回统一结构化错误", async () => {
  const tool = createReadContextTool(async () => {
    throw new Error("private path");
  });
  const workspace = await createWorkspaceBoundary(process.cwd());
  const result = await tool.execute(
    { reference: "context://v1/00000000-0000-4000-8000-000000000002", offset: 0, limit: 2 },
    { workspace, signal: new AbortController().signal, deadlineMs: Date.now() + 1000 },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "context-reference");
    assert.equal(result.error.message.includes("private path"), false);
  }
});

test("query 经同一作用域搜索，非法偏移与未支持适配器不能静默退化为读取", async () => {
  const { searchContextContent } = await import("@/core/context/context-search");
  let reads = 0, searches = 0;
  const read = async () => { reads++; throw new Error("不应读取"); };
  const tool = createReadContextTool({ read, search: async request => { searches++; return searchContextContent("before😀needle after", request); } });
  const context = { workspace: await createWorkspaceBoundary(process.cwd()), signal: new AbortController().signal, deadlineMs: Date.now() + 1000 };
  const args = { reference: "context://fixture", offset: 0, limit: 100, query: "needle" };
  const result = await tool.execute(args, context);
  assert.equal(result.ok, true);
  if (result.ok) { const output = result.output; assert.ok(output && typeof output === "object" && !Array.isArray(output) && "mode" in output); assert.equal(output.mode, "search"); assert.ok("complete" in output && output.complete === true); }
  assert.equal((await tool.execute({ ...args, offset: 10 }, context)).ok, false);
  assert.equal((await createReadContextTool(read).execute(args, context)).ok, false);
  assert.equal(searches, 1); assert.equal(reads, 0);
  assert.equal(tool.inputSchema.parse({ ...args, query: "" }).ok, false);
});
