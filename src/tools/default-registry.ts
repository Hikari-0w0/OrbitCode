import type { CommandSandbox } from "@/tools/command-sandbox";
import { editFileTool } from "@/tools/edit-file";
import { findFilesTool } from "@/tools/find-files";
import { readFileTool } from "@/tools/read-file";
import {
  createReadContextTool,
  type ContextContentReader,
} from "@/tools/read-context";
import { ToolRegistry } from "@/tools/registry";
import { createRunCommandTool } from "@/tools/run-command";
import { searchCodeTool } from "@/tools/search-code";
import { writeFileTool } from "@/tools/write-file";

export function createDefaultToolRegistry(
  sandbox: CommandSandbox,
  contextReader?: ContextContentReader,
): ToolRegistry {
  return new ToolRegistry([
    readFileTool,
    writeFileTool,
    editFileTool,
    createRunCommandTool(sandbox),
    findFilesTool,
    searchCodeTool,
    ...(contextReader ? [createReadContextTool(contextReader)] : []),
  ]);
}
