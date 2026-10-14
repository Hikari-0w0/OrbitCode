import { randomBytes, timingSafeEqual } from "node:crypto";

const cookieName = "orbitcode_settings_session";
const sessions = new Map<string, number>();
const sessionLifetimeMs = 8 * 60 * 60 * 1000;

export class LocalManagementError extends Error {
  constructor(readonly code: "forbidden" | "session", message: string) { super(message); this.name = "LocalManagementError"; }
}

export function assertLocalRequest(request: Request): void {
  const url = new URL(request.url);
  const host = request.headers.get("host");
  if (!host) throw new LocalManagementError("forbidden", "请求缺少 Host。");
  let hostUrl: URL;
  try { hostUrl = new URL(`${url.protocol}//${host}`); }
  catch { throw new LocalManagementError("forbidden", "请求 Host 无效。"); }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostUrl.hostname) || hostUrl.pathname !== "/" ||
    hostUrl.username || hostUrl.password || hostUrl.search || hostUrl.hash || !["http:", "https:"].includes(url.protocol))
    throw new LocalManagementError("forbidden", "设置管理仅允许本机访问。");
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if ((forwardedHost && forwardedHost !== host) || (forwardedProto && forwardedProto !== url.protocol.slice(0, -1))) throw new LocalManagementError("forbidden", "代理请求不能修改本地设置。");
  const origin = request.headers.get("origin");
  if (origin && origin !== hostUrl.origin) throw new LocalManagementError("forbidden", "设置请求必须来自同源页面。");
}

export function openSettingsSession(request: Request): Headers {
  assertLocalRequest(request);
  for (const [token, expiresAt] of sessions) if (expiresAt <= Date.now()) sessions.delete(token);
  const previous = cookieToken(request);
  const sessionToken = previous && sessions.has(previous) ? previous : randomBytes(32).toString("hex");
  if (!sessions.has(sessionToken) && sessions.size >= 128) throw new LocalManagementError("session", "管理会话数量已达上限，请稍后重试。");
  sessions.set(sessionToken, Date.now() + sessionLifetimeMs);
  const headers = new Headers({ "cache-control": "no-store" });
  headers.set("set-cookie", `${cookieName}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/api/settings`);
  headers.set("x-orbitcode-settings-token", sessionToken);
  return headers;
}

export function assertSettingsMutation(request: Request): void {
  assertLocalRequest(request);
  const origin = request.headers.get("origin");
  if (!origin || origin !== `${new URL(request.url).protocol}//${request.headers.get("host")}`) throw new LocalManagementError("forbidden", "设置修改需要同源 Origin。");
  settingsSessionOwner(request);
}

export function settingsSessionOwner(request: Request): string {
  assertLocalRequest(request);
  const cookie = cookieToken(request);
  const token = request.headers.get("x-orbitcode-settings-token");
  if (!cookie || !token || !equal(cookie, token) || (sessions.get(cookie) ?? 0) <= Date.now()) throw new LocalManagementError("session", "设置会话已失效，请刷新页面。");
  return cookie;
}

function cookieToken(request: Request): string | undefined {
  return request.headers.get("cookie")?.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
}

function equal(first: string, second: string): boolean {
  const a = Buffer.from(first);
  const b = Buffer.from(second);
  return a.length === b.length && timingSafeEqual(a, b);
}
