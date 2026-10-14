import type { ManagedSettings } from "@/runtime/settings-types";
import { loadMcpConfig } from "@/runtime/mcp-config";
import { webMcpHost } from "@/runtime/mcp-host";
import { loadWebProviderContext } from "@/web/server-config";

export async function reconcileWebMcpSettings(previous: ManagedSettings | null, next: ManagedSettings): Promise<void> {
  const roots = new Set([...(previous?.workspaces ?? []), ...next.workspaces].map((workspace) => workspace.rootPath));
  const { environment } = await loadWebProviderContext();
  for (const workspaceRoot of roots) {
    const active = next.workspaces.some((workspace) => workspace.rootPath === workspaceRoot && workspace.enabled);
    const servers = active ? (await loadMcpConfig({ workspaceRoot, environment, managedSettings: next })).servers : [];
    // reconcile 只释放空闲连接或标记现有租约排空，不初始化新连接。
    await webMcpHost().reconcile(workspaceRoot, servers);
  }
}
