import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalSettingsStore } from "@/lib/local-settings-store";
import { SettingsService } from "@/runtime/settings-service";
import { DONE_EVENT, startOpenAIMockServer, textDelta, toolCallDelta, TOOL_FINISH_EVENT, TRANSPORT_DONE_EVENT } from "./helpers/openai-mock";

for (const policy of ["exact", "warn"] as const) {
  test(`CLI 从隔离设置读取${policy}失败策略，诊断六次失败后仍可完成`, { timeout: 20000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "orbitcode-failure-policy-"));
    const workspace = path.join(root, "workspace"), data = path.join(root, "data");
    let requests = 0;
    const server = await startOpenAIMockServer(() => ({ chunks: [{ data: ++requests <= 6
      ? toolCallDelta({ id: `diagnosis-${requests}`, name: "run_command", argumentsJson: JSON.stringify({ command: `printf 'probe-${requests}'; exit 1` }) }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT
      : textDelta("检查尚未通过，已有失败证据。") + DONE_EVENT }] }));
    try {
      await mkdir(workspace);
      const store = new LocalSettingsStore(data), service = new SettingsService(store);
      await service.apply(0, { type: "provider-add", displayName: "本地替身", model: "fixture", baseUrl: server.baseUrl, windowTokens: 128000, credential: { kind: "local", value: "synthetic-policy-key" } });
      await service.apply(1, { type: "workspace-add", name: "策略检查", rootPath: workspace });
      await service.apply(2, { type: "preferences-set", maxIterations: 10, maxRuntimeMinutes: 1, defaultPermissionMode: "default", toolFailurePolicy: policy });
      assert.equal((await store.load())?.toolFailurePolicy, policy);
      const child = spawn(process.execPath, ["--import", "tsx", "src/cli/main.ts", "run", "--stdin", "--output-format", "jsonl", "--data-dir", data, "--timeout-ms", "15000"], { cwd: process.cwd(), env: { PATH: process.env.PATH, NODE_ENV: "test", NEXT_RUNTIME: "nodejs" }, stdio: "pipe" });
      let output = "", errors = "";
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
      const timer = setTimeout(() => child.kill("SIGKILL"), 17000);
      try {
        const completed = new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
        child.stdin.end("依次检查失败并报告已知事实。");
        assert.equal(await completed, 0, errors + output);
      } finally { clearTimeout(timer); child.kill("SIGKILL"); }
      assert.equal(requests, 7);
      assert.match(output, /final-response/);
      assert.doesNotMatch(output + errors, /synthetic-policy-key|repeated-tool-failure/);
    } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
  });
}
