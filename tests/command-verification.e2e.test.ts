import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalSettingsStore } from "@/lib/local-settings-store";
import { SettingsService } from "@/runtime/settings-service";
import { DONE_EVENT, startOpenAIMockServer, textDelta, toolCallDelta, TOOL_FINISH_EVENT, TRANSPORT_DONE_EVENT } from "./helpers/openai-mock";

for (const scenario of ["pipeline", "invalid", "timeout", "iterations"] as const) {
  test(`CLI 验证证据闭环：${scenario}`, { skip: !["darwin", "linux"].includes(process.platform), timeout: 20000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "orbitcode-verification-cli-"));
    const workspace = path.join(root, "workspace");
    const dataDir = path.join(root, "data");
    let requests = 0;
    const parameters = scenario === "invalid" ? { command: 42 } : {
      command: scenario === "timeout" ? "sleep 2" : "(printf 'synthetic failure\\n'; exit 7) | tail -n 1",
      ...(scenario === "timeout" ? { timeout_ms: 100 } : {}),
    };
    const server = await startOpenAIMockServer(() => ({ chunks: [{ data: ++requests === 1
      ? toolCallDelta({ id: "check", name: "run_command", argumentsJson: JSON.stringify(parameters) }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT
      : textDelta("检查尚未通过。") + DONE_EVENT }] }));
    try {
      await mkdir(workspace);
      const settings = new SettingsService(new LocalSettingsStore(dataDir));
      await settings.apply(0, { type: "provider-add", displayName: "本地协议替身", model: "mock-model", baseUrl: server.baseUrl, windowTokens: 128000, credential: { kind: "local", value: "synthetic-cli-key" } });
      await settings.apply(1, { type: "workspace-add", name: "合成验证项目", rootPath: workspace });
      await mkdir(path.join(dataDir, "memory-state-v1"));
      await writeFile(path.join(dataDir, "memory-state-v1/settings.json"), '{"enabled":false}');
      let stdout = "";
      let stderr = "";
      const child = spawn(process.execPath, ["--import", "tsx", "src/cli/main.ts", "run", "--stdin", "--output-format", "jsonl", "--data-dir", dataDir, "--timeout-ms", "12000", "--max-iterations", scenario === "iterations" ? "1" : "3"], {
        cwd: process.cwd(), env: { PATH: process.env.PATH, NODE_ENV: "test", NEXT_RUNTIME: "nodejs" }, stdio: "pipe",
      });
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
      let exitCode: number | null;
      try {
        const finished = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
        child.stdin.end("运行合成检查并根据真实结果说明验证状态");
        exitCode = await finished;
      } finally { clearTimeout(timer); child.kill("SIGKILL"); }
      assert.equal(exitCode, scenario === "iterations" ? 1 : 0, stderr + stdout);
      const lines: unknown[] = stdout.trim().split("\n").map(line => JSON.parse(line));
      const terminal = lines.at(-1);
      assert.ok(isRecord(terminal) && terminal.type === "finished" && isRecord(terminal.result));
      assert.equal(terminal.result.stopReason, scenario === "iterations" ? "max-iterations" : "final-response");
      assert.ok(isRecord(terminal.result.verification));
      assert.equal(terminal.result.verification.status, "unverified");
      assert.doesNotMatch(stdout + stderr, /synthetic-cli-key/u);
      assert.equal(requests, scenario === "iterations" ? 1 : 2);
      if (scenario !== "iterations") {
        const body = server.requests[1]?.body;
        assert.ok(isRecord(body) && Array.isArray(body.messages));
        const review = body.messages.find(message => isRecord(message) && message.role === "system" && typeof message.content === "string" && message.content.startsWith("本轮执行证据摘要"));
        assert.ok(isRecord(review));
        assert.match(String(review.content), scenario === "pipeline" ? /command-failed.*exitCode=7/u : scenario === "invalid" ? /invalid-arguments/u : /timeout/u);
        const previous = server.requests[0]?.body;
        assert.ok(isRecord(previous) && Array.isArray(previous.messages));
        const withoutBudget = (messages: readonly unknown[]) => messages.filter(message => !(isRecord(message) && message.role === "system" && typeof message.content === "string" && message.content.startsWith("运行时预算：")));
        const prefix = withoutBudget(previous.messages);
        assert.deepEqual(withoutBudget(body.messages).slice(0, prefix.length), prefix, "动态工具事实不能改写稳定请求前缀");
        assert.ok(body.messages.indexOf(review) > body.messages.findLastIndex(message => isRecord(message) && message.role === "tool"));
      }
    } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
