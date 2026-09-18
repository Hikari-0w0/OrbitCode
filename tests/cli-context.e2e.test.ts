import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture";
import { toolCallDelta, TOOL_FINISH_EVENT, TRANSPORT_DONE_EVENT, textDelta, DONE_EVENT } from "./helpers/openai-mock";

test("CLI 大工具结果卸载，引用恢复后仍可读且保持会话隔离", async () => {
  let count = 0;
  let reference = "";
  const fixture = await runtimeFixture((request) => {
    count++;
    if (count === 1) return { chunks: [{ data: toolCallDelta({ id: "large", name: "read_file", argumentsJson: '{"path":"large.txt"}' }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT }] };
    if (count === 2) {
      reference = JSON.stringify(request.body).match(/context:\/\/v1\/[0-9a-f-]{36}/)?.[0] ?? "";
      return { chunks: [{ data: toolCallDelta({ id: "offload", name: "read_context", argumentsJson: JSON.stringify({ reference, offset: 0, limit: 100 }) }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT }] };
    }
    return { chunks: [{ data: textDelta("已读取") + DONE_EVENT }] };
  }, { context: "      single_tool_result_tokens: 100\n      tool_result_group_tokens: 1000\n" });
  try {
    await writeFile(path.join(fixture.root, "large.txt"), "MARKER_" + "x".repeat(20_000));
    await fixture.controller.handleLine("读取大文件");
    assert.ok(reference);
    assert.match(JSON.stringify(fixture.server.requests[2].body), /MARKER_/);
    const saved = await fixture.checkpoint();
    await fixture.controller.handleLine(`/resume ${saved.summary.id}`);
    const chunk = await fixture.store.read({ sessionId: saved.summary.id, reference, offset: 0, limit: 100, signal: new AbortController().signal });
    assert.match(chunk.content, /MARKER_/);
    const other = await fixture.conversations.create({ providerId: "primary", workspaceId: "default" });
    await assert.rejects(fixture.store.read({ sessionId: other.summary.id, reference, offset: 0, limit: 100, signal: new AbortController().signal }));
    assert.equal(fixture.errors(), "");
  } finally { await fixture.close(); }
});

test("CLI 手动压缩使用无工具摘要，成功后保存上下文", async () => {
  let summaryRequested = false;
  const fixture = await runtimeFixture((request) => {
    const body = request.body;
    if (body && typeof body === "object" && "tool_choice" in body && body.tool_choice === "none") {
      summaryRequested = true;
      assert.equal("tools" in body, false);
      return { chunks: [{ data: textDelta(JSON.stringify({ analysisDraft: "压缩已完成的工作", summary: {
        taskGoals: ["继续任务"], completedWork: ["已完成先前对话"], keyDecisions: [], fileChanges: [], toolResults: [], errors: [], nextSteps: ["继续"] } })) + DONE_EVENT }] };
    }
    return { chunks: [{ data: textDelta("历史回复".repeat(500)) + DONE_EVENT }] };
  }, { context: "      recent_messages_tokens: 100\n" });
  try {
    for (let i = 0; i < 5; i++) await fixture.controller.handleLine(`问题${i}`);
    const before = await fixture.checkpoint();
    await fixture.controller.handleLine("/compress");
    assert.equal(summaryRequested, true);
    assert.match(fixture.output(), /succeeded/);
    const after = await fixture.checkpoint();
    assert.equal(after.summary.revision, before.summary.revision + 1);
    assert.equal(after.displayMessages.length, before.displayMessages.length);
    assert.equal(fixture.errors(), "");
  } finally { await fixture.close(); }
});
