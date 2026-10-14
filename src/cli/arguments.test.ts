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
      explicitConfig: true,
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
    ["--resume", "id", "--provider", "primary"],
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

test("默认配置与恢复参数", () => {
  assert.deepEqual(parseCliArguments([]), { type: "run", configPath: "orbitcode.yaml", providerName: undefined });
  assert.equal(parseCliArguments(["--resume", "id"]).type, "run");
});

test("单次运行要求明确输入，策略文件只能用于隔离目录", () => {
  assert.deepEqual(parseCliArguments(["run", "--stdin", "--data-dir", "fixture", "--policy-file", "policy.yaml", "--timeout-ms", "180000"]), {
    type: "run-once", stdin: true, outputFormat: "json", dataDir: "fixture", policyFile: "policy.yaml", timeoutMs: 180000,
  });
  for (const args of [["run", "--stdin", "--prompt-file", "p"], ["run", "--policy-file", "p", "--stdin"],
    ["run", "--stdin", "--timeout-ms", "0"]]) assert.throws(() => parseCliArguments(args), ArgumentError);
});

test("交互 CLI 可从隔离目录读取托管设置，且不混用显式旧配置", () => {
  assert.deepEqual(parseCliArguments(["--data-dir", "fixture"]), { type: "run", configPath: "orbitcode.yaml", providerName: undefined, dataDir: "fixture" });
  assert.throws(() => parseCliArguments(["--data-dir", "fixture", "--config", "legacy.yaml"]), ArgumentError);
});

test("单次执行接受显式轮数上限并拒绝越界或重复预算", () => {
  const parsed = parseCliArguments(["run", "--stdin", "--max-iterations", "3"]);
  assert.equal(parsed.type === "run-once" && parsed.maxIterations, 3);
  for (const value of ["0", "33", "1.5", "-1"]) assert.throws(() => parseCliArguments(["run", "--stdin", "--max-iterations", value]));
  assert.throws(() => parseCliArguments(["run", "--stdin", "--max-iterations", "3", "--max-iterations", "4"]));
});
