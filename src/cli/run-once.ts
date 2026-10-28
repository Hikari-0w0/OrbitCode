import { parseSkillCommand } from "@/runtime/skill-commands";
import {userConfigurationRoot} from "@/runtime/background-service";
import { createHash, randomUUID } from "node:crypto";
import { open, readFile, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

import type { CliArguments } from "@/cli/arguments";
import { LocalSettingsStore } from "@/lib/local-settings-store";
import { LocalConversationStore } from "@/lib/local-conversation-store";
import { LocalAgentRunLog } from "@/lib/local-agent-run-log";
import { AgentRuntime } from "@/runtime/agent-runtime";
import { loadProviderContext, resolveRuntimeProvider } from "@/runtime/config";
import { ConversationOperationGuard } from "@/runtime/conversation-operation-guard";
import { ConversationRuntimeManager } from "@/runtime/conversation-runtime-manager";
import { loadMcpConfig } from "@/runtime/mcp-config";
import { PermissionSessionManager } from "@/runtime/permission-session-manager";
import { loadWorkspaceCatalog, resolveWorkspaceBoundary } from "@/runtime/workspace-config";
import { createCommandSandbox } from "@/tools/platform-sandbox";
import type { Environment } from "@/lib/environment";
import type { RuntimeTurnEvent } from "@/runtime/types";

export type RunOnceArguments = Extract<CliArguments, { type: "run-once" }>;

export async function runOnce(options: {
  readonly arguments: RunOnceArguments;
  readonly cwd: string;
  readonly environment: Environment;
  readonly input: Readable;
  readonly output: Writable;
  readonly errorOutput: Writable;
}): Promise<number> {
  const { arguments: args, cwd, environment, input, output } = options;
  const executionId = args.executionId ?? randomUUID();
  const startedAt = Date.now();
  let conversationId: string | null = null;
  let runId: string | null = null;
  let sequence = 0;
  const writeEvent = (value: unknown) => { if (args.outputFormat === "jsonl") output.write(`${JSON.stringify({ schemaVersion: 1, executionId, sequence: ++sequence, ...value as object })}\n`); };
  const dataDir = args.dataDir ? path.resolve(cwd, args.dataDir) : undefined;
  const settingsStore = new LocalSettingsStore(dataDir);
  const store = new LocalConversationStore(dataDir ? path.join(dataDir, "conversations-v1") : undefined);
  const log = new LocalAgentRunLog(dataDir ? path.join(dataDir, "logs") : undefined);
  const manager = new ConversationRuntimeManager();
  const guard = new ConversationOperationGuard(manager, store);
  const permissions = new PermissionSessionManager();
  const permissionId = permissions.createSession().id;
  const loadConfig = async () => {
    const context = await loadProviderContext(cwd, environment, path.join(cwd, "orbitcode.yaml"), false, settingsStore, !dataDir);
    return args.maxIterations === undefined ? context : { ...context, maxIterations: args.maxIterations };
  };
  const loadWorkspaces = (context?: Awaited<ReturnType<typeof loadConfig>>) => loadWorkspaceCatalog({ cwd, settingsStore,
    ...(context ? { managedSettings: context.managedSettings ?? null } : {}) });
  const runtime = new AgentRuntime({ userConfigRoot: userConfigurationRoot(dataDir), store, manager, guard, permissions, log,
    sandbox: createCommandSandbox(environment), createSandbox: context => createCommandSandbox(environment, process.platform, context.managedSettings?.commandSecurity), loadConfig, loadWorkspaces,
    loadMcp: async (workspaceRoot, context) => loadMcpConfig({ workspaceRoot, environment: context.environment,
      managedSettings: context.managedSettings ?? null, settingsStore,
      ...(dataDir ? { userHome: dataDir } : {}) }),
    ...(dataDir ? { permissionLocations: (workspaceRoot: string) => ({
      user: path.join(dataDir, "permissions.yaml"),
      project: path.join(workspaceRoot, ".orbitcode", "permissions.yaml"),
      local: path.join(workspaceRoot, ".orbitcode", "permissions.local.yaml"),
    }) } : {}),
  });
  const controller = new AbortController();
  let timeout = false;
  const timer = setTimeout(() => { timeout = true; controller.abort(); }, args.timeoutMs ?? 180_000);
  const onInterrupt = () => controller.abort();
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);
  let exitCode = 1;
  let final: Record<string, unknown> = {};
  let policyId: string | null = null;
  try {
    const prompt = args.promptFile ? await readPromptFile(path.resolve(cwd, args.promptFile)) : await readStdin(input, controller.signal);
    const skillCommand = parseSkillCommand(prompt);
    if (skillCommand && skillCommand.kind !== "run") throw new Error("单次运行不支持 Skill 管理命令，请使用交互 CLI 或 Web 面板。");
    if (!prompt.trim() || prompt.length > 20_000) throw new Error("Prompt 必须为 1–20000 个字符。");
    const managedSettings = await settingsStore.load();
    if (dataDir && !managedSettings) throw new Error("隔离运行需要在 data-dir 内提供托管设置。");
    if (managedSettings?.defaultPermissionMode) permissions.setMode(permissionId, managedSettings.defaultPermissionMode);
    if (args.policyFile && dataDir) {
      const policy = await readPromptFile(path.resolve(cwd, args.policyFile));
      if (Buffer.byteLength(policy) > 256 * 1024) throw new Error("权限策略文件超过大小上限。");
      policyId = createHash("sha256").update(policy).digest("hex");
      await saveIsolatedPolicy(path.join(dataDir, "permissions.yaml"), policy);
    }
    const context = await loadConfig();
    const catalog = await loadWorkspaces(context);
    let checkpoint;
    if (args.resumeId) {
      checkpoint = await store.load(args.resumeId);
      resolveRuntimeProvider(context, checkpoint.summary.providerId);
      await resolveWorkspaceBoundary(catalog, checkpoint.summary.workspaceId);
    } else {
      const providerId = args.providerName ?? context.defaultProviderId ?? (context.providers.length === 1 ? context.providers[0].name : undefined);
      const workspaceId = args.workspaceId ?? catalog.defaultWorkspaceId;
      if (!providerId || !workspaceId) throw new Error("请选择已配置的模型和工作区。");
      resolveRuntimeProvider(context, providerId);
      await resolveWorkspaceBoundary(catalog, workspaceId);
      checkpoint = await store.create({ providerId, workspaceId });
    }
    conversationId = checkpoint.summary.id;
    writeEvent({ type: "started", conversationId });
    let finished: Extract<RuntimeTurnEvent, { type: "finished" }> | undefined;
    const warnings: string[] = [];
    const blockingWarnings: string[] = [];

    for await (const item of runtime.streamTurn({
      conversationId, expectedRevision: checkpoint.summary.revision,
      permissionSessionId: permissionId, input: prompt, mode: checkpoint.mode,parentExecution:args.parentExecution,
      modeTurn: checkpoint.modeTurn + 1, source: "cli", interactive:false, signal: controller.signal,
    })) {
      if (item.type === "warning") { warnings.push(item.detail); if (item.kind !== "memory") blockingWarnings.push(item.detail); }
      if (item.type === "agent") writeEvent({ type: "agent", eventType: item.event.type, ...(item.event.type === "skill-run" ? { skillRun: item.event } : {}) });
      if (item.type === "initialization") writeEvent({ type: "initialization", eventType: item.event.type });
      if (item.type === "finished") finished = item;
    }
    const runs = await log.findAllForConversation(conversationId);
    const runLog = runs.findLast((item) => item.revisionBefore === checkpoint.summary.revision);
    runId = runLog?.runId ?? null;
    const outcome = timeout ? "timed-out" : controller.signal.aborted ? "cancelled"
      : finished?.stopped.reason === "final-response" && finished.persistence.status === "saved" && blockingWarnings.length === 0 && runId ? "completed" : "failed";
    exitCode = outcome === "completed" ? 0 : outcome === "timed-out" ? 124 : outcome === "cancelled" ? 130 : 1;
    final = {
      outcome, stopReason: finished?.stopped.reason ?? null,
      finalResponse: finished?.stopped.finalMessage?.content ?? "",
      verification: finished?.stopped.verification ?? null,
      persistence: finished?.persistence ?? null,
      durationMs: finished?.stopped.durationMs ?? null,
      warnings,
      approvalBlocked: false,
      policyId,
      configSource: context.managedSettings ? "managed" : "legacy",
      usage: runLog?.usage ?? null,
      toolCalls: runLog?.tools.length ?? null,
      settingsRevision: context.settingsRevision ?? null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "单次运行失败。";
    const outcome = timeout ? "timed-out" : controller.signal.aborted ? "cancelled" : "failed";
    final = { outcome, stopReason: null, finalResponse: "", error: message };
    exitCode = timeout ? 124 : controller.signal.aborted ? 130 : 2;
  } finally {
    if (timer) clearTimeout(timer);
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
    permissions.closeSession(permissionId);
    try { await runtime.close(); if(conversationId){const scope=await runtime.taskScope(conversationId);const tasks=runtime.tasks.list(scope);if(tasks.length)final={...final,childTasks:tasks};} } catch {
      final = { ...final, ...(final.outcome === "completed" ? { outcome: "failed" } : {}), cleanupWarning: "运行资源清理失败。" };
      if (exitCode === 0) exitCode = 1;
    }
  }
  const result = { schemaVersion: 1, executionId, runId, conversationId, elapsedMs: Date.now() - startedAt, ...final };
  if (args.outputFormat === "json") output.write(`${JSON.stringify(result)}\n`);
  else writeEvent({ type: "finished", result });
  return exitCode;
}

async function readPromptFile(file: string): Promise<string> {
  const info = await stat(file);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error("Prompt 文件无效或超过 1 MiB。");
  return readFile(file, "utf8");
}
async function saveIsolatedPolicy(file: string, policy: string): Promise<void> {
  try { await writeFile(file, policy, { flag: "wx", mode: 0o600 }); return; }
  catch (error) { if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error; }
  const existing = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await existing.stat();
    if (!info.isFile() || info.size > 256 * 1024 || (info.mode & 0o077) !== 0 || await existing.readFile("utf8") !== policy)
      throw new Error("隔离目录已有不同权限策略，请使用原策略或新数据目录。");
  } finally { await existing.close(); }
}
async function readStdin(input: Readable, signal: AbortSignal): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  const abort = () => input.destroy(new Error("标准输入已取消。"));
  if (signal.aborted) throw new Error("标准输入已取消。");
  signal.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of input) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
      size += buffer.byteLength;
      if (size > 1024 * 1024) throw new Error("标准输入超过 1 MiB。");
      chunks.push(buffer);
    }
  } finally { signal.removeEventListener("abort", abort); }
  return Buffer.concat(chunks).toString("utf8");
}
