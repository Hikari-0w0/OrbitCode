import assert from "node:assert/strict";
import test from "node:test";

import { preflightCommand } from "@/tools/command-preflight";

test("拒绝 JSON-as-command、整串引号和重复 cwd", () => {
  for (const input of [
    { command: '{"command":"npm test"}' },
    { command: "'npm test'" },
    { command: "cd server && npm test", cwd: "server" },
    { command: 'cd "apps/web"; npm test', cwd: "./apps/web/" },
  ]) {
    const issues = preflightCommand(input);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.path, "$.command");
  }
});

test("保留正常复合命令、JSON 参数和不同目录切换", () => {
  for (const input of [
    { command: "npm test" },
    { command: "node -e 'console.log(JSON.stringify({ ok: true }))'" },
    { command: "curl -d '{\"ok\":true}' http://127.0.0.1:3000" },
    { command: "cd fixtures && npm test", cwd: "server" },
  ]) {
    assert.deepEqual(preflightCommand(input), []);
  }
});
