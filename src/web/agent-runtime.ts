import {userConfigurationRoot} from "@/runtime/background-service";
import { webMcpHost } from "@/runtime/mcp-host";
import { AgentRuntime } from "@/runtime/agent-runtime";
import { ConversationService } from "@/runtime/conversation-service";
import { MacOsSeatbeltCommandSandbox } from "@/tools/macos-seatbelt-sandbox";
import { localConversationStore, conversationRuntimeManager, conversationOperationGuard } from "@/web/conversation-store";
import { permissionSessionManager } from "@/web/permission-session-store";
import { localAgentRunLog } from "@/web/agent-run-log-store";
import { loadWebProviderContext } from "@/web/server-config";
import { loadWorkspaceCatalog } from "@/web/workspace-config";
import { loadMcpConfig } from "@/runtime/mcp-config";
import path from "node:path";
import { webDataDirectory, webSettingsStore } from "@/web/storage-paths";

export const webAgentRuntime = new AgentRuntime({
  userConfigRoot: userConfigurationRoot(webDataDirectory),
  mcpConnections: webMcpHost(),
  store: localConversationStore, manager: conversationRuntimeManager,
  guard: conversationOperationGuard, permissions: permissionSessionManager,
  sandbox: new MacOsSeatbeltCommandSandbox(), log: localAgentRunLog,
  loadConfig: loadWebProviderContext,
  loadWorkspaces: (context) => loadWorkspaceCatalog({ managedSettings: context.managedSettings ?? null }),
  loadMcp: async (workspaceRoot, context) => loadMcpConfig({ workspaceRoot, environment: context.environment,
    managedSettings: context.managedSettings ?? null, settingsStore: webSettingsStore,
    ...(webDataDirectory ? { userHome: webDataDirectory } : {}) }),
  ...(webDataDirectory ? { permissionLocations: isolatedPermissionLocations(webDataDirectory) } : {}),
});

function isolatedPermissionLocations(dataDirectory: string) {
  return (workspaceRoot: string) => ({
    user: path.join(dataDirectory, "permissions.yaml"),
    project: path.join(workspaceRoot, ".orbitcode", "permissions.yaml"),
    local: path.join(workspaceRoot, ".orbitcode", "permissions.local.yaml"),
  });
}
export const webConversationService = new ConversationService(
  localConversationStore, conversationRuntimeManager, conversationOperationGuard, loadWebProviderContext,
);

webConversationService.configureMemory(webAgentRuntime.memory, checkpoint => webAgentRuntime.scheduleSaved(checkpoint));
webConversationService.configureTasks(checkpoint => webAgentRuntime.invalidateTasks(checkpoint));
