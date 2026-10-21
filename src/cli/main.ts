import {userConfigurationRoot} from "@/runtime/background-service";
import { installMcpShutdown } from "@/runtime/mcp-host";
import { ConversationRepositoryError } from "@/core/conversations/types";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { isCliEntrypoint } from "@/cli/entrypoint";

import {
  ArgumentError,
  HELP_TEXT,
  parseCliArguments,
} from "@/cli/arguments";
import { runTerminalChat } from "@/cli/terminal-chat";
import { runOnce } from "@/cli/run-once";
import { writeFile } from "node:fs/promises";
import { LocalConversationStore } from "@/lib/local-conversation-store";
import { LocalAgentRunLog } from "@/lib/local-agent-run-log";
import { LocalSettingsStore } from "@/lib/local-settings-store";
import { LocalConversationExporter, ConversationExportError } from "@/lib/local-conversation-exporter";
import { AgentRuntime } from "@/runtime/agent-runtime";
import { ConversationService } from "@/runtime/conversation-service";
import { ConversationRuntimeManager } from "@/runtime/conversation-runtime-manager";
import { ConversationOperationGuard } from "@/runtime/conversation-operation-guard";
import { PermissionSessionManager } from "@/runtime/permission-session-manager";
import { loadProviderContext } from "@/runtime/config";
import { loadWorkspaceCatalog, WorkspaceCatalogError } from "@/runtime/workspace-config";
import { loadMcpConfig } from "@/runtime/mcp-config";
import { MacOsSeatbeltCommandSandbox } from "@/tools/macos-seatbelt-sandbox";
import { SessionController, CliInteractionError } from "@/cli/session-controller";
import { TerminalRenderer } from "@/cli/renderer";
import { terminalText } from "@/cli/terminal-text";
import {
  EnvironmentLoadError,
  type Environment,
} from "@/lib/environment";
import {
  AgentRunExportError,
  LocalAgentRunExporter,
} from "@/lib/local-agent-run-exporter";
import {
  ConfigurationError,
} from "@/models/config";

type RunCliOptions = {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: Environment;
  readonly input: Readable;
  readonly output: Writable;
  readonly errorOutput: Writable;
  readonly terminal: boolean;
  readonly store?: LocalConversationStore;
  readonly log?: LocalAgentRunLog;
  readonly userConfigRoot?: string;
};

export async function runCli({
  argv,
  cwd,
  environment,
  input,
  output,
  errorOutput,
  terminal,
  store = new LocalConversationStore(),
  log = new LocalAgentRunLog(),
  userConfigRoot,
}: RunCliOptions): Promise<number> {
  try {
    const argumentsResult = parseCliArguments(argv);
    if (argumentsResult.type === "help") {
      output.write(HELP_TEXT);
      return 0;
    }
    if (argumentsResult.type === "run-once") return runOnce({ arguments: argumentsResult, cwd, environment, input, output, errorOutput });
    if (argumentsResult.type === "export-run") {
      const outputPath = path.resolve(
        cwd,
        argumentsResult.outputPath ?? `orbitcode-run-${argumentsResult.runId}.json`,
      );
      await new LocalAgentRunExporter(log, store).exportRun({
        runId: argumentsResult.runId,
        outputPath,
        includeContext: argumentsResult.includeContext,
      });
      output.write(`已导出运行记录：${terminalText(outputPath)}\n`);
      output.write("注意：文件包含完整对话和工具结果，请按敏感数据保管。\n");
      return 0;
    }

    if (argumentsResult.type === "export-conversation") {
      const data = await new LocalConversationExporter(log, store).createExport(argumentsResult.conversationId);
      const target = path.resolve(cwd, argumentsResult.outputPath ?? `orbitcode-conversation-${argumentsResult.conversationId}.json`);
      await writeFile(target, JSON.stringify(data, null, 2), { mode: 0o600, flag: "wx" });
      output.write("已导出完整会话；包含敏感内容，请妥善保管。\n");
      return 0;
    }
    const dataDir = argumentsResult.dataDir ? path.resolve(cwd, argumentsResult.dataDir) : undefined;
    const settingsStore = new LocalSettingsStore(dataDir);
    const storedSettings = argumentsResult.explicitConfig ? null : await settingsStore.load();
    if (dataDir && !storedSettings) throw new ConfigurationError("config-file", "隔离目录中没有托管设置。");
    const actualStore = dataDir ? new LocalConversationStore(path.join(dataDir, "conversations-v1")) : store;
    const actualLog = dataDir ? new LocalAgentRunLog(path.join(dataDir, "logs")) : log;
    const loadConfig = () => loadProviderContext(cwd, environment, path.resolve(cwd, argumentsResult.configPath),
      Boolean(argumentsResult.explicitConfig), settingsStore, !dataDir);
    const loadWorkspaces = (context?: Awaited<ReturnType<typeof loadConfig>>) => loadWorkspaceCatalog({ cwd, settingsStore,
      ...(context ? { managedSettings: context.managedSettings ?? null } : {}) });
    const manager = new ConversationRuntimeManager();
    const guard = new ConversationOperationGuard(manager, actualStore);
    const permissions = new PermissionSessionManager();
    const conversations = new ConversationService(actualStore, manager, guard, loadConfig);
    const runtime = new AgentRuntime({ userConfigRoot: dataDir ? userConfigurationRoot(dataDir) : userConfigRoot ?? userConfigurationRoot(), store: actualStore, manager, guard, permissions, log: actualLog,
      sandbox: new MacOsSeatbeltCommandSandbox(), loadConfig, loadWorkspaces,
      ...(dataDir ? { loadMcp: async (workspaceRoot: string, context: Awaited<ReturnType<typeof loadConfig>>) => loadMcpConfig({ workspaceRoot,
        environment: context.environment, managedSettings: context.managedSettings ?? null, settingsStore, userHome: dataDir }),
        permissionLocations: (workspaceRoot: string) => ({ user: path.join(dataDir, "permissions.yaml"),
          project: path.join(workspaceRoot, ".orbitcode", "permissions.yaml"),
          local: path.join(workspaceRoot, ".orbitcode", "permissions.local.yaml") }) } : {}),
    });
    conversations.configureMemory(runtime.memory, checkpoint => runtime.scheduleSaved(checkpoint));
conversations.configureTasks(checkpoint => runtime.invalidateTasks(checkpoint));
    const session = new SessionController({ cwd, terminal, runtime, conversations, permissions,
      log: actualLog, loadConfig, loadWorkspaces, renderer: new TerminalRenderer(output, errorOutput),
      defaultPermissionMode: storedSettings?.defaultPermissionMode });
    const removeMcpShutdown = installMcpShutdown(() => runtime.close());
    try {
      await session.initialize(argumentsResult);
      await runTerminalChat({ session, input, output, errorOutput, terminal });
      return session.exitCode;
    } finally { session.close(); await runtime.close(); removeMcpShutdown(); }

  } catch (error) {
    errorOutput.write(`启动失败：${terminalText(startupErrorMessage(error))}\n`);
    return error instanceof ArgumentError ? 2 : 1;
  }
}

function startupErrorMessage(error: unknown): string {
  if (
    error instanceof ArgumentError ||
    error instanceof CliInteractionError ||
    error instanceof ConversationExportError ||
    error instanceof ConversationRepositoryError ||
    error instanceof WorkspaceCatalogError ||
    error instanceof AgentRunExportError ||
    error instanceof EnvironmentLoadError ||
    error instanceof ConfigurationError
  ) {
    return error.message;
  }
  return "发生未知错误。";
}

async function main(): Promise<void> {
  process.exitCode = await runCli({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    environment: process.env,
    input: process.stdin,
    output: process.stdout,
    errorOutput: process.stderr,
    terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  });
}

const entryPath = process.argv[1];
if (isCliEntrypoint(import.meta.url, entryPath)) {
  void main();
}
