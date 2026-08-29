import assert from "node:assert/strict";
import test from "node:test";

import { evaluatePermission } from "@/core/permissions/evaluator";
import { parsePermissionRule } from "@/core/permissions/rules";
import type { PermissionMode, PermissionSubject } from "@/core/permissions/types";

const targets = new Map([
  ["read_file", "path"],
  ["write_file", "path"],
  ["run_command", "command"],
] as const);

test("无匹配规则时使用三档权限模式矩阵", () => {
  const subjects = [readSubject(), writeSubject(), commandSubject()] as const;
  const expected: Record<PermissionMode, readonly string[]> = {
    strict: ["ask", "ask", "ask"],
    default: ["allow", "ask", "ask"],
    permissive: ["allow", "allow", "allow"],
  };
  for (const mode of Object.keys(expected) as PermissionMode[]) {
    assert.deepEqual(
      subjects.map((subject) => evaluatePermission({ subject, rules: [], mode }).kind),
      expected[mode],
    );
  }
});

test("显式规则覆盖模式默认值且保持固定冲突优先级", () => {
  const rules = [
    parsePermissionRule({ expression: "write_file(src/**)", decision: "allow", source: "user", toolTargets: targets }),
    parsePermissionRule({ expression: "write_file(src/index.ts)", decision: "ask", source: "project", toolTargets: targets }),
    parsePermissionRule({ expression: "write_file(src/*)", decision: "deny", source: "local", toolTargets: targets }),
  ];
  const result = evaluatePermission({ subject: writeSubject(), rules, mode: "permissive" });
  assert.equal(result.kind, "deny");
  assert.equal(result.reason.source, "rules");
});

function readSubject(): PermissionSubject {
  return { kind: "path", toolName: "read_file", toolKind: "read", requestedPath: "README.md", canonicalRelativePath: "README.md" };
}

function writeSubject(): PermissionSubject {
  return { kind: "path", toolName: "write_file", toolKind: "write", requestedPath: "src/index.ts", canonicalRelativePath: "src/index.ts" };
}

function commandSubject(): PermissionSubject {
  return { kind: "command", toolName: "run_command", toolKind: "command", command: "npm test", canonicalCwd: "." };
}
