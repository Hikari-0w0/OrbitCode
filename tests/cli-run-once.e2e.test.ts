import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import test from "node:test";

import { AgentRuntime } from "@/runtime/agent-runtime";
import { runOnce } from "@/cli/run-once";
import { LocalConversationStore } from "@/lib/local-conversation-store";
import { LocalAgentRunLog } from "@/lib/local-agent-run-log";
import { LocalSettingsStore } from "@/lib/local-settings-store";
import { SettingsService } from "@/runtime/settings-service";
import { DONE_EVENT, startOpenAIMockServer, textDelta, toolCallDelta, TOOL_FINISH_EVENT, TRANSPORT_DONE_EVENT } from "./helpers/openai-mock";

test("CLI 单次执行等待模型、持久化与运行日志，并输出单个 JSON", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-once-"));
  const dataDir = path.join(root, "data");
  const server = await startOpenAIMockServer(() => ({ chunks: [{ data: textDelta("已回答") + DONE_EVENT }] }));
  try {
    const settings = new SettingsService(new LocalSettingsStore(dataDir));
    await settings.apply(0, { type: "provider-add", displayName: "测试", model: "mock-model", baseUrl: server.baseUrl, windowTokens: 128000, credential: { kind: "local", value: "synthetic-secret" } });
    await settings.apply(1, { type: "workspace-add", name: "临时项目", rootPath: root });
    let output = "";
    const stdout = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
    const stderr = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const exit = await runOnce({ arguments: { type: "run-once", stdin: true, outputFormat: "json", dataDir }, cwd: root,
      environment: {}, input: Readable.from(["请回答\n"]), output: stdout, errorOutput: stderr });
    const result: unknown = JSON.parse(output.trim());
    assert.equal(exit, 0);
    assert.equal(output.trim().split("\n").length, 1);
    assert.ok(typeof result === "object" && result !== null && "outcome" in result && result.outcome === "completed");
    assert.match(output, /已回答/);
    assert.doesNotMatch(output, /synthetic-secret/);
    assert.equal(server.requests.length, 1);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("标准输入未关闭时外层时限仍会终止单次运行", async () => {
  const input = new PassThrough();
  let output = "";
  const stdout = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
  const exit = await runOnce({ arguments: { type: "run-once", stdin: true, outputFormat: "json", timeoutMs: 100 },
    cwd: process.cwd(), environment: {}, input, output: stdout, errorOutput: stdout });
  assert.equal(exit, 124);
  assert.equal(JSON.parse(output).outcome, "timed-out");
  assert.equal(input.destroyed, true);
});

test("CLI JSONL 只输出一个终态，默认直接写入且兼容显式allow策略", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-once-permission-"));
  let requests = 0;
  const server = await startOpenAIMockServer(() => ({ chunks: [{ data: ++requests % 2 === 1
    ? toolCallDelta({ id: `write-${requests}`, name: "write_file", argumentsJson: '{"path":"result.txt","content":"written"}' }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT
    : textDelta("完成") + DONE_EVENT }] }));
  try {
    for (const allowed of [false, true]) {
      requests = 0;
      const dataDir = path.join(root, allowed ? "allowed" : "blocked");
      const service = new SettingsService(new LocalSettingsStore(dataDir));
      await service.apply(0, { type: "provider-add", displayName: "测试", model: "mock-model", baseUrl: server.baseUrl,
        windowTokens: 128000, credential: { kind: "local", value: "synthetic-secret" } });
      await service.apply(1, { type: "workspace-add", name: "临时项目", rootPath: root });
      const policyFile = path.join(root, "allow.yaml");
      if (allowed) await writeFile(policyFile, 'rules:\n  "write_file(result.txt)": allow\n');
      let output = "";
      const stdout = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
      const stderr = new Writable({ write(_chunk, _encoding, done) { done(); } });
      const exit = await runOnce({ arguments: { type: "run-once", stdin: true, outputFormat: "jsonl", dataDir,
        ...(allowed ? { policyFile } : {}) }, cwd: root, environment: {}, input: Readable.from(["请写入文件"]), output: stdout, errorOutput: stderr });
      const events = output.trim().split("\n").map((line) => JSON.parse(line) as { type: string; sequence: number; result?: { outcome: string; policyId: string | null; approvalBlocked: boolean } });
      assert.deepEqual(events.map((event) => event.sequence), events.map((_event, index) => index + 1));
      assert.equal(events.filter((event) => event.type === "finished").length, 1);
      assert.equal(events.at(-1)?.result?.outcome, "completed");
      assert.equal(events.at(-1)?.result?.approvalBlocked, false);
      assert.equal(Boolean(events.at(-1)?.result?.policyId), allowed);
      assert.equal(exit, 0);
      assert.equal(await readFile(path.join(root, "result.txt"), "utf8"), "written");
    }
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});


test("输入阶段 SIGINT 返回 cancelled/130，而不是启动失败", async () => {
  const input = new PassThrough();
  let output = "";
  const stdout = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
  const timer = setTimeout(() => process.emit("SIGINT"), 30);
  try {
    const exit = await runOnce({ arguments: { type: "run-once", stdin: true, outputFormat: "json", timeoutMs: 1000 },
      cwd: process.cwd(), environment: {}, input, output: stdout, errorOutput: stdout });
    assert.equal(exit, 130);
    assert.equal(JSON.parse(output).outcome, "cancelled");
    assert.equal(input.destroyed, true);
  } finally { clearTimeout(timer); }
});

test("已完成模型请求但清理失败时，JSON 终态与非零退出码一致", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-once-cleanup-"));
  const server = await startOpenAIMockServer(() => ({ chunks: [{ data: textDelta("完成") + DONE_EVENT }] }));
  const originalClose = AgentRuntime.prototype.close;
  context.mock.method(AgentRuntime.prototype, "close", async function (this: AgentRuntime) {
    await originalClose.call(this);
    throw new Error("synthetic-cleanup-error");
  });
  try {
    const dataDir = path.join(root, "data");
    const service = new SettingsService(new LocalSettingsStore(dataDir));
    await service.apply(0, { type: "provider-add", displayName: "测试", model: "mock-model", baseUrl: server.baseUrl,
      windowTokens: 128000, credential: { kind: "local", value: "synthetic-secret" } });
    await service.apply(1, { type: "workspace-add", name: "工作区", rootPath: root });
    let output = "";
    const stdout = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
    const exit = await runOnce({ arguments: { type: "run-once", stdin: true, outputFormat: "json", dataDir },
      cwd: root, environment: {}, input: Readable.from(["请回答"]), output: stdout, errorOutput: stdout });
    const result = JSON.parse(output);
    assert.equal(exit, 1);
    assert.equal(result.outcome, "failed");
    assert.equal(result.finalResponse, "完成");
    assert.equal(result.persistence.status, "saved");
    assert.ok(result.runId);
    assert.equal(result.cleanupWarning, "运行资源清理失败。");
    assert.doesNotMatch(output, /synthetic-secret|synthetic-cleanup-error/);
  } finally { context.mock.restoreAll(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

for (const fault of ["save", "log"] as const) test(`单次执行${fault === "save" ? "保存" : "日志"}失败不能输出成功`, async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-once-persistence-"));
  const server = await startOpenAIMockServer(() => ({ chunks: [{ data: textDelta("已回答") + DONE_EVENT }] }));
  try {
    const dataDir = path.join(root, "data");
    const service = new SettingsService(new LocalSettingsStore(dataDir));
    await service.apply(0, { type: "provider-add", displayName: "测试", model: "mock-model", baseUrl: server.baseUrl,
      windowTokens: 128000, credential: { kind: "local", value: "synthetic-secret" } });
    await service.apply(1, { type: "workspace-add", name: "项目", rootPath: root });
    if (fault === "save") context.mock.method(LocalConversationStore.prototype, "save", async () => { throw new Error("模拟磁盘不可写"); });
    else context.mock.method(LocalAgentRunLog.prototype, "append", async () => { throw new Error("模拟日志不可写"); });
    let output = "";
    const stdout = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
    const exit = await runOnce({ arguments: { type: "run-once", stdin: true, outputFormat: "json", dataDir },
      cwd: root, environment: {}, input: Readable.from(["请回答"]), output: stdout, errorOutput: stdout });
    const result = JSON.parse(output);
    assert.notEqual(exit, 0);
    assert.equal(result.outcome, "failed");
    if (fault === "save") assert.equal(result.persistence.status, "failed");
    else { assert.equal(result.runId, null); assert.ok(result.warnings.length > 0); }
    assert.equal(server.requests.length, 1);
    assert.doesNotMatch(output, /synthetic-secret/);
  } finally { context.mock.restoreAll(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

for (const scenario of ["deny", "plan"] as const) test(`隔离单次执行保留 ${scenario} 硬边界`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-once-boundary-"));
  let count = 0;
  const server = await startOpenAIMockServer(() => ({ chunks: [{ data: ++count === 1
    ? toolCallDelta({ id: "attempt-write", name: "write_file", argumentsJson: '{"path":"forbidden.txt","content":"must-not-write"}' }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT
    : textDelta("写入被拒绝，已停止。") + DONE_EVENT }] }));
  try {
    const dataDir = path.join(root, "data");
    const settings = new LocalSettingsStore(dataDir);
    const service = new SettingsService(settings);
    await service.apply(0, { type: "provider-add", displayName: "测试", model: "mock-model", baseUrl: server.baseUrl,
      windowTokens: 128000, credential: { kind: "local", value: "synthetic-secret" } });
    const view = await service.apply(1, { type: "workspace-add", name: "项目", rootPath: root });
    const conversations = new LocalConversationStore(path.join(dataDir, "conversations-v1"));
    let checkpoint = await conversations.create({ providerId: view.providers[0].id, workspaceId: view.workspaces[0].id });
    const marker = path.join(root, "mcp-started");
    if (scenario === "plan") {
      const saved = await conversations.save({ conversationId: checkpoint.summary.id, expectedRevision: 0,
        checkpoint: { ...checkpoint, mode: "plan" } });
      if (saved.status !== "saved") throw new Error("无法准备 Plan 会话");
      checkpoint = saved.checkpoint;
      const previous = await settings.load(); assert.ok(previous);
      await settings.save(previous.revision, { ...previous, defaultPermissionMode: "permissive", mcpServers: [{ name: "fixture", scope: "user", enabled: true,
        config: { type: "stdio", command: process.execPath, args: [path.resolve("tests/fixtures/mcp/stdio-server.mjs")], env: { MCP_MARKER: marker } } }] });
    }
    const policyFile = path.join(root, "policy.yaml");
    await writeFile(policyFile, scenario === "plan" ? 'rules:\n  "write_file(*)": allow\n' : 'rules:\n  "write_file(*)": allow\n  "write_file(forbidden.txt)": deny\n');
    let output = "";
    const stdout = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
    const exit = await runOnce({ arguments: { type: "run-once", stdin: true, outputFormat: "json", dataDir, policyFile,
      resumeId: checkpoint.summary.id }, cwd: root, environment: {}, input: Readable.from(["尝试写入"]), output: stdout, errorOutput: stdout });
    assert.equal(exit, 0, output);
    assert.equal(JSON.parse(output).outcome, "completed");
    await assert.rejects(readFile(path.join(root, "forbidden.txt")));
    await assert.rejects(readFile(marker));
    assert.equal(count, 2);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});
