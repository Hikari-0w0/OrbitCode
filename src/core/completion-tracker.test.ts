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

test("写入成功不能作为 passed 项的验证证据", () => {
  const tracker = new CompletionTracker();
  tracker.record({
    call: { id: "write", name: "write_file", argumentsJson: "{}" },
    result: successfulToolResult({}, "applied"),
    iteration: 1,
    sequence: 0,
    mutability: "workspace-write",
  });
  tracker.record({
    call: {
      id: "build",
      name: "run_command",
      argumentsJson: '{"command":"npm run build"}',
    },
    result: successfulToolResult({ exitCode: 0 }, "possible"),
    iteration: 2,
    sequence: 0,
    mutability: "command",
  });

  const result = tracker.accept({
    status: "complete",
    checks: [
      {
        criterion: "目标文件内容正确",
        status: "passed",
        evidenceCallIds: ["write"],
      },
      {
        criterion: "npm run build 无编译错误",
        status: "passed",
        evidenceCallIds: ["build"],
      },
    ],
    blockers: [],
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /写入成功不能替代验证/u);
});

test("构建检查不能用启动进程的成功结果冒充", () => {
  const tracker = new CompletionTracker();
  tracker.record({
    call: {
      id: "build",
      name: "run_command",
      argumentsJson: '{"command":"cd kanban && npm run build"}',
    },
    result: successfulToolResult({ exitCode: 0 }, "possible"),
    iteration: 1,
    sequence: 0,
    mutability: "command",
  });
  tracker.record({
    call: {
      id: "server",
      name: "start_process",
      argumentsJson: '{"command":"cd kanban && npm run dev","ready_port":3000}',
    },
    result: successfulToolResult({ status: "running" }, "possible"),
    iteration: 2,
    sequence: 0,
    mutability: "command",
  });

  const rejected = tracker.accept({
    status: "complete",
    checks: [{
      criterion: "npm run build 无编译错误",
      status: "passed",
      evidenceCallIds: ["server"],
    }],
    blockers: [],
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.match(rejected.message, /构建证据/u);

  assert.equal(tracker.accept({
    status: "complete",
    checks: [{
      criterion: "npm run build 无编译错误",
      status: "passed",
      evidenceCallIds: ["build"],
    }],
    blockers: [],
  }).ok, true);
});

test("lint 检查必须引用真实的 lint 命令", () => {
  const tracker = new CompletionTracker();
  for (const [id, command, iteration] of [
    ["build", "npm run build", 1],
    ["lint", "npm run lint", 2],
  ] as const) {
    tracker.record({
      call: { id, name: "run_command", argumentsJson: JSON.stringify({ command }) },
      result: successfulToolResult({ exitCode: 0 }, "possible"),
      iteration,
      sequence: 0,
      mutability: "command",
    });
  }

  assert.equal(tracker.accept({
    status: "complete",
    checks: [{
      criterion: "npm run lint 无错误",
      status: "passed",
      evidenceCallIds: ["build"],
    }],
    blockers: [],
  }).ok, false);
  assert.equal(tracker.accept({
    status: "complete",
    checks: [{
      criterion: "npm run lint 无错误",
      status: "passed",
      evidenceCallIds: ["lint"],
    }],
    blockers: [],
  }).ok, true);
});

test("不能遗漏最后一次仍失败的质量检查后声明 complete", () => {
  const tracker = new CompletionTracker();
  tracker.record({
    call: {
      id: "lint-failed",
      name: "run_command",
      argumentsJson: '{"command":"npm run lint"}',
    },
    result: toolFailure("command-failed", "lint 失败"),
    iteration: 1,
    sequence: 0,
    mutability: "command",
  });
  tracker.record({
    call: {
      id: "build-passed",
      name: "run_command",
      argumentsJson: '{"command":"npm run build"}',
    },
    result: successfulToolResult({ exitCode: 0 }, "possible"),
    iteration: 2,
    sequence: 0,
    mutability: "command",
  });

  const omittedFailure = tracker.accept({
    status: "complete",
    checks: [{
      criterion: "npm run build 无编译错误",
      status: "passed",
      evidenceCallIds: ["build-passed"],
    }],
    blockers: [],
  });
  assert.equal(omittedFailure.ok, false);
  if (!omittedFailure.ok) assert.match(omittedFailure.message, /lint.*仍失败/iu);

  tracker.record({
    call: {
      id: "lint-passed",
      name: "run_command",
      argumentsJson: '{"command":"npm run lint"}',
    },
    result: successfulToolResult({ exitCode: 0 }, "possible"),
    iteration: 3,
    sequence: 0,
    mutability: "command",
  });
  assert.equal(tracker.accept({
    status: "complete",
    checks: [
      {
        criterion: "npm run build 无编译错误",
        status: "passed",
        evidenceCallIds: ["build-passed"],
      },
      {
        criterion: "npm run lint 无错误",
        status: "passed",
        evidenceCallIds: ["lint-passed"],
      },
    ],
    blockers: [],
  }).ok, true);
});

test("不同工作目录的质量检查不能互相覆盖失败状态", () => {
  const tracker = new CompletionTracker();
  for (const [id, cwd, ok, iteration] of [
    ["lint-a-failed", "packages/a", false, 1],
    ["lint-b-passed", "packages/b", true, 2],
  ] as const) {
    tracker.record({
      call: {
        id,
        name: "run_command",
        argumentsJson: JSON.stringify({ command: "npm run lint", cwd }),
      },
      result: ok
        ? successfulToolResult({ exitCode: 0 }, "possible")
        : toolFailure("command-failed", "lint 失败"),
      iteration,
      sequence: 0,
      mutability: "command",
    });
  }

  const result = tracker.accept({
    status: "complete",
    checks: [{
      criterion: "packages/b 的 npm run lint 无错误",
      status: "passed",
      evidenceCallIds: ["lint-b-passed"],
    }],
    blockers: [],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /lint.*仍失败/iu);
});

test("HTTP 检查不能用其他端口的响应冒充", () => {
  const tracker = new CompletionTracker();
  for (const [id, port, iteration] of [
    ["http-3001", 3001, 1],
    ["http-3000", 3000, 2],
  ] as const) {
    tracker.record({
      call: {
        id,
        name: "run_command",
        argumentsJson: JSON.stringify({
          command: `curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}/`,
        }),
      },
      result: successfulToolResult({ stdout: "200", exitCode: 0 }, "possible"),
      iteration,
      sequence: 0,
      mutability: "command",
    });
  }

  assert.equal(tracker.accept({
    status: "complete",
    checks: [{
      criterion: "curl localhost:3000 返回 200",
      status: "passed",
      evidenceCallIds: ["http-3001"],
    }],
    blockers: [],
  }).ok, false);
  assert.equal(tracker.accept({
    status: "complete",
    checks: [{
      criterion: "curl localhost:3000 返回 200",
      status: "passed",
      evidenceCallIds: ["http-3000"],
    }],
    blockers: [],
  }).ok, true);
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
