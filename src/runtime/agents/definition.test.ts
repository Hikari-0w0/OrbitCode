import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseAgentRole } from "./definition";
test("旧角色白黑名单中的已下线工具可读但不再生效", async () => {
  const text = await readFile("agents/explorer.md", "utf8");
  const role = parseAgentRole(text.replace("allowed-tools: [", "allowed-tools: [report_completion, ").replace("disallowed-tools: [", "disallowed-tools: [report_completion, "));
  assert.ok(role.allowedTools.includes("read_file"));
  assert.ok(!role.allowedTools.includes("report_completion"));
  assert.ok(!role.disallowedTools.includes("report_completion"));
});
test("内置角色严格校验并冻结，未知字段/轮次/工具拒绝", async () => {
  const text = await readFile("agents/explorer.md", "utf8");
  const role = parseAgentRole(text);
  assert.equal(role.name, "explorer"); assert.ok(Object.isFrozen(role));
  for (const modified of [text.replace('model: inherit','model: inherit\nunknown: x'),text.replace('max-iterations: 16','max-iterations: 0'),text.replace('read_file','unknown_tool')]) assert.throws(() => parseAgentRole(modified));
});
test('YAML 引用标签与大小边界拒绝，不接受含糊角色定义',async()=>{
 const text=await readFile('agents/explorer.md','utf8');
 for(const invalid of [text.replace('model: inherit','model: &model inherit'),text.replace('model: inherit','model: !custom inherit'),text.replace('model: inherit','model: inherit\nmodel: other'),text.replace('model: inherit','model: [*missing]'),text+'x'.repeat(65536),text.replace('description: 只读探索代码与上下文','description: '+ 'a'.repeat(201))])assert.throws(()=>parseAgentRole(invalid));
});
