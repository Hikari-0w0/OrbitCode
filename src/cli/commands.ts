export type CliInput =
  | { readonly type: "empty" }
  | { readonly type: "message"; readonly text: string }
  | { readonly type: "command"; readonly name: string; readonly argument: string };
const commands = new Set([
  "knowledge", "agents", "tasks", "task", "delegation",
  "skills", "skill", "background", "memory", "cleanup", "help", "status", "exit", "cancel", "providers", "provider", "workspaces", "workspace",
  "plan", "do", "execute-plan", "permissions", "approve", "new", "conversations", "resume",
  "history", "rename", "clear", "delete", "confirm", "compress", "retry-save", "recover", "tool", "export",
]);
export function parseCliInput(line: string): CliInput {
  const text = line.trim();
  if (!text) return { type: "empty" };
  if (text.startsWith("//")) return { type: "message", text: text.slice(1) };
  if (!text.startsWith("/")) return { type: "message", text: line };
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) throw new Error("无效控制命令。输入 /help 查看帮助。");
  const name = match[1];
  const argument = match[2] ?? "";
  if ((name === "plan" || name === "do") && argument) return { type: "message", text: line };
  if (!commands.has(name)) throw new Error("未知控制命令。输入 /help 查看帮助；// 可发送以 / 开头的正文。");
  return { type: "command", name, argument };
}
export const COMMAND_HELP = `
/knowledge config|on|off|status|build|update|rebuild|cancel|delete
/agents /tasks /task show|wait|background|cancel <id>
/task result <id> [offset]（分页读取子回复正文）
/delegation collaborate|delegate-only [auto|defined|fork]（父级分工及新子任务类型）
/skills /skills refresh /skill run <name> [参数] /skill deactivate <name>
/help /status /exit /cancel
/providers /provider <name> /workspaces /workspace <id>
/plan /do /execute-plan
/new /conversations /resume <id> /history /rename <title>
/clear /delete <id> /confirm <token>
/compress /retry-save /recover /tool <call-id> /export <path>
/background /memory [user|project] list|show <id>|update <id> <file>|delete <id>
/memory on|off /cleanup preview /cleanup delete <id...>
`;
