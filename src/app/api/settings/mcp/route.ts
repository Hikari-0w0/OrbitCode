import { readSettingsRequest, settingsRequestErrorStatus } from "@/web/settings-request";
import { createMcpRedactor } from "@/lib/mcp-redaction";
import { loadMcpConfig } from "@/runtime/mcp-config";
import { resolveWorkspaceBoundary } from "@/runtime/workspace-config";
import { webMcpHost } from "@/runtime/mcp-host";
import { assertSettingsMutation, LocalManagementError } from "@/web/local-management-guard";
import { loadWorkspaceCatalog } from "@/web/workspace-config";
import { webSettingsStore } from "@/web/storage-paths";
import { loadWebProviderContext } from "@/web/server-config";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    assertSettingsMutation(request);
    const body: unknown = await readSettingsRequest(request, ["action", "serverName", "workspaceId", "expectedRevision"]);
    if (!isRequest(body)) return result(400, { status: "failed", detail: "MCP 管理请求无效。" });
    const settings = await webSettingsStore.load();
    if (!settings || settings.revision !== body.expectedRevision) return result(409, { status: "failed", detail: "配置已变化，请刷新后重试。" });
    const workspace = await resolveWorkspaceBoundary(await loadWorkspaceCatalog(), body.workspaceId);
    const snapshot = await loadMcpConfig({ workspaceRoot: workspace.root,
      environment: (await loadWebProviderContext()).environment, managedSettings: settings, settingsStore: webSettingsStore });
    const server = snapshot.servers.find((item) => item.name === body.serverName);
    if (!server) return result(404, { status: "failed", detail: "该工作区没有已启用的 MCP Server。" });
    const manager = webMcpHost();
    if (body.action === "disconnect") {
      await manager.invalidate(workspace.root, server.name);
      return result(200, { status: "disconnected", detail: "连接已断开；正在使用的调用会先完成。" });
    }
    // 用户显式点击“连接并发现工具”才进入此分支；后续 Agent 工具调用继续走运行时审批。
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]);
    const lease = await manager.acquire({ server, signal, deadlineMs: Date.now() + 20_000, retryFailed: true,
      revalidate: async () => {
        const latest = await webSettingsStore.load();
        if (latest?.revision !== settings.revision) throw new Error("MCP 配置已变化。");
      } });
    try {
      if ((await webSettingsStore.load())?.revision !== body.expectedRevision) return result(409, { status: "expired", detail: "配置已变化，本次工具发现结果已过期。" });
      return result(200, { status: "ready", checkedAt: new Date().toISOString(),
        detail: "本次连接与工具发现成功，尚未调用工具。", tools: lease.tools.map((tool) => createMcpRedactor(server.secrets)(tool.name)) });
    } finally { await lease.release(); }
  } catch (error) {
    if (error instanceof LocalManagementError) return result(403, { status: "failed", detail: error.message });
    return result(settingsRequestErrorStatus(error) ?? 502, { status: "failed", detail: "MCP 连接或工具发现失败，请检查配置与服务状态。" });
  }
}
function isRequest(value: unknown): value is { action: "connect" | "disconnect"; serverName: string; workspaceId: string; expectedRevision: number } {
  return typeof value === "object" && value !== null && "action" in value && (value.action === "connect" || value.action === "disconnect") &&
    "serverName" in value && typeof value.serverName === "string" && "workspaceId" in value && typeof value.workspaceId === "string" &&
    "expectedRevision" in value && Number.isSafeInteger(value.expectedRevision);
}
function result(status: number, body: object): Response { return Response.json(body, { status, headers: { "cache-control": "no-store" } }); }
