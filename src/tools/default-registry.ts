import {createReadMemoryTool, type MemoryContentReader} from "@/tools/read-memory";
import type { CommandSandbox } from "@/tools/command-sandbox";
import { editFileTool } from "@/tools/edit-file";
import { findFilesTool } from "@/tools/find-files";
import type { ManagedProcessController } from "@/tools/managed-process";
import { createProcessTools } from "@/tools/process-tools";
import { readFileTool } from "@/tools/read-file";
import {
  createReadContextTool,
  type ContextContentAccess,
} from "@/tools/read-context";
import { ToolRegistry, type RegisteredTool } from "@/tools/registry";
import { createRunCommandTool } from "@/tools/run-command";
import { searchCodeTool } from "@/tools/search-code";
import { writeFileTool } from "@/tools/write-file";
import { writeFilesTool } from "@/tools/write-files";

export function createDefaultToolRegistry(
  sandbox: CommandSandbox,
  contextReader?: ContextContentAccess,
  processController?: ManagedProcessController,
  externalTools: readonly RegisteredTool[] = [],
  memoryReader?: MemoryContentReader,
): ToolRegistry {
  return new ToolRegistry([
    readFileTool,
    writeFileTool,
    writeFilesTool,
    editFileTool,
    createRunCommandTool(sandbox),
    ...(processController ? createProcessTools(processController) : []),
    findFilesTool,
    searchCodeTool,
    ...(contextReader ? [createReadContextTool(contextReader)] : []),
    ...(memoryReader ? [createReadMemoryTool(memoryReader)] : []),
    ...externalTools,
  ]);
}
