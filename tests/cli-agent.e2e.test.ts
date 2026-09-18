import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture";
import { textDelta, toolCallDelta, TOOL_FINISH_EVENT, TRANSPORT_DONE_EVENT, DONE_EVENT } from "./helpers/openai-mock";

test("CLI 共用完整工具集合，读取编辑验证并持久化 CLI 来源", async () => {
  let calls = 0;
  const fixture = await runtimeFixture(() => {
    calls++;
    const call = calls === 1 ? { name: "read_file", argumentsJson: '{"path":"a.txt"}' }
      : calls === 2 ? { name: "edit_file", argumentsJson: '{"path":"a.txt","old_text":"before","new_text":"after"}' }
      : calls === 3 ? { name: "read_file", argumentsJson: '{"path":"a.txt"}' } : undefined;
    return { chunks: [{ data: call ? toolCallDelta({ id: `call_${calls}`, ...call }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT : textDelta("完成") + DONE_EVENT }] };
  });
  try {
    await writeFile(path.join(fixture.root, "a.txt"), "before");
    await fixture.controller.handleLine("/permissions permissive");
    await fixture.controller.handleLine("修改并读取验证");
    assert.equal(await readFile(path.join(fixture.root, "a.txt"), "utf8"), "after");
    assert.equal(calls, 4);
    assert.match(JSON.stringify(fixture.server.requests[3].body), /after/);
    for (const name of ["read_file", "write_file", "write_files", "edit_file", "find_files", "search_code", "run_command", "read_context", "start_process", "process_status", "stop_process", "report_completion"])
      assert.match(JSON.stringify(fixture.server.requests[0].body), new RegExp(name));
    const saved = await fixture.checkpoint();
    assert.equal(saved.summary.revision, 1);
    assert.equal(saved.displayMessages[1].toolExecutions?.length, 3);
    const runs = await fixture.log.findAllForConversation(saved.summary.id);
    assert.equal(runs[0].source, "cli");
    assert.equal(runs[0].persistence.status, "saved");
    await fixture.controller.handleLine("/tool call_3");
    assert.match(fixture.output(), /after/);
    assert.equal(fixture.errors(), "");
    assert.doesNotMatch(fixture.output(), /synthetic-fixture-secret/);
  } finally { await fixture.close(); }
});

test("Plan 硬拒绝伪造写入，成功计划显式执行后才可写", async () => {
  let call = 0;
  const fixture = await runtimeFixture(() => ({ chunks: [{ data: ++call === 1
    ? toolCallDelta({ id: "forged", name: "write_file", argumentsJson: '{"path":"forged.txt","content":"no"}' }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT
    : textDelta("分析计划") + DONE_EVENT }] }));
  try {
    await fixture.controller.handleLine("/plan"); assert.equal(call, 0);
    await fixture.controller.handleLine("分析");
    await assert.rejects(readFile(path.join(fixture.root, "forged.txt")));
    assert.equal((await fixture.checkpoint()).mode, "plan");
    await fixture.controller.handleLine("/execute-plan");
    const checkpoint = await fixture.checkpoint();
    assert.equal(checkpoint.mode, "do");
    assert.match(JSON.stringify(checkpoint.displayMessages), /请按照上述计划开始执行/);
    const before = call;
    await fixture.controller.handleLine("/execute-plan");
    assert.equal(call, before); assert.match(fixture.errors(), /没有可执行/);
  } finally { await fixture.close(); }
});

test("重复工具调用达到最大轮数，只记录一个终止并释放租约", async () => {
  let count = 0;
  const fixture = await runtimeFixture(() => ({ chunks: [{ data: toolCallDelta({ id: `c${++count}`, name: "read_file", argumentsJson: '{"path":"a.txt"}' }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT }] }), { iterations: "2" });
  try {
    await writeFile(path.join(fixture.root, "a.txt"), "ok");
    await fixture.controller.handleLine("持续读取");
    assert.match(fixture.output(), /停止：max-iterations/);
    assert.equal(fixture.output().split("停止：").length - 1, 1);
    const c = await fixture.checkpoint();
    assert.deepEqual(await fixture.guard.inspect(c.summary.id), { status: "idle" });
    assert.equal(fixture.controller.exitCode, 1);
  } finally { await fixture.close(); }
});

test("CLI 在真实命令失败后编辑修复，再执行验证成功", { skip: process.platform !== "darwin" }, async () => {
  const steps = [
    { name: "write_file", argumentsJson: JSON.stringify({ path: "verify.js", content: "process.exit(1);\n" }) },
    { name: "run_command", argumentsJson: JSON.stringify({ command: "node verify.js", timeout_ms: 5000 }) },
    { name: "edit_file", argumentsJson: JSON.stringify({ path: "verify.js", old_text: "process.exit(1);", new_text: "console.log('verified');" }) },
    { name: "run_command", argumentsJson: JSON.stringify({ command: "node verify.js", timeout_ms: 5000 }) },
  ];
  let index = 0;
  const fixture = await runtimeFixture(() => {
    const step = steps[index++];
    return { chunks: [{ data: step ? toolCallDelta({ id: `repair_${index}`, ...step }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT : textDelta("修复并验证完成") + DONE_EVENT }] };
  });
  try {
    await fixture.controller.handleLine("/permissions permissive");
    await fixture.controller.handleLine("创建脚本，失败后修复并验证");
    const c = await fixture.checkpoint();
    const results = c.displayMessages[1].toolExecutions ?? [];
    assert.equal(results.length, 4);
    assert.equal(results[1].result.ok, false);
    assert.equal(results[3].result.ok, true);
    assert.match(JSON.stringify(results[3].result), /verified/);
    assert.match(JSON.stringify(fixture.server.requests[2].body), /command-failed/);
    assert.match(await readFile(path.join(fixture.root, "verify.js"), "utf8"), /console.log/);
    assert.equal(fixture.errors(), "");
  } finally { await fixture.close(); }
});

test("CLI 批量写入、搜索、受管进程和完成报告均经过共享工具执行", { skip: process.platform !== "darwin" }, async () => {
  let step = 0;
  const fixture = await runtimeFixture((request) => {
    const names = ["write_files", "find_files", "search_code", "start_process", "process_status", "stop_process", "report_completion"];
    const name = names[step++];
    if (!name) return { chunks: [{ data: textDelta("按实际检查范围报告") + DONE_EVENT }] };
    const body = request.body;
    let processId = "";
    if (body && typeof body === "object" && "messages" in body && Array.isArray(body.messages)) {
      const messages: readonly unknown[] = body.messages;
      for (const message of messages) {
        if (!message || typeof message !== "object" || !("role" in message) || message.role !== "tool" || !("content" in message) || typeof message.content !== "string") continue;
        const data: unknown = JSON.parse(message.content);
        if (data && typeof data === "object" && "output" in data && data.output && typeof data.output === "object" && "processId" in data.output && typeof data.output.processId === "string") processId = data.output.processId;
      }
    }
    const args = name === "write_files" ? { files: [{ path: "batch-a.txt", content: "find-marker" }, { path: "batch-b.txt", content: "other" }] }
      : name === "find_files" ? { pattern: "batch-*.txt" }
      : name === "search_code" ? { query: "find-marker", file_pattern: "batch-*.txt" }
      : name === "start_process" ? { command: "sleep 20" }
      : name === "report_completion" ? { status: "blocked", checks: [{ criterion: "未验证业务交互", status: "not-run", evidence_call_ids: [] }], blockers: ["仅执行工具接入验证"] }
      : { process_id: processId };
    return { chunks: [{ data: toolCallDelta({ id: `extra_${step}`, name, argumentsJson: JSON.stringify(args) }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT }] };
  }, { iterations: "12" });
  try {
    await fixture.controller.handleLine("/permissions permissive");
    await fixture.controller.handleLine("测试其余工具接入");
    const c = await fixture.checkpoint();
    const results = c.displayMessages[1].toolExecutions ?? [];
    assert.equal(results.length, 7);
    for (const result of results) assert.equal(result.result.ok, true, JSON.stringify(result));
    assert.equal(c.displayMessages[1].verification?.status, "blocked");
    assert.match(fixture.output(), /仅覆盖所列检查/);
  } finally { await fixture.close(); }
});

test("完成报告的全部错误回传模型，修正后正常结束且保留失败历史", async () => {
  let requests = 0;
  let feedback = "";
  const fixture = await runtimeFixture((request) => {
    requests++;
    if (requests === 5) feedback = JSON.stringify(request.body);
    const steps = [
      { name: "read_file", argumentsJson: '{"path":"missing.txt"}' },
      { name: "edit_file", argumentsJson: '{"path":"a.txt","old_text":"before","new_text":"after"}' },
      { name: "read_file", argumentsJson: '{"path":"a.txt"}' },
      { name: "report_completion", argumentsJson: JSON.stringify({ status: "complete", blockers: [], checks: [
        { criterion: "复现读取失败", status: "passed", evidence_call_ids: ["recovery_1"] },
        { criterion: "文件内容正确", status: "passed", evidence_call_ids: ["recovery_2"] },
        { criterion: "读取最终文件验证", status: "passed", evidence_call_ids: ["recovery_3"] },
      ] }) },
      { name: "report_completion", argumentsJson: JSON.stringify({ status: "complete", blockers: [], checks: [
        { criterion: "修改后的文件内容为 after", status: "passed", evidence_call_ids: ["recovery_3"] },
      ] }) },
    ];
    const step = steps[requests - 1];
    return { chunks: [{ data: step ? toolCallDelta({ id: `recovery_${requests}`, ...step }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT
      : textDelta("已修改并读取验证；此前读取不存在文件失败。") + DONE_EVENT }] };
  });
  try {
    await writeFile(path.join(fixture.root, "a.txt"), "before");
    await fixture.controller.handleLine("/permissions permissive");
    await fixture.controller.handleLine("修改并验证文件");
    assert.match(feedback, /checks\[0\]\.evidence_call_ids\[0\]/);
    assert.match(feedback, /checks\[1\]\.evidence_call_ids/);
    assert.ok(feedback.includes(String.raw`\"issues\":[`));
    assert.equal(requests, 6);
    const checkpoint = await fixture.checkpoint();
    const executions = checkpoint.displayMessages[1].toolExecutions;
    assert.equal(executions?.find((entry) => entry.callId === "recovery_4")?.result?.ok, false);
    assert.equal(executions?.find((entry) => entry.callId === "recovery_5")?.result?.ok, true);
    assert.match(fixture.output(), /停止：final-response/);
    assert.match(fixture.output(), /"status": "verified"/);
    assert.equal(await readFile(path.join(fixture.root, "a.txt"), "utf8"), "after");
  } finally { await fixture.close(); }
});
