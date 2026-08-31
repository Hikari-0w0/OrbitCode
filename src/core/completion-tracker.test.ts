import assert from "node:assert/strict";
import test from "node:test";

import { CompletionTracker } from "@/core/completion-tracker";
import { successfulToolResult } from "@/tools/registry";
import { toolFailure } from "@/tools/types";

test("完整报告必须引用最后写入之后的成功验证", () => {
  const tracker = new CompletionTracker();
  tracker.record({
    call: { id: "write-1", name: "write_file", argumentsJson: "{}" },
    result: successfulToolResult({}, "applied"),
    iteration: 1,
    sequence: 0,
    mutability: "workspace-write",
  });
  tracker.record({
    call: { id: "test-1", name: "run_command", argumentsJson: "{}" },
    result: successfulToolResult({}, "possible"),
    iteration: 2,
    sequence: 0,
    mutability: "command",
  });
  const accepted = tracker.accept({
    status: "complete",
    checks: [{
      criterion: "相关测试通过",
      status: "passed",
      evidenceCallIds: ["test-1"],
    }],
    blockers: [],
  });
  assert.equal(accepted.ok, true);
  assert.equal(tracker.assessment().status, "verified");
});

test("拒绝伪造证据、失败证据和写入前的完成声明", () => {
  const tracker = new CompletionTracker();
  tracker.record({
    call: { id: "failed", name: "run_command", argumentsJson: "{}" },
    result: toolFailure("command-failed", "失败"),
    iteration: 1,
    sequence: 0,
    mutability: "command",
  });
  for (const evidenceCallIds of [["missing"], ["failed"]]) {
    assert.equal(tracker.accept({
      status: "complete",
      checks: [{ criterion: "验证", status: "passed", evidenceCallIds }],
      blockers: [],
    }).ok, false);
  }

  const writeAfterCheck = new CompletionTracker();
  writeAfterCheck.record({
    call: { id: "check", name: "read_file", argumentsJson: "{}" },
    result: successfulToolResult({}),
    iteration: 1,
    sequence: 0,
    mutability: "read-only",
  });
  writeAfterCheck.record({
    call: { id: "write", name: "write_file", argumentsJson: "{}" },
    result: successfulToolResult({}, "applied"),
    iteration: 2,
    sequence: 0,
    mutability: "workspace-write",
  });
  assert.equal(writeAfterCheck.accept({
    status: "complete",
    checks: [{ criterion: "旧验证", status: "passed", evidenceCallIds: ["check"] }],
    blockers: [],
  }).ok, false);
});

test("失败或未运行项为 partial，blocker 为 blocked，缺少报告为 unverified", () => {
  assert.equal(new CompletionTracker().assessment().status, "unverified");
  const partial = new CompletionTracker();
  assert.equal(partial.accept({
    status: "partial",
    checks: [{ criterion: "端到端", status: "not-run", evidenceCallIds: [] }],
    blockers: [],
  }).ok, true);
  assert.equal(partial.assessment().status, "partial");
  const blocked = new CompletionTracker();
  assert.equal(blocked.accept({
    status: "blocked",
    checks: [{ criterion: "端到端", status: "not-run", evidenceCallIds: [] }],
    blockers: ["缺少测试服务"],
  }).ok, true);
  assert.equal(blocked.assessment().status, "blocked");
});

test("为模型提供短证据 ID，并在新运行开始时清空旧证据", () => {
  let run = 0;
  const tracker = new CompletionTracker({ createRunId: () => `run${++run}` });
  const evidenceId = tracker.record({
    call: { id: "opaque-provider-call-id", name: "read_file", argumentsJson: "{}" },
    result: successfulToolResult({}),
    iteration: 1,
    sequence: 0,
    mutability: "read-only",
  });
  assert.equal(evidenceId, "e_run1_1");
  assert.equal(tracker.evidenceId("opaque-provider-call-id"), "e_run1_1");
  assert.equal(tracker.accept({
    status: "complete",
    checks: [{ criterion: "读取验证", status: "passed", evidenceCallIds: ["e_run1_1"] }],
    blockers: [],
  }).ok, true);

  tracker.beginRun();
  assert.equal(tracker.evidenceId("opaque-provider-call-id"), undefined);
  assert.equal(tracker.assessment().status, "unverified");
  const nextEvidenceId = tracker.record({
    call: { id: "next-call", name: "read_file", argumentsJson: "{}" },
    result: successfulToolResult({}),
    iteration: 1,
    sequence: 0,
    mutability: "read-only",
  });
  assert.equal(nextEvidenceId, "e_run2_1");
  assert.equal(tracker.accept({
    status: "complete",
    checks: [{ criterion: "旧证据", status: "passed", evidenceCallIds: ["e_run1_1"] }],
    blockers: [],
  }).ok, false);
});
