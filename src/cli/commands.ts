export type CliInput =
  | { readonly type: "empty" }
  | { readonly type: "message"; readonly text: string }
  | { readonly type: "command"; readonly name: string; readonly argument: string };
const commands = new Set([
  "help", "status", "exit", "cancel", "providers", "provider", "workspaces", "workspace",
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
/help /status /exit /cancel
/providers /provider <name> /workspaces /workspace <id>
/plan /do /execute-plan /permissions <strict|default|permissive>
/approve <request-id> <once|session|permanent|deny>
/new /conversations /resume <id> /history /rename <title>
/clear /delete <id> /confirm <token>
/compress /retry-save /recover /tool <call-id> /export <path>
`;
