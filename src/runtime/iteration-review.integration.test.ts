import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runtimeFixture } from "../../tests/helpers/runtime-fixture";
import { DONE_EVENT, TOOL_FINISH_EVENT, TRANSPORT_DONE_EVENT, textDelta, toolCallDelta } from "../../tests/helpers/openai-mock";

test("长任务进度复核跨共享上下文生效，不累计进历史或中断不限轮数任务", async () => {
  let requests = 0;
  const reviewRequests: number[] = [];
  const fixture = await runtimeFixture(request => {
    requests++;
    if (JSON.stringify(request.body).includes("请复核仍未解决的具体事项")) reviewRequests.push(requests);
    return { chunks: [{ data: requests <= 33
      ? toolCallDelta({ id: `read-${requests}`, name: "read_file", argumentsJson: '{"path":"actual.txt"}' }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT
      : textDelta("LONG_TASK_FINISHED") + DONE_EVENT }] };
  }, { iterations: "unlimited" });
  try {
    await fixture.runtime.memory.setEnabled(false);
    await writeFile(path.join(fixture.root, "actual.txt"), "read-only evidence");
    await fixture.controller.handleLine("完成这个长任务");
    const checkpoint = await fixture.checkpoint();
    assert.equal(requests, 34);
    assert.deepEqual(reviewRequests, [16, 32]);
    assert.equal(checkpoint.lastTurn?.stopReason, "final-response");
    assert.match(fixture.output(), /LONG_TASK_FINISHED/u);
    assert.doesNotMatch(JSON.stringify(checkpoint), /请复核仍未解决的具体事项/u);
  } finally { await fixture.close(); }
});
