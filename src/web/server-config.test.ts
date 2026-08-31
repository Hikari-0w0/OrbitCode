import assert from "node:assert/strict";
import test from "node:test";

import { ConfigurationError } from "@/models/config";
import {
  resolveMaxAgentIterations,
  resolveMaxAgentRuntime,
} from "@/web/server-config";

test("最大迭代配置缺失时使用默认值并接受安全覆盖", () => {
  assert.equal(resolveMaxAgentIterations({}), 8);
  assert.equal(resolveMaxAgentIterations({ ORBITCODE_MAX_AGENT_ITERATIONS: "1" }), 1);
  assert.equal(resolveMaxAgentIterations({ ORBITCODE_MAX_AGENT_ITERATIONS: "32" }), 32);
  assert.equal(
    resolveMaxAgentIterations({ ORBITCODE_MAX_AGENT_ITERATIONS: "unlimited" }),
    "unlimited",
  );
});

test("最大运行时间默认一小时并接受 1 到 1440 分钟", () => {
  assert.equal(resolveMaxAgentRuntime({}), 60 * 60 * 1_000);
  assert.equal(
    resolveMaxAgentRuntime({ ORBITCODE_MAX_AGENT_RUNTIME_MINUTES: "1" }),
    60 * 1_000,
  );
  assert.equal(
    resolveMaxAgentRuntime({ ORBITCODE_MAX_AGENT_RUNTIME_MINUTES: "1440" }),
    24 * 60 * 60 * 1_000,
  );
  for (const value of ["", "0", "1.5", "1441", "unlimited"]) {
    assert.throws(
      () => resolveMaxAgentRuntime({ ORBITCODE_MAX_AGENT_RUNTIME_MINUTES: value }),
      ConfigurationError,
    );
  }
});

test("最大迭代配置拒绝空白、非整数和越界值", () => {
  for (const value of ["", " 8", "8 ", "0", "-1", "1.5", "33", "999999999999999999999"]) {
    assert.throws(
      () => resolveMaxAgentIterations({ ORBITCODE_MAX_AGENT_ITERATIONS: value }),
      ConfigurationError,
    );
  }
});
