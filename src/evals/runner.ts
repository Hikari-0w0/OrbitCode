import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { LocalSettingsStore } from "@/lib/local-settings-store";
import { LocalAgentRunLog, type AgentRunLogEntry } from "@/lib/local-agent-run-log";
import { LocalConversationStore } from "@/lib/local-conversation-store";
import type { PersistedToolExecution } from "@/core/conversations/types";
import { acceptCase, FIXTURE_VERSION, prepareCase, type Acceptance, type CaseId } from "@/evals/fixtures";
import { summarizeEvalReport } from "@/evals/report";
import type { ManagedSettings } from "@/runtime/settings-types";

export type EvalRun = {
  readonly caseId: CaseId;
  readonly repeat: number;
  readonly executionId: string | null;
  readonly runId: string | null;
  readonly outcome: string;
  readonly exitCode: number | null;
  readonly acceptance: Acceptance;
  readonly durationMs: number;
  readonly stopReason: string | null;
  readonly verification: unknown;
  readonly persistence: unknown;
  readonly toolCalls: number | null;
  readonly usage: AgentRunLogEntry["usage"] | null;
  readonly evidenceDirectory: string;
  readonly evidenceGap?: string;
};

export type EvalReport = {
  readonly schemaVersion: 1;
  readonly fixtureVersion: number;
  readonly codeFingerprint: string;
  readonly providerFingerprint: string;
  readonly codeChangedDuringRun: boolean;
  readonly createdAt: string;
  readonly providerId: string;
  readonly sourceSettingsRevision: number;
  readonly maxIterations: number;
  readonly timeoutMs: number;
  readonly cases: readonly CaseId[];
  readonly repeat: number;
  readonly runs: readonly EvalRun[];
};

export async function runAgentEvals(options: {
  readonly projectRoot: string;
  readonly providerId: string;
  readonly cases: readonly CaseId[];
  readonly repeat: number;
  readonly timeoutMs: number;
  readonly maxIterations: number;
  readonly outputDirectory: string;
  readonly sourceStore?: LocalSettingsStore;
}): Promise<EvalReport> {
  if (!options.cases.length || !Number.isSafeInteger(options.repeat) || options.repeat < 1 || options.repeat > 10 ||
    !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 1_800_000 ||
    !Number.isSafeInteger(options.maxIterations) || options.maxIterations < 1 || options.maxIterations > 32)
    throw new Error("评测必须指定有效的用例、重复次数、总时限与轮数上限。");
  const source = await (options.sourceStore ?? new LocalSettingsStore()).load();
  const provider = source?.providers.find((item) => item.id === options.providerId && item.enabled);
  if (!source || !provider) throw new Error("指定的托管模型不存在或已停用；请先在设置界面配置。");
  const outputDirectory = path.resolve(options.outputDirectory);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  try { await lstat(path.join(outputDirectory, "report.json")); throw new Error("输出目录已有报告，请选择新的目录。"); }
  catch (error) { if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error; }
  const codeFingerprint = await sourceFingerprint(path.join(options.projectRoot, "src"));
  const runs: EvalRun[] = [];
  const mcpFixture = path.join(options.projectRoot, "tests/fixtures/mcp/stdio-server.mjs");
  for (const caseId of options.cases) for (let repeat = 1; repeat <= options.repeat; repeat++) {
    const executionId = randomUUID();
    const evidenceDirectory = path.join(outputDirectory, `${caseId}-${repeat}-${executionId}`);
    const workspace = path.join(evidenceDirectory, "workspace");
    const dataDir = path.join(evidenceDirectory, "data");
    await mkdir(evidenceDirectory, { recursive: false, mode: 0o700 });
    await writeFile(path.join(evidenceDirectory, "execution.json"), JSON.stringify({ executionId, caseId, repeat,
      timeoutMs: options.timeoutMs, maxIterations: options.maxIterations }), { flag: "wx", mode: 0o600 });
    const prepared = await prepareCase(caseId, workspace, mcpFixture);
    const workspaceRoot = await realpath(workspace);
    if (caseId === "E6") await writeFile(path.join(evidenceDirectory, "secret.txt"), "SYNTHETIC_EVAL_SECRET", { mode: 0o600 });
    const promptFile = path.join(evidenceDirectory, "prompt.txt");
    const policyFile = path.join(evidenceDirectory, "policy.yaml");
    await writeFile(promptFile, prepared.prompt, { mode: 0o600 });
    await writeFile(policyFile, prepared.policy, { mode: 0o600 });
    const mcpCallLog = path.join(evidenceDirectory, "mcp-calls.jsonl");
    const settings: ManagedSettings = { schemaVersion: 1, revision: 0, providers: [provider],
      workspaces: [{ id: "workspace", name: "评测工作区", rootPath: workspaceRoot, enabled: true }],
      mcpServers: caseId === "E5" ? [{ name: "fixture", scope: "workspace", workspaceId: "workspace", enabled: true,
        config: { type: "stdio", command: process.execPath, args: [mcpFixture], env: { MCP_CALL_LOG: mcpCallLog } } }] : [],
      defaultProviderId: provider.id, defaultWorkspaceId: "workspace", maxIterations: options.maxIterations,
      maxRuntimeMinutes: Math.ceil(options.timeoutMs / 60_000) };
    await new LocalSettingsStore(dataDir).save(0, settings);
    const environment = selectedEnvironment(provider.credential);
    const started = Date.now();
    const execution = await executeCli({ projectRoot: options.projectRoot, workspace, dataDir, promptFile, policyFile,
      timeoutMs: options.timeoutMs, environment, executionId });
    let runLog: AgentRunLogEntry | undefined;
    try { if (execution.result?.runId) runLog = await new LocalAgentRunLog(path.join(dataDir, "logs")).find(execution.result.runId); }
    catch { /* 日志缺失作为独立证据缺口呈现。 */ }
    let toolEvidence: readonly PersistedToolExecution[] | undefined;
    try { if (execution.result?.conversationId) {
      const checkpoint = await new LocalConversationStore(path.join(dataDir, "conversations-v1")).load(execution.result.conversationId);
      const argumentsByCall = new Map(checkpoint.context.messages.flatMap((message) => message.kind === "assistant-tool-call"
        ? message.toolCalls.map((call) => [call.id, call.argumentsJson] as const) : []));
      toolEvidence = checkpoint.displayMessages.flatMap((message) => message.toolExecutions ?? [])
        .map((tool) => ({ ...tool, argumentsJson: argumentsByCall.get(tool.callId) ?? tool.argumentsJson }));
    } } catch { /* 检查点缺失会让需要时间线的验收失败。 */ }
    const acceptance = await acceptCase(caseId, workspace, execution.result ?? { outcome: "missing" }, mcpCallLog, toolEvidence);
    runs.push({ caseId, repeat, executionId, runId: execution.result?.runId ?? null,
      outcome: execution.result?.outcome ?? (execution.timedOut ? "timed-out" : "missing-terminal"),
      exitCode: execution.exitCode, acceptance, durationMs: Date.now() - started, evidenceDirectory,
      stopReason: execution.result?.stopReason ?? null, verification: execution.result?.verification ?? null,
      persistence: execution.result?.persistence ?? null, toolCalls: runLog?.tools.length ?? null, usage: runLog?.usage ?? null,
      ...(execution.result && runLog ? {} : { evidenceGap: !execution.result ? execution.reason : "运行日志缺失。" }) });
  }
  const publicProvider = { model: provider.model, baseUrl: provider.baseUrl, context: provider.context,
    thinking: provider.thinking, transport: provider.transport };
  const report: EvalReport = { schemaVersion: 1, fixtureVersion: FIXTURE_VERSION, createdAt: new Date().toISOString(),
    codeFingerprint, codeChangedDuringRun: codeFingerprint !== await sourceFingerprint(path.join(options.projectRoot, "src")),
    providerFingerprint: createHash("sha256").update(JSON.stringify(publicProvider)).digest("hex"),
    providerId: options.providerId, sourceSettingsRevision: source.revision,
    maxIterations: options.maxIterations, timeoutMs: options.timeoutMs,
    cases: options.cases, repeat: options.repeat, runs };
  await writeFile(path.join(outputDirectory, "report.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
  await writeFile(path.join(outputDirectory, "summary.md"), summarizeEvalReport(report), { flag: "wx", mode: 0o600 });
  return report;
}

async function sourceFingerprint(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(directory: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !entry.name.includes(".test."))
        hash.update(path.relative(root, file)).update(await readFile(file));
    }
  }
  await visit(root);
  return hash.digest("hex");
}

function selectedEnvironment(credential: ManagedSettings["providers"][number]["credential"]): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { NODE_ENV: "test" };
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]) if (process.env[name]) result[name] = process.env[name];
  if (credential.kind === "environment") {
    const value = process.env[credential.variable];
    if (!value) throw new Error(`选定模型需要环境变量 ${credential.variable}。`);
    result[credential.variable] = value;
  }
  return result;
}

type CliResult = { readonly executionId: string; readonly runId: string | null; readonly conversationId?: string | null; readonly outcome: string; readonly finalResponse?: string;
  readonly stopReason?: string | null; readonly verification?: unknown; readonly persistence?: unknown };
async function executeCli(options: {
  projectRoot: string; workspace: string; dataDir: string; promptFile: string; policyFile: string;
  timeoutMs: number; environment: NodeJS.ProcessEnv;
  executionId: string;
}): Promise<{ result: CliResult | null; exitCode: number | null; timedOut: boolean; reason: string }> {
  const child = spawn(process.execPath, ["--import", path.join(options.projectRoot, "node_modules/tsx/dist/loader.mjs"), path.join(options.projectRoot, "src/cli/main.ts"),
    "run", "--prompt-file", options.promptFile, "--output-format", "json", "--data-dir", options.dataDir,
    "--policy-file", options.policyFile, "--timeout-ms", String(options.timeoutMs), "--execution-id", options.executionId], {
    cwd: options.workspace, env: { ...options.environment, TSX_TSCONFIG_PATH: path.join(options.projectRoot, "tsconfig.json") },
    stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let oversized = false;
  const stop = (signal: NodeJS.Signals) => {
    try { if (child.pid) process.kill(process.platform === "win32" ? child.pid : -child.pid, signal); }
    catch { /* 子进程可能已经退出。 */ }
  };
  const deadline = setTimeout(() => { timedOut = true; stop("SIGTERM"); }, options.timeoutMs + 3_000);
  const force = setTimeout(() => { if (timedOut) stop("SIGKILL"); }, options.timeoutMs + 5_000);
  child.stdout.on("data", (chunk: Buffer) => {
    if (oversized) return;
    if (Buffer.byteLength(stdout) + chunk.byteLength > 1024 * 1024) { oversized = true; stdout = ""; stop("SIGTERM"); return; }
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 16 * 1024) stderr += chunk.toString().slice(0, 16 * 1024 - stderr.length); });
  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("close", (code) => resolve(code));
  });
  clearTimeout(deadline); clearTimeout(force);
  let result: CliResult | null = null;
  try {
    const raw: unknown = JSON.parse(stdout.trim());
    if (typeof raw === "object" && raw !== null && "schemaVersion" in raw && raw.schemaVersion === 1 &&
      "executionId" in raw && raw.executionId === options.executionId &&
      "outcome" in raw && typeof raw.outcome === "string" && ["completed", "blocked", "timed-out", "cancelled", "failed"].includes(raw.outcome) &&
      (raw.outcome !== "completed" || exitCode === 0) &&
      "runId" in raw && (raw.runId === null || typeof raw.runId === "string")) result = raw as CliResult;
  } catch { /* 没有合法终态时保留证据缺口。 */ }
  return { result, exitCode, timedOut, reason: timedOut ? "父执行器超时并终止进程组。" : stderr ? "CLI 未产生可解析终态；错误输出保留在本次运行内存中。" : "CLI 未产生可解析终态。" };
}
