import assert from "node:assert/strict";
import test from "node:test";

import {
  ArgumentError,
  parseCliArguments,
} from "@/cli/arguments";

test("解析配置路径和可选 Provider 名称", () => {
  assert.deepEqual(
    parseCliArguments([
      "--config",
      "orbitcode.yaml",
      "--provider",
      "primary",
    ]),
    {
      type: "run",
      configPath: "orbitcode.yaml",
      providerName: "primary",
    },
  );
  assert.deepEqual(parseCliArguments(["--help"]), { type: "help" });
});

test("拒绝缺失、未知、重复和冲突参数", () => {
  const invalidArguments = [
    [],
    ["--unknown"],
    ["--config"],
    ["--provider", "primary", "--config", "config.yaml", "--provider", "other"],
    ["--config", "a.yaml", "--config", "b.yaml"],
    ["--help", "--config", "config.yaml"],
  ];

  for (const argv of invalidArguments) {
    assert.throws(() => parseCliArguments(argv), ArgumentError);
  }
});
