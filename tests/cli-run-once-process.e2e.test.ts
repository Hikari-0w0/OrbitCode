import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SettingsService } from "@/runtime/settings-service";
import { LocalSettingsStore } from "@/lib/local-settings-store";
import { LocalAgentRunLog } from "@/lib/local-agent-run-log";
import { LocalConversationStore } from "@/lib/local-conversation-store";
import { LocalAgentRunExporter } from "@/lib/local-agent-run-exporter";
import { DONE_EVENT, startOpenAIMockServer, textDelta } from "./helpers/openai-mock";

const project = process.cwd();
async function execute(cwd: string, args: readonly string[], input?: string, interrupt = false) {
  const child = spawn(process.execPath, ["--import", path.join(project, "node_modules/tsx/dist/loader.mjs"), path.join(project, "src/cli/main.ts"), ...args], {
    cwd, env: { PATH: process.env.PATH, NODE_ENV: "test", TSX_TSCONFIG_PATH: path.join(project, "tsconfig.json") }, stdio: "pipe",
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  if (input !== undefined) child.stdin.end(input);
  const signal = interrupt ? setTimeout(() => child.kill("SIGINT"), 500) : undefined;
  const deadline = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    return { stdout, stderr, exitCode };
  } finally { clearTimeout(deadline); if (signal) clearTimeout(signal); child.kill("SIGKILL"); }
}

test("真实 CLI 子进程的文件/stdin/resume/JSONL/启动失败/EOF/信号与日志导出", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-cli-protocol-"));
  const workspace = path.join(root, "workspace");
  const server = await startOpenAIMockServer(() => ({ chunks: [{ data: textDelta("多行请求已处理") + DONE_EVENT }] }));
  try {
    await mkdir(workspace);
    // 隔离 CLI 不应解析这些故意损坏的日常兼容文件，也不应加载项目环境。
    await writeFile(path.join(workspace, "orbitcode.yaml"), "invalid: [");
    await writeFile(path.join(workspace, ".env"), "UNSELECTED_KEY=synthetic-unselected\n");
    const dataDir = path.join(root, "data");
    const service = new SettingsService(new LocalSettingsStore(dataDir));
    await service.apply(0, { type: "provider-add", displayName: "模型", model: "mock-model", baseUrl: server.baseUrl,
      windowTokens: 128000, credential: { kind: "local", value: "synthetic-selected" } });
    await service.apply(1, { type: "workspace-add", name: "项目", rootPath: workspace });
    const promptFile = path.join(root, "prompt.txt");
    await writeFile(promptFile, "第一行\n第二行\n");
    const first = await execute(workspace, ["run", "--prompt-file", promptFile, "--data-dir", dataDir, "--output-format", "json"]);
    assert.equal(first.exitCode, 0, first.stderr);
    assert.equal(first.stdout.trim().split("\n").length, 1);
    const terminal = JSON.parse(first.stdout);
    assert.equal(terminal.outcome, "completed");
    assert.equal(terminal.configSource, "managed");
    assert.equal(terminal.settingsRevision, 2);
    const second = await execute(workspace, ["run", "--stdin", "--resume", terminal.conversationId, "--data-dir", dataDir, "--output-format", "jsonl"], "追加一行\n追加二行\n");
    assert.equal(second.exitCode, 0, second.stderr);
    const events = second.stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.sequence), events.map((_event, index) => index + 1));
    assert.equal(events.filter((event) => event.type === "finished").length, 1);
    assert.equal(events.at(-1).result.conversationId, terminal.conversationId);
    assert.equal(events.at(-1).result.persistence.revision, 2);
    const exporter = new LocalAgentRunExporter(new LocalAgentRunLog(path.join(dataDir, "logs")), new LocalConversationStore(path.join(dataDir, "conversations-v1")));
    const outputPath = path.join(root, "export.json");
    await exporter.exportRun({ runId: terminal.runId, outputPath, includeContext: false });
    assert.match(await readFile(outputPath, "utf8"), new RegExp(terminal.runId));
    const eof = await execute(workspace, ["run", "--stdin", "--data-dir", dataDir], "");
    assert.notEqual(eof.exitCode, 0);
    assert.equal(JSON.parse(eof.stdout).runId, null);
    const absent = await execute(workspace, ["run", "--stdin", "--data-dir", path.join(root, "absent")], "请求");
    assert.notEqual(absent.exitCode, 0);
    assert.equal(JSON.parse(absent.stdout).outcome, "failed");
    const cancelled = await execute(workspace, ["run", "--stdin", "--data-dir", dataDir], undefined, true);
    assert.equal(cancelled.exitCode, 130, cancelled.stderr);
    assert.equal(JSON.parse(cancelled.stdout).outcome, "cancelled");
    const timed = await execute(workspace, ["run", "--stdin", "--data-dir", dataDir, "--timeout-ms", "100"]);
    assert.equal(timed.exitCode, 124);
    assert.equal(JSON.parse(timed.stdout).outcome, "timed-out");
    assert.equal(server.requests.length, 2);
    assert.doesNotMatch(JSON.stringify(server.requests.map((request) => request.body)), /synthetic-unselected/);
    assert.equal(await readFile(path.join(workspace, "orbitcode.yaml"), "utf8"), "invalid: [");
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("两个隔离目录不读取或改写默认用户目录的哨兵配置、权限和日志", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-user-sentinel-"));
  const fakeUser = path.join(root, "user");
  const userData = path.join(fakeUser, ".orbitcode");
  await mkdir(userData, { recursive: true });
  const sentinels = { "settings-v1.json": "{invalid-user-config", "permissions.yaml": "invalid: [", "agent-runs.jsonl": "USER_LOG_SENTINEL\n",
    "mcp.yaml": "mcpServers: [invalid" };
  for (const [name, content] of Object.entries(sentinels)) await writeFile(path.join(userData, name), content, { mode: 0o600 });
  // 只替换测试进程的默认路径来源；实现仍靠 data-dir 隔离，不修改 HOME 或用户文件。
  context.mock.method(os, "homedir", () => fakeUser);
  const server = await startOpenAIMockServer(() => ({ chunks: [{ data: textDelta("隔离回答") + DONE_EVENT }] }));
  try {
    const { runOnce } = await import("@/cli/run-once");
    const { Readable, Writable } = await import("node:stream");
    for (const suffix of ["one", "two"]) {
      const dataDir = path.join(root, suffix);
      const service = new SettingsService(new LocalSettingsStore(dataDir));
      await service.apply(0, { type: "provider-add", displayName: "测试", model: "mock-model", baseUrl: server.baseUrl,
        windowTokens: 128000, credential: { kind: "local", value: "synthetic-key" } });
      await service.apply(1, { type: "workspace-add", name: "项目", rootPath: root });
      let source = "";
      const output = new Writable({ write(chunk, _encoding, done) { source += chunk.toString(); done(); } });
      assert.equal(await runOnce({ arguments: { type: "run-once", stdin: true, outputFormat: "json", dataDir }, cwd: root,
        environment: {}, input: Readable.from(["请求"]), output, errorOutput: output }), 0);
      const run = JSON.parse(source);
      assert.ok(await new LocalAgentRunLog(path.join(dataDir, "logs")).find(run.runId));
      assert.equal((await new LocalConversationStore(path.join(dataDir, "conversations-v1")).load(run.conversationId)).summary.revision, 1);
    }
    for (const [name, content] of Object.entries(sentinels)) assert.equal(await readFile(path.join(userData, name), "utf8"), content);
    assert.equal(server.requests.length, 2);
  } finally { context.mock.restoreAll(); await server.close(); await rm(root, { recursive: true, force: true }); }
});
