import assert from "node:assert/strict";
import test from "node:test";

import {
  findMatchingPermissionRules,
  formatExactPermissionExpression,
  mergePermissionRuleDecisions,
  parsePermissionRule,
  PermissionRuleError,
} from "@/core/permissions/rules";
import type {
  PermissionDecision,
  PermissionRule,
  PermissionSubject,
} from "@/core/permissions/types";

const targets = new Map([
  ["read_file", "path"],
  ["write_file", "path"],
  ["run_command", "command"],
] as const);

test("解析精确与 Glob 权限规则并按目标类型匹配", () => {
  const rules = [
    rule("read_file(src/index.ts)", "allow", "user"),
    rule("write_file(src/**)", "ask", "project"),
    rule("run_command(git *)", "deny", "local"),
  ];
  assert.equal(rules[0].matchKind, "exact");
  assert.equal(rules[1].matchKind, "glob");
  assert.equal(matches(pathSubject("read_file", "src/index.ts"), rules).length, 1);
  assert.equal(matches(pathSubject("write_file", "src/a/b.ts", "write"), rules).length, 1);
  assert.equal(matches(commandSubject("git status"), rules).length, 1);
  assert.equal(matches(commandSubject("npm test"), rules).length, 0);
});

test("规则冲突只服从 deny 高于 ask 高于 allow", () => {
  const decisions: readonly PermissionDecision[] = ["allow", "ask", "deny"];
  const rules = decisions.map((decision, index) =>
    rule(`run_command(git ${"*".repeat(index + 1)})`, decision, ["user", "project", "local"][index] as "user" | "project" | "local"),
  );
  const merged = mergePermissionRuleDecisions(rules);
  assert.equal(merged?.decision, "deny");
  assert.equal(mergePermissionRuleDecisions(rules.slice(0, 2))?.decision, "ask");
  assert.equal(mergePermissionRuleDecisions([rules[0]])?.decision, "allow");
  assert.equal(mergePermissionRuleDecisions([]), undefined);
});

test("拒绝未知工具、非法括号、越界路径模式和超限命令模式", () => {
  for (const expression of [
    "unknown(*)",
    "read_file",
    "read_file()",
    "read_file(../*)",
    "read_file(/tmp/*)",
    `run_command(${"x".repeat(8 * 1024 + 1)})`,
  ]) {
    assert.throws(
      () => parsePermissionRule({ expression, decision: "allow", source: "user", toolTargets: targets }),
      PermissionRuleError,
    );
  }
});

test("服务端生成的精确规则不会把目标中的通配符扩大为 glob", () => {
  const expression = formatExactPermissionExpression("run_command", "echo *.ts?");
  const parsed = rule(expression, "allow", "local");
  assert.equal(parsed.matchKind, "exact");
  assert.equal(matches(commandSubject("echo *.ts?"), [parsed]).length, 1);
  assert.equal(matches(commandSubject("echo main.tsx"), [parsed]).length, 0);
});

function rule(
  expression: string,
  decision: PermissionDecision,
  source: "user" | "project" | "local",
): PermissionRule {
  return parsePermissionRule({ expression, decision, source, toolTargets: targets });
}

function matches(subject: PermissionSubject, rules: readonly PermissionRule[]) {
  return findMatchingPermissionRules(subject, rules);
}

function pathSubject(
  toolName: string,
  canonicalRelativePath: string,
  toolKind: "read" | "write" = "read",
): PermissionSubject {
  return { kind: "path", toolName, toolKind, requestedPath: canonicalRelativePath, canonicalRelativePath };
}

function commandSubject(command: string): PermissionSubject {
  return { kind: "command", toolName: "run_command", toolKind: "command", command, canonicalCwd: "." };
}
