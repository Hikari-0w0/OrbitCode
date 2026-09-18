import assert from "node:assert/strict";
import test from "node:test";
import { executablePlanId, matchesExecutablePlan } from "./plan-execution";
test("仅最新成功 Plan 可执行，取消、失败、旧 ID 均拒绝", () => {
  assert.equal(executablePlanId("plan", "final-response", "p"), "p");
  assert.equal(executablePlanId("plan", "cancelled", "p"), undefined);
  assert.equal(executablePlanId("plan", "model-error", "p"), undefined);
  assert.equal(executablePlanId("do", "final-response", "p"), undefined);
  assert.equal(matchesExecutablePlan("new", "old"), false);
  assert.equal(matchesExecutablePlan(undefined, "old"), false);
});
