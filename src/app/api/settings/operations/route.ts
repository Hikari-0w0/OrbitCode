import { POST as probe } from "@/app/api/settings/probe/route";
import { POST as mcp } from "@/app/api/settings/mcp/route";
import { assertSettingsMutation, settingsSessionOwner, LocalManagementError } from "@/web/local-management-guard";
import { readSettingsRequest, settingsRequestErrorStatus } from "@/web/settings-request";
import { settingsOperations } from "@/web/settings-operations";

export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> {
  try {
    assertSettingsMutation(request);
    const body = await readSettingsRequest(request, ["type", "providerId", "serverName", "workspaceId", "expectedRevision"]);
    if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0 ||
      (body.type !== "provider-probe" && body.type !== "mcp-connect") ||
      (body.type === "provider-probe" ? typeof body.providerId !== "string" : typeof body.serverName !== "string" || typeof body.workspaceId !== "string"))
      return Response.json({ error: "管理操作字段无效。" }, { status: 400 });
    const provider = body.type === "provider-probe";
    const operationId = settingsOperations.start(settingsSessionOwner(request), (signal) => {
      const forwarded = new Request(new URL(provider ? "/api/settings/probe" : "/api/settings/mcp", request.url), {
        method: "POST", headers: request.headers, signal,
        body: JSON.stringify(provider ? { providerId: body.providerId, expectedRevision: body.expectedRevision }
          : { action: "connect", serverName: body.serverName, workspaceId: body.workspaceId, expectedRevision: body.expectedRevision }),
      });
      return provider ? probe(forwarded) : mcp(forwarded);
    });
    return Response.json({ operationId }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: "无法创建管理操作。" }, { status: error instanceof LocalManagementError ? 403 : settingsRequestErrorStatus(error) ?? 503 });
  }
}
