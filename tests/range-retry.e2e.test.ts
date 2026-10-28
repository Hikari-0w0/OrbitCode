import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture";
import { DONE_EVENT, textDelta, toolCallDelta, TOOL_FINISH_EVENT, TRANSPORT_DONE_EVENT } from "./helpers/openai-mock";

test("共享 Runtime 经 HTTP429 恢复后读取大文件目标行并保存真实工具证据", async () => {
  let requests = 0;
  const fixture = await runtimeFixture(request => {
    if (isRecord(request.body) && request.body.tool_choice === "none") return { chunks: [{ data: textDelta("[]") + DONE_EVENT }] };
    requests++;
    if (requests === 1) return { status: 429, headers: { "retry-after": "0.01" } };
    if (requests === 2) return { chunks: [{ data: toolCallDelta({ id: "range-read", name: "read_file", argumentsJson: '{"path":"source.txt","start_line":2,"end_line":2}' }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT }] };
    return { chunks: [{ data: textDelta("已读取目标行。") + DONE_EVENT }] };
  }, { terminal: true });
  try {
    await writeFile(path.join(fixture.root, "source.txt"), "x".repeat(600000) + "\nRANGE_TARGET\n");
    await fixture.controller.handleLine("读取 source.txt 的第二行");
    assert.equal(requests, 3);
    assert.match(fixture.output(), /已读取目标行/u);
    const saved = JSON.stringify(await fixture.checkpoint());
    assert.match(saved, /RANGE_TARGET/u);
    assert.match(saved, /sha256/u);
    assert.doesNotMatch(saved, /x{10000}/u);
    assert.doesNotMatch(fixture.errors(), /model-error|synthetic-fixture-secret/u);
    const normal = fixture.server.requests.filter(request => isRecord(request.body) && request.body.tool_choice === "auto");
    assert.match(JSON.stringify(normal[2]?.body), /RANGE_TARGET/u);
    assert.doesNotMatch(JSON.stringify(normal[2]?.body), /x{10000}/u);
  } finally { await fixture.close(); }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
