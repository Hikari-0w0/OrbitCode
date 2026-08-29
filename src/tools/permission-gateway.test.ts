import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parsePermissionRule } from "@/core/permissions/rules";
import type {
  PermissionDecision,
  PermissionRule,
} from "@/core/permissions/types";
import {
  PermissionGateway,
  type PermissionAuthorization,
} from "@/tools/permission-gateway";
import type { PreparedToolCall } from "@/tools/registry";
import { createWorkspaceBoundary } from "@/tools/workspace";
import {
  PermissionSessionManager,
  type PermissionTurnHandle,
} from "@/web/permission-session-manager";

const toolTargets = new Map([
  ["read_file", "path"],
  ["write_file", "path"],
  ["run_command", "command"],
] as const);

test("Plan 模式在路径解析和工具执行前拒绝写入", async () => {
  const fixture = await createFixture();
  try {
    let executed = 0;
    const call = preparedPath("write_file", "missing/target.ts", "write-target", () => executed++);
    const authorization = await fixture.gateway({ agentMode: "plan", permissionMode: "permissive" })
      .authorize(call, "call-plan", new AbortController().signal);
    assertDenied(authorization, "permission-denied");
    assert.equal(executed, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("危险命令不可被放行模式、allow 规则或会话授权覆盖", async () => {
  const fixture = await createFixture();
  try {
    const call = preparedCommand("rm -rf .");
    fixture.rules.push(rule("run_command(*)", "allow"));
    const authorization = await fixture.gateway({ permissionMode: "permissive" })
      .authorize(call, "call-danger", new AbortController().signal);
    assertDenied(authorization, "dangerous-operation");
    assert.equal(fixture.manager.getSession(fixture.sessionId).pendingRequestId, undefined);
  } finally {
    await fixture.cleanup();
  }
});

test("显式 deny 高于 ask/allow，且不创建人工授权", async () => {
  const fixture = await createFixture();
  try {
    fixture.rules.push(
      rule("run_command(git *)", "allow"),
      rule("run_command(git status)", "ask"),
      rule("run_command(git status)", "deny"),
    );
    const authorization = await fixture.gateway()
      .authorize(preparedCommand("git status"), "call-deny", new AbortController().signal);
    assertDenied(authorization, "permission-denied");
    assert.equal(fixture.manager.getSession(fixture.sessionId).pendingRequestId, undefined);
  } finally {
    await fixture.cleanup();
  }
});

test("ask 暂停调用，用户拒绝返回结构化失败", async () => {
  const fixture = await createFixture();
  try {
    const authorization = await fixture.gateway()
      .authorize(preparedCommand("git status"), "call-ask", new AbortController().signal);
    assert.equal(authorization.kind, "awaiting");
    if (authorization.kind !== "awaiting") return;
    fixture.manager.resolveDecision(
      fixture.sessionId,
      authorization.prompt.requestId,
      "deny",
    );
    assertDenied(await authorization.resolve(), "user-denied");
  } finally {
    await fixture.cleanup();
  }
});

test("人工允许后复检目标与规则，新增 deny 使授权失效", async () => {
  const fixture = await createFixture();
  try {
    const call = preparedCommand("git status");
    const authorization = await fixture.gateway().authorize(
      call,
      "call-revalidate",
      new AbortController().signal,
    );
    assert.equal(authorization.kind, "awaiting");
    if (authorization.kind !== "awaiting") return;
    fixture.rules.push(rule("run_command(git status)", "deny"));
    fixture.manager.resolveDecision(
      fixture.sessionId,
      authorization.prompt.requestId,
      "allow-once",
    );
    assertDenied(await authorization.resolve(), "approval-invalid");
  } finally {
    await fixture.cleanup();
  }
});

test("本次授权绑定准备阶段的完整参数指纹", async () => {
  const fixture = await createFixture();
  try {
    const call = preparedCommand("git status");
    const authorization = await fixture.gateway().authorize(
      call,
      "call-fingerprint",
      new AbortController().signal,
    );
    assert.equal(authorization.kind, "awaiting");
    if (authorization.kind !== "awaiting") return;
    Object.assign(call, { fingerprint: "fingerprint:replaced" });
    fixture.manager.resolveDecision(
      fixture.sessionId,
      authorization.prompt.requestId,
      "allow-once",
    );
    assertDenied(await authorization.resolve(), "approval-invalid");
  } finally {
    await fixture.cleanup();
  }
});

test("会话允许只满足相同 ask，不能覆盖后来出现的 deny", async () => {
  const fixture = await createFixture();
  try {
    const call = preparedCommand("git status");
    const first = await fixture.gateway().authorize(
      call,
      "call-session-1",
      new AbortController().signal,
    );
    assert.equal(first.kind, "awaiting");
    if (first.kind !== "awaiting") return;
    fixture.manager.resolveDecision(
      fixture.sessionId,
      first.prompt.requestId,
      "allow-session",
    );
    assert.equal((await first.resolve()).kind, "allowed");

    const reused = await fixture.gateway().authorize(
      call,
      "call-session-2",
      new AbortController().signal,
    );
    assert.equal(reused.kind, "allowed");
    fixture.rules.push(rule("run_command(git status)", "deny"));
    const denied = await fixture.gateway().authorize(
      call,
      "call-session-3",
      new AbortController().signal,
    );
    assertDenied(denied, "permission-denied");
  } finally {
    await fixture.cleanup();
  }
});

test("永久允许写入转义后的精确规则，持久化失败不降级执行", async () => {
  for (const shouldFail of [false, true]) {
    const fixture = await createFixture();
    try {
      const expressions: string[] = [];
      const gateway = fixture.gateway({
        persistAllow: async (expression) => {
          expressions.push(expression);
          if (shouldFail) throw new Error("failure");
        },
      });
      const authorization = await gateway.authorize(
        preparedCommand("echo *.ts?"),
        "call-permanent",
        new AbortController().signal,
      );
      assert.equal(authorization.kind, "awaiting");
      if (authorization.kind !== "awaiting") return;
      fixture.manager.resolveDecision(
        fixture.sessionId,
        authorization.prompt.requestId,
        "allow-permanent",
      );
      const resolved = await authorization.resolve();
      assert.equal(expressions[0], "run_command(echo \\*.ts\\?)");
      if (shouldFail) assertDenied(resolved, "permission-config");
      else assert.equal(resolved.kind, "allowed");
    } finally {
      await fixture.cleanup();
    }
  }
});

test("路径越界在规则和人工授权前失败且无副作用", async () => {
  const fixture = await createFixture();
  try {
    const authorization = await fixture.gateway({ permissionMode: "permissive" })
      .authorize(
        preparedPath("read_file", "../outside.txt", "existing-file"),
        "call-boundary",
        new AbortController().signal,
      );
    assertDenied(authorization, "workspace-boundary");
  } finally {
    await fixture.cleanup();
  }
});

function rule(expression: string, decision: PermissionDecision): PermissionRule {
  return parsePermissionRule({
    expression,
    decision,
    source: "local",
    toolTargets,
  });
}

function assertDenied(
  authorization: PermissionAuthorization,
  errorKind: string,
): void {
  assert.equal(authorization.kind, "denied");
  if (authorization.kind !== "denied") return;
  assert.equal(
    authorization.result.ok ? undefined : authorization.result.error.kind,
    errorKind,
  );
  assert.equal(authorization.result.sideEffect, "none");
}

function preparedCommand(command: string): PreparedToolCall {
  return {
    name: "run_command",
    mutability: "command",
    permissionTarget: { kind: "command", command },
    fingerprint: `fingerprint:${command}`,
    async execute() {
      throw new Error("测试不执行命令");
    },
  };
}

function preparedPath(
  name: "read_file" | "write_file",
  requestedPath: string,
  resolution: "existing-file" | "write-target",
  onExecute: () => void = () => undefined,
): PreparedToolCall {
  return {
    name,
    mutability: name === "read_file" ? "read-only" : "workspace-write",
    permissionTarget: { kind: "path", requestedPath, resolution },
    fingerprint: `fingerprint:${requestedPath}`,
    async execute() {
      onExecute();
      throw new Error("测试不执行文件工具");
    },
  };
}

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-gateway-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "main.ts"), "export {};\n");
  const workspace = await createWorkspaceBoundary(root);
  const manager = new PermissionSessionManager();
  const session = manager.createSession();
  const turn: PermissionTurnHandle = manager.beginTurn(session.id, {
    workspace: { id: "test", name: "测试 Workspace" },
    providerId: "test-provider",
  });
  const rules: PermissionRule[] = [];
  return {
    rules,
    manager,
    sessionId: session.id,
    gateway(options: {
      readonly agentMode?: "plan" | "do";
      readonly permissionMode?: "strict" | "default" | "permissive";
      readonly persistAllow?: (expression: string) => Promise<void>;
    } = {}) {
      return new PermissionGateway({
        agentMode: options.agentMode ?? "do",
        permissionMode: options.permissionMode ?? "default",
        workspace,
        broker: turn.broker,
        loadRules: async () => rules,
        persistAllow: options.persistAllow,
      });
    },
    async cleanup() {
      manager.closeSession(session.id);
      await rm(root, { recursive: true, force: true });
    },
  };
}
