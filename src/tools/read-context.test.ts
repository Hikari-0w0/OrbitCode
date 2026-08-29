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
