import test from "node:test";
import assert from "node:assert/strict";
import { iterationReviewMessages } from "./iteration-review";

test("有限轮数临近上限时提示收尾，最后一次明确未执行项", () => {
  assert.deepEqual(iterationReviewMessages(9, 12), []);
  assert.match(iterationReviewMessages(10, 12)[0].content, /10\/12.*还剩 3 次/);
  assert.match(iterationReviewMessages(12, 12)[0].content, /新工具不会执行/);
  assert.match(iterationReviewMessages(12, 12)[0].content, /不能猜测或宣称通过/);
  assert.deepEqual(iterationReviewMessages(13, 12), []);
  assert.deepEqual(iterationReviewMessages(0, 12), []);
});

test("无限迭代保持原周期复核，没有虚构剩余轮数", () => {
  assert.deepEqual(iterationReviewMessages(12, "unlimited"), []);
  assert.match(iterationReviewMessages(16, "unlimited")[0].content, /任务仍可继续/);
  assert.doesNotMatch(iterationReviewMessages(16, "unlimited")[0].content, /还剩|新工具不会执行/);
});
