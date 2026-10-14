import { readSettingsRequest, settingsRequestErrorStatus } from "@/web/settings-request";
import { SettingsService } from "@/runtime/settings-service";
import { SettingsError } from "@/runtime/settings-types";
import { assertSettingsMutation, LocalManagementError } from "@/web/local-management-guard";
import { webSettingsStore } from "@/web/storage-paths";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    assertSettingsMutation(request);
    const body: unknown = await readSettingsRequest(request, ["action"]);
    if (typeof body !== "object" || body === null || !("action" in body) || body.action !== "backup-and-reset")
      throw new SettingsError("invalid", "恢复操作无效。");
    const backup = await webSettingsStore.recoverInvalid();
    return Response.json({ settings: await new SettingsService(webSettingsStore).view(), backup },
      { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const status = error instanceof LocalManagementError ? 403 : settingsRequestErrorStatus(error) ?? 500;
    return Response.json({ error: error instanceof LocalManagementError || error instanceof SettingsError ? error.message : "无法恢复设置。" },
      { status, headers: { "cache-control": "no-store" } });
  }
}
