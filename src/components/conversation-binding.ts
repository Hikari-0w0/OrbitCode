import type { ProviderSummary, WorkspaceSummary } from "@/runtime/types";

// 只为新会话选择有效配置，不修改历史会话的原始绑定。
export function resolveNewConversationBinding(
  workspaceId: string,
  providerId: string,
  workspaces: readonly WorkspaceSummary[],
  providers: readonly ProviderSummary[],
): { workspaceId: string; providerId: string } | undefined {
  const workspace = workspaces.find((item) => item.id === workspaceId && item.available)
    ?? workspaces.find((item) => item.isDefault && item.available)
    ?? workspaces.find((item) => item.available);
  const provider = providers.find((item) => item.name === providerId && item.available)
    ?? providers.find((item) => item.available);
  return workspace && provider
    ? { workspaceId: workspace.id, providerId: provider.name }
    : undefined;
}
