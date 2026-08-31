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
  assert.deepEqual(
    parseCliArguments([
      "export-run",
      "run-1",
      "--output",
      "analysis/run.json",
      "--without-context",
    ]),
    {
      type: "export-run",
      runId: "run-1",
      outputPath: "analysis/run.json",
      includeContext: false,
    },
  );
});

test("拒绝缺失、未知、重复和冲突参数", () => {
  const invalidArguments = [
    [],
    ["--unknown"],
    ["--config"],
    ["--provider", "primary", "--config", "config.yaml", "--provider", "other"],
    ["--config", "a.yaml", "--config", "b.yaml"],
    ["--help", "--config", "config.yaml"],
    ["export-run"],
    ["export-run", "run-1", "--output"],
    ["export-run", "run-1", "--without-context", "--without-context"],
  ];

  for (const argv of invalidArguments) {
    assert.throws(() => parseCliArguments(argv), ArgumentError);
  }
});
