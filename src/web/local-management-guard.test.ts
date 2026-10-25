import assert from "node:assert/strict";
import test from "node:test";

import { assertLocalRequest, assertSettingsMutation, LocalManagementError, openSettingsSession } from "@/web/local-management-guard";

function request(headers: Record<string, string> = {}, url = "http://localhost:3107/api/settings"): Request {
  return new Request(url, { method: "PATCH", headers: { host: "localhost:3107", ...headers } });
}

test("设置修改要求本机 Host、同源 Origin 与会话令牌", () => {
  const opened = openSettingsSession(request());
  const token = opened.get("x-orbitcode-settings-token");
  assert.ok(token);
  const cookie = opened.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const authorized = request({ origin: "http://localhost:3107", cookie, "x-orbitcode-settings-token": token });
  assert.doesNotThrow(() => assertSettingsMutation(authorized));
  assert.throws(() => assertSettingsMutation(request({ origin: "http://evil.test", cookie, "x-orbitcode-settings-token": token })),
    (error) => error instanceof LocalManagementError && error.code === "forbidden");
  assert.throws(() => assertSettingsMutation(request({ origin: "http://localhost:3107", cookie })),
    (error) => error instanceof LocalManagementError && error.code === "session");
  assert.throws(() => assertLocalRequest(request({ host: "evil.test" })),
    (error) => error instanceof LocalManagementError && error.code === "forbidden");
  assert.throws(() => assertLocalRequest(request({ "x-forwarded-host": "evil.test" })),
    (error) => error instanceof LocalManagementError && error.code === "forbidden");
});

test("同名旧 Cookie 不遮蔽与请求头匹配的有效管理会话", () => {
  const opened = openSettingsSession(request());
  const token = opened.get("x-orbitcode-settings-token");
  assert.ok(token);
  const cookie = `orbitcode_settings_session=obsolete; orbitcode_settings_session=${token}`;
  assert.doesNotThrow(() => assertSettingsMutation(request({
    origin: "http://localhost:3107", cookie, "x-orbitcode-settings-token": token,
  })));
  const refreshed = openSettingsSession(request({ cookie }));
  assert.equal(refreshed.get("x-orbitcode-settings-token"), token);
  for (const [cookies, header] of [[cookie, "obsolete"], ["orbitcode_settings_session=obsolete", token]]) {
    assert.throws(() => assertSettingsMutation(request({
      origin: "http://localhost:3107", cookie: cookies, "x-orbitcode-settings-token": header,
    })), (error) => error instanceof LocalManagementError && error.code === "session");
  }
});
