import { LocalAgentRunLog } from "@/lib/local-agent-run-log";
import { webLogDirectory } from "@/web/storage-paths";

// Route Handler 共享写入队列，避免并发 Agent 运行交错破坏 JSONL。
export const localAgentRunLog = new LocalAgentRunLog(webLogDirectory);
