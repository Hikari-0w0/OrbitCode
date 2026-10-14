import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalSettingsStore } from "@/lib/local-settings-store";
import { SettingsService } from "@/runtime/settings-service";
import { runAgentEvals } from "@/evals/runner";
import { DONE_EVENT, startOpenAIMockServer, textDelta, toolCallDelta, TOOL_FINISH_EVENT, TRANSPORT_DONE_EVENT } from "./helpers/openai-mock";
import { mcpToolName } from "@/tools/mcp-tool";

test("评测器启动独立 CLI、等待终态，再由工作区外验收并记录完整分母", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-eval-runner-"));
  const server = await startOpenAIMockServer(() => ({ chunks: [{ data: textDelta("routeOrder 先调用 validateOrder，再调用 priceOrder；无效输入触发 OrderError。") + DONE_EVENT }] }));
  try {
    const sourceStore = new LocalSettingsStore(path.join(root, "source"));
    const view = await new SettingsService(sourceStore).apply(0, { type: "provider-add", displayName: "测试", model: "mock-model",
      baseUrl: server.baseUrl, windowTokens: 128000, credential: { kind: "local", value: "synthetic-secret" } });
    const outputDirectory = path.join(root, "results");
    const report = await runAgentEvals({ projectRoot: process.cwd(), providerId: view.providers[0].id, cases: ["E1"],
      repeat: 1, timeoutMs: 10_000, maxIterations: 4, outputDirectory, sourceStore });
    assert.equal(report.runs.length, 1);
    assert.equal(report.runs[0].outcome, "completed");
    assert.equal(report.runs[0].acceptance.status, "indeterminate");
    assert.ok(report.runs[0].executionId);
    assert.ok(report.runs[0].runId);
    assert.equal(server.requests.length, 1);
    const saved = await readFile(path.join(outputDirectory, "report.json"), "utf8");
    assert.doesNotMatch(saved, /synthetic-secret/);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("E2/E3/E4/E6 经独立 CLI 与真实文件/命令工具完成外部验收", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-eval-cases-"));
  const counts = new Map<string, number>();
  const server = await startOpenAIMockServer((request) => {
    const source = JSON.stringify(request.body);
    const id = source.includes("multiply") ? "E2" : source.includes("formatGreeting") ? "E3" : source.includes("node check.mjs") ? "E4" : "E6";
    const step = counts.get(id) ?? 0;
    counts.set(id, step + 1);
    const calls: Readonly<Record<string, readonly { name: string; argumentsJson: string }[]>> = {
      E2: [{ name: "write_file", argumentsJson: JSON.stringify({ path: "math.mjs", content: "export function multiply(a,b) { return a*b; }\n" }) }],
      E3: [
        { name: "write_file", argumentsJson: JSON.stringify({ path: "format.mjs", content: "export function formatName(name) { return name.trim(); }\nexport function formatGreeting(name) { return 'Hello, ' + formatName(name) + '!'; }\n" }) },
        { name: "write_file", argumentsJson: JSON.stringify({ path: "index.mjs", content: "export { formatName, formatGreeting } from './format.mjs';\n" }) },
      ],
      E4: [
        { name: "run_command", argumentsJson: JSON.stringify({ command: "node check.mjs", timeout_ms: 5000 }) },
        { name: "write_file", argumentsJson: JSON.stringify({ path: "math.mjs", content: "export function safeDivide(a,b) { return b === 0 ? null : a/b; }\n" }) },
        { name: "run_command", argumentsJson: JSON.stringify({ command: "node check.mjs", timeout_ms: 5000 }) },
      ],
      E6: [{ name: "read_file", argumentsJson: JSON.stringify({ path: "../secret.txt" }) }],
    };
    const call = calls[id][step];
    return { chunks: [{ data: call ? toolCallDelta({ id: id + "-" + step, ...call }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT
      : textDelta(id === "E6" ? "无法越界读取受限文件。" : "已完成修改与检查。") + DONE_EVENT }] };
  });
  try {
    const sourceStore = new LocalSettingsStore(path.join(root, "source"));
    const view = await new SettingsService(sourceStore).apply(0, { type: "provider-add", displayName: "测试", model: "mock-model",
      baseUrl: server.baseUrl, windowTokens: 128000, credential: { kind: "local", value: "synthetic-secret" } });
    const report = await runAgentEvals({ projectRoot: process.cwd(), providerId: view.providers[0].id, cases: ["E2", "E3", "E4", "E6"],
      repeat: 1, timeoutMs: 15_000, maxIterations: 8, outputDirectory: path.join(root, "results"), sourceStore });
    assert.deepEqual(report.runs.map((run) => [run.caseId, run.outcome, run.acceptance.status]),
      [["E2", "completed", "passed"], ["E3", "completed", "passed"], ["E4", "completed", "passed"], ["E6", "completed", "passed"]],
      JSON.stringify(report.runs.map((run) => ({ caseId: run.caseId, acceptance: run.acceptance }))));
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("E5 使用隔离 MCP fixture 的真实工具调用作为验收证据", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-eval-mcp-"));
  let requests = 0;
  const server = await startOpenAIMockServer(() => ({ chunks: [{ data: ++requests === 1
    ? toolCallDelta({ id: "mcp-echo", name: mcpToolName("fixture", "echo"), argumentsJson: '{"text":"EVAL_SOURCE_MARKER_54"}' }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT
    : textDelta("工具返回 EVAL_SOURCE_MARKER_54") + DONE_EVENT }] }));
  try {
    const sourceStore = new LocalSettingsStore(path.join(root, "source"));
    const view = await new SettingsService(sourceStore).apply(0, { type: "provider-add", displayName: "测试", model: "mock-model",
      baseUrl: server.baseUrl, windowTokens: 128000, credential: { kind: "local", value: "synthetic-secret" } });
    const report = await runAgentEvals({ projectRoot: process.cwd(), providerId: view.providers[0].id, cases: ["E5"],
      repeat: 1, timeoutMs: 10_000, maxIterations: 4, outputDirectory: path.join(root, "results"), sourceStore });
    assert.equal(report.runs[0].outcome, "completed");
    assert.equal(report.runs[0].acceptance.status, "passed");
    assert.equal(requests, 2);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

test("CLI 硬退出缺少终态时仍保留 executionId、退出码与证据缺口", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-eval-crash-"));
  try {
    const projectRoot = path.join(root, "project");
    await mkdir(path.join(projectRoot, "src/cli"), { recursive: true });
    await symlink(path.join(process.cwd(), "node_modules"), path.join(projectRoot, "node_modules"));
    await writeFile(path.join(projectRoot, "src/cli/main.ts"), "process.exit(7);\n");
    await writeFile(path.join(projectRoot, "tsconfig.json"), '{"compilerOptions":{"module":"commonjs"}}');
    const sourceStore = new LocalSettingsStore(path.join(root, "source"));
    const view = await new SettingsService(sourceStore).apply(0, { type: "provider-add", displayName: "未调用模型", model: "mock-model", baseUrl: "http://127.0.0.1:1/v1", windowTokens: 128000, credential: { kind: "local", value: "synthetic-key" } });
    const report = await runAgentEvals({ projectRoot, providerId: view.providers[0].id, cases: ["E6"], repeat: 1,
      timeoutMs: 1000, maxIterations: 2, outputDirectory: path.join(root, "report"), sourceStore });
    const run = report.runs[0];
    assert.equal(run.outcome, "missing-terminal");
    assert.equal(run.exitCode, 7);
    assert.equal(run.runId, null);
    assert.ok(run.executionId);
    assert.ok(run.evidenceGap);
    assert.equal(run.acceptance.status, "indeterminate");
    const manifest = JSON.parse(await readFile(path.join(run.evidenceDirectory, "execution.json"), "utf8"));
    assert.equal(manifest.executionId, run.executionId);
  } finally { await rm(root, { recursive: true, force: true }); }
});
