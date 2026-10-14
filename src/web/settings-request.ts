import { SettingsError } from "@/runtime/settings-types";
import { readBoundedJsonBody, WebRequestSecurityError } from "@/web/request-security";

export async function readSettingsRequest(request: Request, fields: readonly string[]): Promise<Record<string, unknown>> {
  const value = await readBoundedJsonBody(request, 16 * 1024);
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).some((field) => !fields.includes(field))) throw new SettingsError("invalid", "管理请求字段无效。");
  return value as Record<string, unknown>;
}

export function settingsRequestErrorStatus(error: unknown): number | undefined {
  if (error instanceof WebRequestSecurityError) return error.kind === "body-too-large" ? 413 : 400;
  if (error instanceof SettingsError) return error.code === "conflict" ? 409 : 400;
  return undefined;
}
