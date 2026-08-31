import type { CommandSandbox } from "@/tools/command-sandbox";
import { editFileTool } from "@/tools/edit-file";
import { findFilesTool } from "@/tools/find-files";
import type { ManagedProcessController } from "@/tools/managed-process";
import type { CompletionTracker } from "@/core/completion-tracker";
import { createProcessTools } from "@/tools/process-tools";
import { createReportCompletionTool } from "@/tools/report-completion";
import { readFileTool } from "@/tools/read-file";
import {
  createReadContextTool,
  type ContextContentReader,
} from "@/tools/read-context";
import { ToolRegistry } from "@/tools/registry";
import { createRunCommandTool } from "@/tools/run-command";
import { searchCodeTool } from "@/tools/search-code";
import { writeFileTool } from "@/tools/write-file";
import { writeFilesTool } from "@/tools/write-files";

export function createDefaultToolRegistry(
  sandbox: CommandSandbox,
  contextReader?: ContextContentReader,
  processController?: ManagedProcessController,
  completionTracker?: CompletionTracker,
): ToolRegistry {
  return new ToolRegistry([
    readFileTool,
    writeFileTool,
    writeFilesTool,
    editFileTool,
    createRunCommandTool(sandbox),
    ...(processController ? createProcessTools(processController) : []),
    ...(completionTracker ? [createReportCompletionTool(completionTracker)] : []),
    findFilesTool,
    searchCodeTool,
    ...(contextReader ? [createReadContextTool(contextReader)] : []),
  ]);
}
