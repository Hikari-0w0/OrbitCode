import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { LocalConversationStore } from "@/lib/local-conversation-store";
import { LocalAgentRunLog } from "@/lib/local-agent-run-log";
import { LocalSettingsStore } from "@/lib/local-settings-store";
import { AgentRuntime } from "@/runtime/agent-runtime";
import { ConversationService } from "@/runtime/conversation-service";
import { ConversationRuntimeManager } from "@/runtime/conversation-runtime-manager";
import { ConversationOperationGuard } from "@/runtime/conversation-operation-guard";
import { PermissionSessionManager } from "@/runtime/permission-session-manager";
import { loadProviderContext } from "@/runtime/config";
import { loadWorkspaceCatalog } from "@/runtime/workspace-config";
import { loadMcpConfig } from "@/runtime/mcp-config";
import { createChatProvider } from "@/models/provider-factory";
import type { ResolvedProviderConfig } from "@/models/config";
import type { ModelStreamEvent, ModelToolCall } from "@/models/provider";
import { MacOsSeatbeltCommandSandbox } from "@/tools/macos-seatbelt-sandbox";
import { createWorkspaceBoundary } from "@/tools/workspace";
import { TerminalRenderer } from "@/cli/renderer";
import { SessionController } from "@/cli/session-controller";
import { DEFAULT_SUB_AGENT_LIMITS, type SubAgentLimits } from "@/core/sub-agents/types";
import type { ManagedSettings } from "@/runtime/settings-types";
import type { ManagedContextMessage } from "@/core/context/types";
import type { PermissionMode } from "@/core/permissions/types";
import { snapshotWorkspace } from "./sub-agent-workspace-snapshot";

export type RequestTrace = { readonly child: boolean; readonly call: ModelToolCall };
export const scrubCredential = (value: string, source: ResolvedProviderConfig): string => source.apiKey ? value.replaceAll(source.apiKey, "[REDACTED]") : value;

export async function realSubAgentFixture(base: string, name: string, source: ResolvedProviderConfig, files: Readonly<Record<string, string>> = {}, offload = false, limits: Partial<SubAgentLimits> = {}, options: { readonly permissionMode?: PermissionMode } = {}) {
  const root = await mkdtemp(path.join(base, `${name}-`));
  const workspace = path.join(root, "workspace"), data = path.join(root, "data");
  const environment = { ...process.env, ORBITCODE_SUB_AGENT_EVAL_KEY: source.apiKey };
  const save = (file: string, value: unknown) => writeFile(path.join(root, file), scrubCredential(JSON.stringify(value, null, 2), source));
  await mkdir(workspace, { recursive: true });
  await mkdir(data, { recursive: true, mode: 0o700 });
  const allTools = ["read_file", "find_files", "search_code", "read_context", "read_memory", "write_file", "write_files", "edit_file", "run_command", "start_process", "process_status", "stop_process", "load_skill", "read_skill_resource"];
  const role = (name: string, tools: readonly string[]) => `---\nname: ${name}\ndescription: 真实模型验收 ${name}\nallowed-tools: [${tools.join(", ")}]\ndisallowed-tools: [agent]\nmodel: inherit\nmax-iterations: 16\npermission-mode: permissive\n---\n完成指定子任务，只操作授权文件；检查真实工具结果，报告副作用、失败和未验证项。禁止委派和启动独立 Skill。\n`;
  const initialFiles = {
    "AGENTS.md": "这是隔离验收项目。不得联网、安装依赖、读取工作区外文件或配置，不执行 Git 操作。执行已授权任务时先使用真实工具。命令失败必须保留原退出码，不加 || true 或 echo 掩盖。最终陈述不代替验证。",
    ".orbitcode/agents/builder.md": role("builder", allTools),
    ".orbitcode/agents/reader.md": role("reader", ["read_file", "find_files", "search_code", "read_context", "load_skill", "read_skill_resource"]),
    ...files,
  };
  for (const [file, content] of Object.entries(initialFiles)) {
    await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await writeFile(path.join(workspace, file), content);
  }
  const settingsStore = new LocalSettingsStore(data);
  const settings: Omit<ManagedSettings, "revision"> = {
    schemaVersion: 1,
    providers: [{ id: "real", displayName: "真实模型隔离复测", model: source.model, baseUrl: source.baseUrl, credential: { kind: "environment", variable: "ORBITCODE_SUB_AGENT_EVAL_KEY" }, context: { ...source.context, ...(offload ? { singleToolResultTokens: 1200, toolResultGroupTokens: 2000, previewChars: 200 } : {}) }, ...(source.thinking ? { thinking: source.thinking } : {}), ...(source.transport ? { transport: source.transport } : {}), maxOutputTokens: 8192, enabled: true }],
    workspaces: [{ id: "eval", name, rootPath: workspace, enabled: true }], mcpServers: [], defaultProviderId: "real", defaultWorkspaceId: "eval", maxIterations: 24, maxRuntimeMinutes: 6, defaultPermissionMode: options.permissionMode ?? "permissive",
    subAgents: { ...DEFAULT_SUB_AGENT_LIMITS, perTurn: 8, capacity: 48, concurrency: 3, maxIterations: 20, maxRuntimeMinutes: 5, waitSeconds: 30, ...limits },
  };
  await settingsStore.save(0, settings);
  const loadConfig = () => loadProviderContext(workspace, environment, undefined, false, settingsStore, false);
  const loadWorkspaces = () => loadWorkspaceCatalog({ cwd: workspace, settingsStore });
  const store = new LocalConversationStore(path.join(data, "conversations-v1"));
  const log = new LocalAgentRunLog(path.join(data, "logs"));
  const manager = new ConversationRuntimeManager(), guard = new ConversationOperationGuard(manager, store), permissions = new PermissionSessionManager();
  const calls: RequestTrace[] = [];
  let sequence = 0;
  const runtime = new AgentRuntime({
    store, log, manager, guard, permissions, userConfigRoot: data, sandbox: new MacOsSeatbeltCommandSandbox(), loadConfig, loadWorkspaces,
    loadMcp: workspaceRoot => loadMcpConfig({ workspaceRoot, userHome: path.join(root, "home"), environment }),
    permissionLocations: workspaceRoot => ({ user: path.join(data, "permissions.yaml"), project: path.join(workspaceRoot, ".orbitcode/permissions.yaml"), local: path.join(workspaceRoot, ".orbitcode/permissions.local.yaml") }),
    createProvider: config => {
      const provider = createChatProvider(config);
      return { supportsRequestTokenLimit: provider.supportsRequestTokenLimit, async *stream(messages, options) {
        const index = ++sequence, child = JSON.stringify(messages).includes("orbitcode_child_role");
        const events: ModelStreamEvent[] = [];
        await save(`request-${index}.json`, { child, messages, toolNames: options.tools?.map(tool => tool.function.name) });
        await save(`files-before-${index}.json`, await snapshotWorkspace(workspace));
        try {
          for await (const event of provider.stream(messages, options)) {
            if (event.type === "tool-call") calls.push({ child, call: event.call });
            if (event.type !== "text-delta") events.push(event);
            yield event;
          }
        } finally {
          // 子最终响应返回后、交付父结果前保存哈希；每个请求独立文件，避免并发覆盖。
          await save(`events-${index}.json`, { child, events });
          await save(`files-after-${index}.json`, await snapshotWorkspace(workspace));
        }
      } };
    },
  });
  const output = new Writable({ write(chunk, _encoding, done) { void appendFile(path.join(root, "terminal.txt"), scrubCredential(String(chunk), source)).then(() => done(), done); } });
  const conversations = new ConversationService(store, manager, guard, loadConfig);
  conversations.configureTasks(checkpoint => runtime.invalidateTasks(checkpoint));
  conversations.configureMemory(runtime.memory, checkpoint => runtime.scheduleSaved(checkpoint));
  const controller = new SessionController({ cwd: workspace, terminal: true, runtime, conversations, permissions, log, loadConfig, loadWorkspaces, defaultPermissionMode: options.permissionMode ?? "permissive", renderer: new TerminalRenderer(output, output) });
  const checkpoint = async () => store.load((await store.list())[0].id);
  const tasks = async () => runtime.tasks.list(await runtime.taskScope((await checkpoint()).summary.id));
  try {
    await runtime.memory.setEnabled(false);
    await controller.initialize({});
  } catch (error) { controller.close(); await runtime.close(); throw error; }
  return {
    root, workspace, save, tasks, calls, log, checkpoint,
    usage: async () => runtime.usageFor(await runtime.taskScope((await checkpoint()).summary.id)),
    seedHistory: async (messages: readonly ManagedContextMessage[]) => {
      const current = await checkpoint();
      const operation = await guard.begin(current.summary.id, "rename");
      try { await store.save({ conversationId: current.summary.id, expectedRevision: current.summary.revision, checkpoint: { ...current, context: { messages, consecutiveSummaryFailures: 0 } } }); }
      finally { await operation.finish(); }
      await controller.handleLine(`/resume ${current.summary.id}`);
    },
    readReply: async (taskId:string,offset=0,limit=4000) => runtime.readTaskReply((await checkpoint()).summary.id,taskId,offset,limit),
    run: async (prompt: string,parentExecutionMode?:import("@/core/sub-agents/parent-execution").ParentExecutionMode, delegationKind?: import("@/core/sub-agents/parent-execution").DelegationKind) => {
      if(parentExecutionMode)await controller.handleLine(`/delegation ${parentExecutionMode}${delegationKind ? " " + delegationKind : ""}`);
      await save(`prompt-${sequence + 1}.json`, { prompt });
      const timer = setTimeout(() => controller.cancel(), 360000);
      try { await controller.handleLine(prompt); } finally { clearTimeout(timer); }
    },
    settle: async () => {
      const deadline = Date.now() + 300000;
      while (Date.now() < deadline) {
        const current = await tasks();
        if (current.every(task => task.state.status === "terminal")) return current;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      throw new Error("子任务未在评测等待上限内终止。");
    },
    independent: async (code: string) => {
      const boundary = await createWorkspaceBoundary(workspace);
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      const result = await new MacOsSeatbeltCommandSandbox().run({ command: `${quote(process.execPath)} --input-type=module -e ${quote(code)}`, cwd: await boundary.resolveExistingDirectory(), timeoutMs: 15000, outputLimitBytes: 16000 }, { workspace: boundary, signal: new AbortController().signal });
      await save("independent.json", result);
      return result;
    },
    close: async () => {
      controller.close();
      await runtime.close();
      await save("checkpoint.json", await checkpoint());
      await save("files-final.json", await snapshotWorkspace(workspace));
      await save("cleanup.json", { runtimeClosed: true });
      output.end();
    },
  };
}
