import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SUB_AGENT_LIMITS, parseSubAgentLimits } from "./types";
test("子预算缺省兼容且所有值有限，未知字段和并发超容量拒绝", () => {
  assert.deepEqual(parseSubAgentLimits(undefined), DEFAULT_SUB_AGENT_LIMITS);
  for (const value of [{ perTurn: 0 }, { concurrency: Infinity }, { capacity: 1, concurrency: 2 }, { maxIterations: 33 }, { waitSeconds: 1.2 }, { unexpected: 1 }]) assert.throws(() => parseSubAgentLimits(value));
  assert.equal(parseSubAgentLimits({ perTurn: 2 }).perTurn, 2);
});
