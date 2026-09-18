import assert from "node:assert/strict";
import test from "node:test";
import { parseCliInput } from "@/cli/commands";
test("模式命令严格匹配、路径空格保留、正文可转义", () => {
  assert.deepEqual(parseCliInput("/plan"), { type: "command", name: "plan", argument: "" });
  assert.deepEqual(parseCliInput("/plan 分析"), { type: "message", text: "/plan 分析" });
  assert.deepEqual(parseCliInput("/export my files/result.json"), { type: "command", name: "export", argument: "my files/result.json" });
  assert.deepEqual(parseCliInput("//unknown"), { type: "message", text: "/unknown" });
  assert.throws(() => parseCliInput("/unknown"));
});
