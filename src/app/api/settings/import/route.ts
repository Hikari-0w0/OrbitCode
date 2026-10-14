import { readSettingsRequest, settingsRequestErrorStatus } from "@/web/settings-request";
import { commitLegacySettings, previewLegacySettings } from "@/runtime/settings-import";
import { SettingsService } from "@/runtime/settings-service";
import { SettingsError } from "@/runtime/settings-types";
import { assertSettingsMutation, LocalManagementError } from "@/web/local-management-guard";
import { webDataDirectory, webSettingsStore } from "@/web/storage-paths";
import { loadLocalEnvironment } from "@/lib/environment";

export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> {
  try {
    assertSettingsMutation(request);
    const body: unknown = await readSettingsRequest(request, ["action", "previewId", "expectedRevision"]);
    if (!record(body) || (body.action !== "preview" && body.action !== "commit")) throw new SettingsError("invalid", "导入请求无效。");
    const environment = webDataDirectory ? process.env : await loadLocalEnvironment({ cwd: process.cwd(), processEnvironment: process.env });
    const source = { cwd: process.cwd(), environment, ...(webDataDirectory ? { userHome: webDataDirectory } : {}) };
    if (body.action === "preview") return Response.json(await previewLegacySettings(source), { headers: { "cache-control": "no-store" } });
    if (typeof body.previewId !== "string" || !Number.isSafeInteger(body.expectedRevision)) throw new SettingsError("invalid", "导入确认参数无效。");
    await commitLegacySettings({ previewId: body.previewId, expectedRevision: Number(body.expectedRevision), ...source, store: webSettingsStore });
    return Response.json(await new SettingsService(webSettingsStore).view(), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const status = error instanceof LocalManagementError ? 403 : settingsRequestErrorStatus(error) ?? 500;
    return Response.json({ error: error instanceof LocalManagementError || error instanceof SettingsError ? error.message : "无法导入旧配置。" }, { status, headers: { "cache-control": "no-store" } });
  }
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
