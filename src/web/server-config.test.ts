import assert from "node:assert/strict";
import test from "node:test";

import { ConfigurationError } from "@/models/config";
import { resolveMaxAgentIterations } from "@/web/server-config";

test("最大迭代配置缺失时使用默认值并接受安全覆盖", () => {
  assert.equal(resolveMaxAgentIterations({}), 8);
  assert.equal(resolveMaxAgentIterations({ ORBITCODE_MAX_AGENT_ITERATIONS: "1" }), 1);
  assert.equal(resolveMaxAgentIterations({ ORBITCODE_MAX_AGENT_ITERATIONS: "32" }), 32);
});

test("最大迭代配置拒绝空白、非整数和越界值", () => {
  for (const value of ["", " 8", "8 ", "0", "-1", "1.5", "33", "999999999999999999999"]) {
    assert.throws(
      () => resolveMaxAgentIterations({ ORBITCODE_MAX_AGENT_ITERATIONS: value }),
      ConfigurationError,
    );
  }
});
