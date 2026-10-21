import test from "node:test";
import assert from "node:assert/strict";
import { TokenReservationBudget } from "./token-budget";

test("并发预留不超发，已知结算释放差额且重复结算不退款", () => {
  const budget = new TokenReservationBudget(100), first = budget.reserve(60), second = budget.reserve(40);
  assert.ok(first && second); assert.equal(budget.reserve(1), undefined);
  first.settle(10); first.settle(0);
  assert.equal(budget.snapshot().available, 50); assert.equal(budget.snapshot().reserved, 40);
  second.settle(); assert.equal(budget.snapshot().unknown, 40); assert.equal(budget.snapshot().available, 50);
});
test("未知或无效用量保留预留，实际超额不截断为预算值", () => {
  const budget = new TokenReservationBudget(100);
  budget.reserve(20)!.settle(NaN); budget.reserve(80)!.settle(120);
  assert.equal(budget.snapshot().reported, 120); assert.equal(budget.snapshot().unknown, 20);
  assert.equal(budget.snapshot().overdrawn, true); assert.equal(budget.reserve(1), undefined);
  assert.throws(() => new TokenReservationBudget(0)); assert.throws(() => budget.reserve(-1));
});
