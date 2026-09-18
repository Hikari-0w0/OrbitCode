import path from "node:path";
import { runCli } from "@/cli/main";
import { LocalConversationStore } from "@/lib/local-conversation-store";
import { LocalAgentRunLog } from "@/lib/local-agent-run-log";

// 子进程 fixture 显式隔离存储，不修改用户 HOME 或生产默认目录。
void runCli({
  argv: process.argv.slice(2), cwd: process.cwd(), environment: process.env,
  input: process.stdin, output: process.stdout, errorOutput: process.stderr,
  terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  store: new LocalConversationStore(path.join(process.cwd(), ".test-conversations")),
  log: new LocalAgentRunLog(path.join(process.cwd(), ".test-logs")),
}).then((code) => { process.exitCode = code; });
