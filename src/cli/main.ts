import { ConversationRepositoryError } from "@/core/conversations/types";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

import {
  ArgumentError,
  HELP_TEXT,
  parseCliArguments,
} from "@/cli/arguments";
import { runTerminalChat } from "@/cli/terminal-chat";
import { writeFile } from "node:fs/promises";
import { LocalConversationStore } from "@/lib/local-conversation-store";
import { LocalAgentRunLog } from "@/lib/local-agent-run-log";
import { LocalConversationExporter, ConversationExportError } from "@/lib/local-conversation-exporter";
import { AgentRuntime } from "@/runtime/agent-runtime";
import { ConversationService } from "@/runtime/conversation-service";
import { ConversationRuntimeManager } from "@/runtime/conversation-runtime-manager";
import { ConversationOperationGuard } from "@/runtime/conversation-operation-guard";
import { PermissionSessionManager } from "@/runtime/permission-session-manager";
import { loadProviderContext } from "@/runtime/config";
import { loadWorkspaceCatalog, WorkspaceCatalogError } from "@/runtime/workspace-config";
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
}: RunCliOptions): Promise<number> {
  try {
    const argumentsResult = parseCliArguments(argv);
    if (argumentsResult.type === "help") {
      output.write(HELP_TEXT);
      return 0;
    }
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
    const loadConfig = () => loadProviderContext(cwd, environment, path.resolve(cwd, argumentsResult.configPath));
    const loadWorkspaces = () => loadWorkspaceCatalog({ cwd });
    const manager = new ConversationRuntimeManager();
    const guard = new ConversationOperationGuard(manager, store);
    const permissions = new PermissionSessionManager();
    const conversations = new ConversationService(store, manager, guard, loadConfig);
    const runtime = new AgentRuntime({ store, manager, guard, permissions, log,
      sandbox: new MacOsSeatbeltCommandSandbox(), loadConfig, loadWorkspaces });
    const session = new SessionController({ cwd, terminal, runtime, conversations, permissions,
      log, loadConfig, loadWorkspaces, renderer: new TerminalRenderer(output, errorOutput) });
    try {
      await session.initialize(argumentsResult);
      await runTerminalChat({ session, input, output, errorOutput, terminal });
      return session.exitCode;
    } finally { session.close(); }

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
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  void main();
}
