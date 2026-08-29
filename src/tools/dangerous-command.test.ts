import assert from "node:assert/strict";
import test from "node:test";

import { analyzeDangerousCommand } from "@/tools/dangerous-command";

test("硬拦截危险文件、磁盘、系统、进程和安全控制操作", () => {
  const dangerous = [
    "rm -rf /",
    "rm --recursive --force .",
    "echo ok && rm -fr *",
    "sh -c 'rm -rf /'",
    "echo $(rm -rf /)",
    "dd if=/dev/zero of=/dev/disk2",
    "diskutil eraseDisk APFS Empty disk2",
    "shutdown -h now",
    "sudo npm test",
    "kill -9 -1",
    "git clean -fdx",
    ":(){ :|:& };:",
  ];
  for (const command of dangerous) {
    const result = analyzeDangerousCommand(command, ".");
    assert.equal(result.safe, false, command);
  }
});

test("链式与静态 shell 包装不能隐藏危险操作", () => {
  for (const command of [
    "printf safe; bash -c \"rm -rf /\"",
    "echo `shutdown now`",
    "env TEST=1 command rm -rf ./",
  ]) {
    assert.equal(analyzeDangerousCommand(command, ".").safe, false, command);
  }
});

test("常见安全开发命令不命中危险硬规则", () => {
  for (const command of [
    "git status --short",
    "npm test -- src/tools/workspace.test.ts",
    "rm -f tmp/output.txt",
    "rm -rf build/cache",
    "find src -name '*.ts'",
    "node -e \"console.log('ok')\"",
    "printf '%s' hello | wc -c",
  ]) {
    assert.deepEqual(analyzeDangerousCommand(command, "."), { safe: true }, command);
  }
});

test("无法闭合或超过分析边界的 shell 结构安全拒绝", () => {
  for (const command of ["echo 'unterminated", "echo $(rm -f x", "x".repeat(8 * 1024 + 1)]) {
    const result = analyzeDangerousCommand(command);
    assert.equal(result.safe, false);
    if (!result.safe) assert.equal(result.code, "analysis-limit");
  }
});
