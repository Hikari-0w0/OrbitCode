import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

import {
  ArgumentError,
  HELP_TEXT,
  parseCliArguments,
} from "@/cli/arguments";
import { runTerminalChat } from "@/cli/terminal-chat";
import { InMemoryConversationSession } from "@/core/conversation";
import {
  EnvironmentLoadError,
  loadLocalEnvironment,
  type Environment,
} from "@/lib/environment";
import {
  AgentRunExportError,
  LocalAgentRunExporter,
} from "@/lib/local-agent-run-exporter";
import {
  ConfigurationError,
  loadProviderConfig,
} from "@/models/config";
import { createChatProvider } from "@/models/provider-factory";

type RunCliOptions = {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: Environment;
  readonly input: Readable;
  readonly output: Writable;
  readonly errorOutput: Writable;
  readonly terminal: boolean;
};

export async function runCli({
  argv,
  cwd,
  environment,
  input,
  output,
  errorOutput,
  terminal,
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
      await new LocalAgentRunExporter().exportRun({
        runId: argumentsResult.runId,
        outputPath,
        includeContext: argumentsResult.includeContext,
      });
      output.write(`已导出运行记录：${outputPath}\n`);
      output.write("注意：文件包含完整对话和工具结果，请按敏感数据保管。\n");
      return 0;
    }

    const mergedEnvironment = await loadLocalEnvironment({
      cwd,
      processEnvironment: environment,
    });
    const config = await loadProviderConfig({
      filePath: path.resolve(cwd, argumentsResult.configPath),
      providerName: argumentsResult.providerName,
      environment: mergedEnvironment,
    });
    const session = new InMemoryConversationSession(createChatProvider(config));
    await runTerminalChat({
      session,
      input,
      output,
      errorOutput,
      terminal,
    });
    return 0;
  } catch (error) {
    errorOutput.write(`启动失败：${startupErrorMessage(error)}\n`);
    return 1;
  }
}

function startupErrorMessage(error: unknown): string {
  if (
    error instanceof ArgumentError ||
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
    terminal: Boolean(process.stdout.isTTY),
  });
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  void main();
}
