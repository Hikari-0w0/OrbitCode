import { parseServerSentEvents } from "@/models/sse";
import { readWebStream } from "@/web/chat-contract";

export async function runSettingsOperation(body: object, token: string, signal: AbortSignal): Promise<{ ok: boolean; result: unknown }> {
  const headers = { "content-type": "application/json", "x-orbitcode-settings-token": token };
  let operationId: string | undefined;
  try {
    const created = await fetch("/api/settings/operations", { method: "POST", headers, body: JSON.stringify(body), signal });
    const value: unknown = await created.json();
    if (!created.ok || typeof value !== "object" || value === null || !("operationId" in value) || typeof value.operationId !== "string")
      throw new Error("无法启动管理操作。");
    operationId = value.operationId;
    const response = await fetch(`/api/settings/operations/${operationId}`, { headers, signal });
    if (!response.ok || !response.body) throw new Error("无法订阅管理操作。");
    for await (const data of parseServerSentEvents(readWebStream(response.body))) {
      const event: unknown = JSON.parse(data);
      if (typeof event === "object" && event !== null && "type" in event && event.type === "finished" &&
        "result" in event && "httpStatus" in event && typeof event.httpStatus === "number")
        return { ok: event.httpStatus >= 200 && event.httpStatus < 300, result: event.result };
    }
    throw new Error("管理操作未返回终态。");
  } finally {
    // 断流或离开页面时也显式取消；服务端同时监听订阅断开作为兜底。
    if (operationId) void fetch(`/api/settings/operations/${operationId}`, { method: "DELETE", headers, keepalive: true }).catch(() => undefined);
  }
}
