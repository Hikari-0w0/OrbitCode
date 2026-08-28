import assert from "node:assert/strict";
import test from "node:test";

import { AgentConfigurationError } from "@/core/errors";
import { createPromptEnvironment } from "@/web/prompt-environment";

test("从受信任字段构造不含绝对路径的提示环境", () => {
  const environment = createPromptEnvironment({
    workspace: { id: "orbitcode", name: "OrbitCode" },
    now: new Date("2026-08-28T03:00:00.000Z"),
    platform: "darwin",
    timeZone: "Asia/Shanghai",
  });

  assert.deepEqual(environment, {
    workspace: { id: "orbitcode", name: "OrbitCode" },
    platform: "darwin",
    currentDate: "2026-08-28",
    timeZone: "Asia/Shanghai",
    pathSemantics: "workspace-relative-posix",
  });
  assert.equal(JSON.stringify(environment).includes("/Users/"), false);
});

test("非法日期和时区被安全拒绝", () => {
  assert.throws(
    () => createPromptEnvironment({
      workspace: { id: "test", name: "Test" },
      now: new Date(Number.NaN),
      platform: "darwin",
      timeZone: "UTC",
    }),
    AgentConfigurationError,
  );
  assert.throws(
    () => createPromptEnvironment({
      workspace: { id: "test", name: "Test" },
      now: new Date("2026-08-28T00:00:00.000Z"),
      platform: "darwin",
      timeZone: "invalid time zone",
    }),
    AgentConfigurationError,
  );
});
