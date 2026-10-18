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

test("后续同类质量检查成功可跨工作目录收敛早期失败", () => {
  const tracker = new CompletionTracker();
  tracker.record({
    call: {
      id: "typecheck-malformed",
      name: "run_command",
      argumentsJson: JSON.stringify({ command: '"npx tsc --noEmit", "cwd">"kanban"' }),
    },
    result: toolFailure("command-failed", "命令格式错误"),
    iteration: 1,
    sequence: 0,
    mutability: "command",
  });
  tracker.record({
    call: {
      id: "typecheck-passed",
      name: "run_command",
      argumentsJson: JSON.stringify({ command: "npm run typecheck", cwd: "kanban" }),
    },
    result: successfulToolResult({ exitCode: 0 }, "possible"),
    iteration: 2,
    sequence: 0,
    mutability: "command",
  });

  const result = tracker.accept({
    status: "complete",
    checks: [{
      criterion: "TypeScript 类型检查通过",
      status: "passed",
      evidenceCallIds: ["typecheck-passed"],
    }],
    blockers: [],
  });
  assert.equal(result.ok, true);
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

test("脚本和 Node 测试的 HTTP 证据不要求顶层命令出现 curl", () => {
  for (const command of ["bash test/smoke-http.sh http://127.0.0.1:3417", "npm test"]) {
    const tracker = new CompletionTracker();
    tracker.record({
      call: { id: "http-script", name: "run_command", argumentsJson: JSON.stringify({ command }) },
      result: successfulToolResult({ stdout: "HTTP assertions passed", exitCode: 0 }),
      iteration: 1, sequence: 0, mutability: "command",
    });
    for (const criterion of ["冒烟检查通过", "HTTP 冒烟检查通过，返回 200"]) {
      assert.equal(tracker.accept({
        checks: [{ criterion, status: "passed", evidenceCallIds: ["http-script"] }],
        blockers: [],
      }).ok, true);
    }
  }
});

test("完成状态由检查项计算，兼容旧声明且保留未验证项", () => {
  for (const status of [undefined, "complete"] as const) {
    const tracker = new CompletionTracker();
    const result = tracker.accept({
      ...(status === undefined ? {} : { status }),
      checks: [{ criterion: "浏览器交互", status: "not-run", evidenceCallIds: [] }],
      blockers: [],
    });
    assert.equal(result.ok, true);
    assert.equal(tracker.assessment().status, "partial");
    assert.equal(tracker.assessment().checks[0]?.status, "not-run");
  }
});

test("报告被拒绝后保留合法检查并降级无效证据", () => {
  const tracker = new CompletionTracker();
  tracker.record({
    call: { id: "check", name: "read_file", argumentsJson: "{}" },
    result: successfulToolResult({}), iteration: 1, sequence: 0, mutability: "read-only",
  });
  assert.equal(tracker.accept({ checks: [
    { criterion: "文件内容", status: "passed", evidenceCallIds: ["check"] },
    { criterion: "浏览器交互", status: "passed", evidenceCallIds: ["invented"] },
  ], blockers: [] }).ok, false);
  assert.deepEqual(tracker.assessment(), { status: "unverified", checks: [
    { criterion: "文件内容", status: "passed", evidenceCallIds: ["check"] },
    { criterion: "浏览器交互", status: "not-run", evidenceCallIds: [] },
  ], blockers: [] });
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

test("真实模型报告同时定位失败证据与仅写入证据，修正后可接受", () => {
  const tracker = new CompletionTracker();
  tracker.record({ call: { id: "before", name: "run_command", argumentsJson: '{"command":"node sum.test.mjs"}' },
    result: toolFailure("command-failed", "Reduce of empty array"), iteration: 1, sequence: 0, mutability: "command" });
  tracker.record({ call: { id: "edit", name: "edit_file", argumentsJson: '{}' },
    result: successfulToolResult({}, "applied"), iteration: 2, sequence: 0, mutability: "workspace-write" });
  tracker.record({ call: { id: "after", name: "run_command", argumentsJson: '{"command":"node sum.test.mjs"}' },
    result: successfulToolResult({ exitCode: 0 }), iteration: 3, sequence: 0, mutability: "command" });
  const result = tracker.accept({ status: "complete", blockers: [], checks: [
    { criterion: "复现原有失败", status: "passed", evidenceCallIds: ["before", "after"] },
    { criterion: "修改后内容正确", status: "passed", evidenceCallIds: ["edit"] },
    { criterion: "测试通过", status: "passed", evidenceCallIds: ["after"] },
  ] });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.issues.map((issue) => issue.path), [
    "checks[0].evidence_call_ids[0]", "checks[1].evidence_call_ids",
  ]);
  assert.match(result.issues[0].message, /before.*失败/);
  assert.match(result.issues[1].message, /写入成功不能替代验证/);
  assert.equal(tracker.assessment().status, "unverified");
  assert.equal(tracker.accept({ status: "complete", blockers: [], checks: [
    { criterion: "修复后空数组和含负数数组测试通过", status: "passed", evidenceCallIds: ["after"] },
  ] }).ok, true);
});

test("缺失证据与未运行项的错误引用一次反馈，不捏造后续检查状态", () => {
  const tracker = new CompletionTracker();
  tracker.record({ call: { id: "edit", name: "edit_file", argumentsJson: '{}' },
    result: successfulToolResult({}, "applied"), iteration: 1, sequence: 0, mutability: "workspace-write" });
  const result = tracker.accept({ status: "complete", blockers: [], checks: [
    { criterion: "测试通过", status: "passed", evidenceCallIds: ["missing"] },
    { criterion: "未测试", status: "not-run", evidenceCallIds: ["edit"] },
  ] });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.issues.map((issue) => issue.path), [
    "checks[0].evidence_call_ids[0]", "checks[1].evidence_call_ids",
  ]);
  assert.equal(tracker.assessment().status, "unverified");
});

test("省略旧 status 仍拒绝未收敛的质量门禁和过期验证", () => {
  const tracker = new CompletionTracker();
  tracker.record({ call: { id: "read", name: "read_file", argumentsJson: "{}" },
    result: successfulToolResult({}), iteration: 1, sequence: 0, mutability: "read-only" });
  tracker.record({ call: { id: "write", name: "write_file", argumentsJson: "{}" },
    result: successfulToolResult({}, "applied"), iteration: 2, sequence: 0, mutability: "workspace-write" });
  const oldEvidence = tracker.accept({ checks: [
    { criterion: "读取检查", status: "passed", evidenceCallIds: ["read"] },
  ], blockers: [] });
  assert.equal(oldEvidence.ok, false);
  if (!oldEvidence.ok) assert.match(oldEvidence.message, /最后写入之后/);
  tracker.record({ call: { id: "lint", name: "run_command", argumentsJson: '{"command":"npm run lint"}' },
    result: toolFailure("command-failed", "lint 失败"), iteration: 3, sequence: 0, mutability: "command" });
  const failedGate = tracker.accept({ checks: [
    { criterion: "读取检查", status: "passed", evidenceCallIds: ["read"] },
  ], blockers: [] });
  assert.equal(failedGate.ok, false);
  if (!failedGate.ok) assert.match(failedGate.message, /lint.*仍失败/);
});

test("报告通过后再次写入会使旧评估失效", () => {
  const tracker = new CompletionTracker();
  tracker.record({ call: { id: "read", name: "read_file", argumentsJson: "{}" },
    result: successfulToolResult({}), iteration: 1, sequence: 0, mutability: "read-only" });
  const report = { checks: [{ criterion: "文件检查", status: "passed" as const, evidenceCallIds: ["read"] }], blockers: [] };
  assert.equal(tracker.accept(report).ok, true);
  assert.equal(tracker.assessment().status, "verified");
  tracker.record({ call: { id: "write", name: "write_file", argumentsJson: "{}" },
    result: successfulToolResult({}, "applied"), iteration: 2, sequence: 0, mutability: "workspace-write" });
  assert.equal(tracker.assessment().status, "unverified");
  assert.equal(tracker.accept(report).ok, false);
});

test("外部调用范围只确认一次成功返回，不能冒充本地验证或写入后验证", () => {
  const tracker = new CompletionTracker();
  tracker.record({ call: { id: "external", name: "mcp__demo__echo", argumentsJson: "{}" }, result: successfulToolResult({}, "possible"), iteration: 1, sequence: 0, mutability: "external" });
  const check = { criterion: "声称已完成构建", status: "passed" as const, evidenceCallIds: ["external"] };
  assert.equal(tracker.accept({ status: "complete", checks: [check], blockers: [] }).ok, false);
  const scoped = { ...check, scope: "external-call" as const };
  assert.equal(tracker.accept({ status: "complete", checks: [scoped], blockers: [] }).ok, true);
  assert.equal(tracker.assessment().status, "observed");
  assert.match(tracker.assessment().checks[0].criterion, /仅确认调用返回/u);
  assert.doesNotMatch(tracker.assessment().checks[0].criterion, /构建/u);
  tracker.record({ call: { id: "print", name: "run_command", argumentsJson: JSON.stringify({ command: "printf '固定文本'" }) }, result: successfulToolResult({}, "possible"), iteration: 2, sequence: 0, mutability: "command" });
  assert.equal(tracker.accept({ status: "complete", checks: [{ ...check, evidenceCallIds: ["external", "print"] }], blockers: [] }).ok, false);
  assert.equal(tracker.accept({ status: "complete", checks: [{ ...scoped, evidenceCallIds: ["print"] }], blockers: [] }).ok, false);
  tracker.record({ call: { id: "write", name: "write_file", argumentsJson: "{}" }, result: successfulToolResult({}, "applied"), iteration: 3, sequence: 0, mutability: "workspace-write" });
  assert.equal(tracker.accept({ status: "complete", checks: [scoped], blockers: [] }).ok, false);
});

test("没有模型完成报告时，外部工具成功和失败均只记录调用结果", () => {
  const tracker = new CompletionTracker({ createRunId: () => "external_observation" });
  tracker.record({ call: { id: "ok", name: "mcp__demo__search", argumentsJson: "{}" },
    result: successfulToolResult({}, "possible"), iteration: 1, sequence: 0, mutability: "external" });
  tracker.record({ call: { id: "failed", name: "mcp__demo__search", argumentsJson: "{}" },
    result: toolFailure("mcp-tool-error", "查询失败", { retryable: true }), iteration: 2, sequence: 0, mutability: "external" });
  assert.deepEqual(tracker.assessment(), {
    status: "observed", blockers: [], checks: [
      { scope: "external-call", criterion: "外部工具调用结果：mcp__demo__search（仅记录调用返回，不验证答复内容）", status: "passed", evidenceCallIds: ["e_external_observation_1"] },
      { scope: "external-call", criterion: "外部工具调用结果：mcp__demo__search（仅记录调用返回，不验证答复内容）", status: "failed", evidenceCallIds: ["e_external_observation_2"] },
    ],
  });
});

test("读取外部结果的上下文引用不抹去有限的外部调用观察状态", () => {
  const tracker = new CompletionTracker({ createRunId: () => "external_context" });
  tracker.record({ call: { id: "search", name: "mcp__docs__search", argumentsJson: "{}" },
    result: successfulToolResult({}, "possible"), iteration: 1, sequence: 0, mutability: "external" });
  tracker.record({ call: { id: "page", name: "read_context", argumentsJson: "{}" },
    result: successfulToolResult({}, "none"), iteration: 2, sequence: 0, mutability: "read-only" });
  assert.deepEqual(tracker.assessment(), {
    status: "observed", blockers: [], checks: [
      { scope: "external-call", criterion: "外部工具调用结果：mcp__docs__search（仅记录调用返回，不验证答复内容）", status: "passed", evidenceCallIds: ["e_external_context_1"] },
    ],
  });
});
