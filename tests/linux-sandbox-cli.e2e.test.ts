import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runOnce } from "@/cli/run-once";
import { LocalSettingsStore } from "@/lib/local-settings-store";
import { LocalAgentRunLog } from "@/lib/local-agent-run-log";
import { LocalConversationStore } from "@/lib/local-conversation-store";
import { LocalAgentRunExporter } from "@/lib/local-agent-run-exporter";
import { SettingsService } from "@/runtime/settings-service";
import { DONE_EVENT, startOpenAIMockServer, textDelta, toolCallDelta, TOOL_FINISH_EVENT, TRANSPORT_DONE_EVENT } from "./helpers/openai-mock";

for (const scenario of ["success", "failure", "invalid", "timeout", "iterations", "unavailable"] as const) {
  test(`Linux CLI 沙箱闭环：${scenario}`, { skip: process.platform !== "linux" }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "orbitcode-linux-cli-"));
    const workspace = path.join(root, "workspace");
    const dataDir = path.join(root, "data");
    let requests = 0;
    const parameters = scenario === "invalid" ? { command: 42 } : { command: scenario === "failure" ? "exit 7" : scenario === "timeout" ? "sleep 2" : "node -e 'process.stdout.write(\"sandbox-e2e\")'", ...(scenario === "timeout" ? { timeout_ms: 100 } : {}) };
    const server = await startOpenAIMockServer(() => ({ chunks: [{ data: ++requests === 1
      ? toolCallDelta({ id: "sandbox-command", name: "run_command", argumentsJson: JSON.stringify(parameters) }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT
      : textDelta("已处理命令结果") + DONE_EVENT }] }));
    try {
      await mkdir(workspace);
      const service = new SettingsService(new LocalSettingsStore(dataDir));
      await service.apply(0, { type: "provider-add", displayName: "本地协议替身", model: "mock-model", baseUrl: server.baseUrl, windowTokens: 128000, credential: { kind: "local", value: "synthetic-test-credential" } });
      await service.apply(1, { type: "workspace-add", name: "隔离工作区", rootPath: workspace });
      await mkdir(path.join(dataDir, "memory-state-v1"));
      await writeFile(path.join(dataDir, "memory-state-v1/settings.json"), '{"enabled":false}');
      let output = "";
      const stdout = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
      const environment = scenario === "unavailable" ? { ORBITCODE_SANDBOX_NETWORK: "invalid" } : {};
      const cliEntry = process.env.ORBITCODE_TEST_CLI_ENTRY;
      const exitCode = cliEntry ? await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, [cliEntry, "run", "--stdin", "--output-format", "jsonl", "--data-dir", dataDir, "--timeout-ms", "15000", "--max-iterations", scenario === "iterations" ? "1" : "3"], {
          cwd: path.dirname(cliEntry), env: { PATH: process.env.PATH, NODE_ENV: "test", NEXT_RUNTIME: "nodejs", ...environment }, stdio: "pipe",
        });
        child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
        child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
        child.stdin.end("运行一条开发命令并依据结果回复");
        const deadline = setTimeout(() => child.kill("SIGKILL"), 20000);
        child.once("error", error => { clearTimeout(deadline); reject(error); });
        child.once("close", code => { clearTimeout(deadline); resolve(code); });
      }) : await runOnce({ arguments: { type: "run-once", stdin: true, outputFormat: "jsonl", dataDir, timeoutMs: 15000, maxIterations: scenario === "iterations" ? 1 : 3 }, cwd: workspace,
        environment, input: Readable.from(["运行一条开发命令并依据结果回复"]), output: stdout, errorOutput: stdout });
      const events = output.trim().split("\n").map((line: string) => JSON.parse(line));
      const terminal = events.at(-1).result;
      assert.equal(events.filter(event => event.type === "finished").length, 1);
      assert.equal(exitCode, scenario === "iterations" ? 1 : 0, output);
      assert.equal(terminal.stopReason, scenario === "iterations" ? "max-iterations" : "final-response");
      assert.doesNotMatch(output, /synthetic-test-credential/u);
      const exported = await new LocalAgentRunExporter(new LocalAgentRunLog(path.join(dataDir, "logs")), new LocalConversationStore(path.join(dataDir, "conversations-v1"))).createRunExport({ runId: terminal.runId });
      assert.equal(exported.checkpoints.after.status, "included");
      assert.equal(exported.run.tools.length, 1);
      assert.equal(exported.run.tools[0].status, scenario === "success" ? "succeeded" : scenario === "iterations" ? "cancelled" : scenario === "timeout" ? "timed-out" : "failed");
      if (scenario === "success") assert.match(JSON.stringify(exported.checkpoints.after), /sandbox-e2e/u);
      if (scenario === "unavailable") assert.match(JSON.stringify(exported), /sandbox-unavailable/u);
      assert.equal(requests, scenario === "iterations" ? 1 : 2);
    } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("Linux CLI被强杀后，已启动的命令不能继续写入", { skip: process.platform !== "linux" || !process.env.ORBITCODE_TEST_CLI_ENTRY }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-linux-parent-death-"));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  const cliEntry = process.env.ORBITCODE_TEST_CLI_ENTRY;
  assert.ok(cliEntry);
  const command = `node -e 'const fs=require("node:fs");fs.writeFileSync("started.txt","yes");setTimeout(()=>fs.writeFileSync("leaked.txt","bad"),1500)'`;
  const server = await startOpenAIMockServer(() => ({ chunks: [{ data: toolCallDelta({ id: "parent-death", name: "run_command", argumentsJson: JSON.stringify({ command }) }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT }] }));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await mkdir(workspace);
    const service = new SettingsService(new LocalSettingsStore(dataDir));
    await service.apply(0, { type: "provider-add", displayName: "本地协议替身", model: "mock-model", baseUrl: server.baseUrl, windowTokens: 128000, credential: { kind: "local", value: "synthetic-test-credential" } });
    await service.apply(1, { type: "workspace-add", name: "隔离工作区", rootPath: workspace });
    child = spawn(process.execPath, [cliEntry, "run", "--stdin", "--output-format", "jsonl", "--data-dir", dataDir, "--timeout-ms", "10000"], { cwd: path.dirname(cliEntry), env: { PATH: process.env.PATH, NODE_ENV: "test", NEXT_RUNTIME: "nodejs" }, stdio: "pipe" });
    child.stdout?.resume(); child.stderr?.resume(); child.stdin?.end("运行有延迟副作用的命令");
    const closed = new Promise((resolve, reject) => { child?.once("error", reject); child?.once("close", (_code, signal) => resolve(signal)); });
    let started = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      started = await readFile(path.join(workspace, "started.txt")).then(() => true, () => false);
      if (started) break;
      await delay(20);
    }
    assert.equal(started, true, "必须先确认命令已经实际启动，不能用启动前杀进程冒充回收验证");
    child.kill("SIGKILL");
    assert.equal(await closed, "SIGKILL");
    await delay(1800);
    await assert.rejects(readFile(path.join(workspace, "leaked.txt")));
  } finally { child?.kill("SIGKILL"); await server.close(); await rm(root, { recursive: true, force: true }); }
});
