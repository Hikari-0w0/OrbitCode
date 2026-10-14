import { readSettingsRequest, settingsRequestErrorStatus } from "@/web/settings-request";
import { createChatProvider } from "@/models/provider-factory";
import { loadWebProviderContext, resolveWebProvider } from "@/web/server-config";
import { assertSettingsMutation, LocalManagementError } from "@/web/local-management-guard";
import { webSettingsStore } from "@/web/storage-paths";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    assertSettingsMutation(request);
    const body: unknown = await readSettingsRequest(request, ["providerId", "expectedRevision"]);
    if (!isProbeRequest(body)) return result(400, { status: "failed", detail: "探测请求无效。" });
    const settings = await webSettingsStore.load();
    if (!settings || settings.revision !== body.expectedRevision) return result(409, { status: "failed", detail: "配置已变化，请刷新后重试。" });
    if (!settings.providers.some((provider) => provider.id === body.providerId && provider.enabled)) return result(404, { status: "failed", detail: "模型配置不存在或已停用。" });
    const context = await loadWebProviderContext();
    if (context.settingsRevision !== body.expectedRevision) return result(409, { status: "expired", detail: "配置已变化，本次测试未启动。" });
    const provider = createChatProvider(resolveWebProvider(context, body.providerId));
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
    let done = false;
    for await (const event of provider.stream([
      { role: "system", content: "这是连接探测。不要调用工具，只需回复简短文本。" },
      { role: "user", content: "回复 OK" },
    ], { signal, toolChoice: "none" })) if (event.type === "done") done = true;
    if ((await webSettingsStore.load())?.revision !== body.expectedRevision) return result(409, { status: "expired", detail: "配置已变化，本次测试结果已过期。" });
    return result(done ? 200 : 502, { status: done ? "succeeded" : "failed", detail: done ? "本次模型请求成功。" : "模型未返回完成事件。", checkedAt: new Date().toISOString() });
  } catch (error) {
    if (error instanceof LocalManagementError) return result(403, { status: "failed", detail: error.message });
    return result(settingsRequestErrorStatus(error) ?? 502, { status: "failed", detail: "模型探测失败，请检查地址、凭据与服务状态。" });
  }
}
function isProbeRequest(value: unknown): value is { providerId: string; expectedRevision: number } {
  return typeof value === "object" && value !== null && "providerId" in value && typeof value.providerId === "string" && "expectedRevision" in value && Number.isSafeInteger(value.expectedRevision);
}
function result(status: number, body: object): Response { return Response.json(body, { status, headers: { "cache-control": "no-store" } }); }
