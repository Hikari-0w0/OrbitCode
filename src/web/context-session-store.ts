import { LocalContextStore } from "@/lib/local-context-store";
import { ContextSessionManager } from "@/web/context-session-manager";

export const localContextStore = new LocalContextStore();

// Route Handler 共享进程内会话；浏览器只持有不透明 ID，不是模型历史事实来源。
export const contextSessionManager = new ContextSessionManager();
