import { AgentRuntime } from "@/runtime/agent-runtime";
import { ConversationService } from "@/runtime/conversation-service";
import { MacOsSeatbeltCommandSandbox } from "@/tools/macos-seatbelt-sandbox";
import { localConversationStore, conversationRuntimeManager, conversationOperationGuard } from "@/web/conversation-store";
import { permissionSessionManager } from "@/web/permission-session-store";
import { localAgentRunLog } from "@/web/agent-run-log-store";
import { loadWebProviderContext } from "@/web/server-config";
import { loadWorkspaceCatalog } from "@/web/workspace-config";

export const webAgentRuntime = new AgentRuntime({
  store: localConversationStore, manager: conversationRuntimeManager,
  guard: conversationOperationGuard, permissions: permissionSessionManager,
  sandbox: new MacOsSeatbeltCommandSandbox(), log: localAgentRunLog,
  loadConfig: loadWebProviderContext, loadWorkspaces: loadWorkspaceCatalog,
});
export const webConversationService = new ConversationService(
  localConversationStore, conversationRuntimeManager, conversationOperationGuard, loadWebProviderContext,
);
