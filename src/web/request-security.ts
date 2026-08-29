import { WebChatContractError } from "@/web/chat-contract";

export const MAX_PERMISSION_API_BODY_BYTES = 16 * 1024;

export class WebRequestSecurityError extends Error {
  constructor(
    readonly kind: "forbidden-origin" | "body-too-large" | "invalid-json",
    message: string,
  ) {
    super(message);
    this.name = "WebRequestSecurityError";
  }
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  let requestOrigin: string;
  try {
    requestOrigin = new URL(request.url).origin;
  } catch {
    throw new WebRequestSecurityError("forbidden-origin", "请求来源无效。");
  }
  if (origin !== requestOrigin) {
    throw new WebRequestSecurityError(
      "forbidden-origin",
      "本地服务状态变更只接受同源请求。",
    );
  }
}

export async function readPermissionJsonBody(request: Request): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) || Number(length) > MAX_PERMISSION_API_BODY_BYTES)
  ) {
    throw new WebRequestSecurityError("body-too-large", "请求体过大。");
  }
  if (!request.body) {
    throw new WebChatContractError("请求体不能为空。");
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let source = "";
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_PERMISSION_API_BODY_BYTES) {
        await reader.cancel();
        throw new WebRequestSecurityError("body-too-large", "请求体过大。");
      }
      source += decoder.decode(item.value, { stream: true });
    }
    source += decoder.decode();
  } catch (error) {
    if (error instanceof WebRequestSecurityError) throw error;
    throw new WebRequestSecurityError("invalid-json", "无法读取请求体。");
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new WebRequestSecurityError("invalid-json", "请求体必须是有效 JSON。");
  }
}
