import assert from "node:assert/strict";
import test from "node:test";
import { PATCH } from "@/app/api/settings/route";
import { openSettingsSession } from "@/web/local-management-guard";

function mutation(body: unknown): Request {
  const headers = openSettingsSession(new Request("http://localhost:3000/api/settings", { headers: { host: "localhost:3000" } }));
  const cookie = headers.get("set-cookie")?.split(";")[0] ?? "";
  return new Request("http://localhost:3000/api/settings", { method: "PATCH", headers: {
    host: "localhost:3000", origin: "http://localhost:3000", cookie, "content-type": "application/json",
    "x-orbitcode-settings-token": headers.get("x-orbitcode-settings-token") ?? "",
  }, body: JSON.stringify(body) });
}

test("设置契约拒绝未知字段和错误类型，不把错误值当作保留动作", async () => {
  for (const action of [
    { type: "provider-edit", id: "example", model: 42 },
    { type: "provider-edit", id: "example", maxOutputTokens: "32768" },
    { type: "provider-edit", id: "example", thinking: { enabled: "true" } },
    { type: "provider-edit", id: "example", thinking: { enabled: true, unexpected: true } },
    { type: "provider-edit", id: "example", unexpected: "synthetic-marker" },
    { type: "provider-edit", id: "example", credential: { kind: "none", value: "synthetic-marker" } },
    { type: "mcp-upsert", name: "demo", scope: "user", config: { type: "http", url: "https://example.invalid", headers: {}, unexpected: true } },
  ]) {
    const response = await PATCH(mutation({ expectedRevision: 0, action }));
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /synthetic-marker/);
  }
});

test("设置契约在解析前限制请求体大小", async () => {
  const response = await PATCH(mutation({ large: "x".repeat(256 * 1024) }));
  assert.equal(response.status, 413);
});

test("探测、MCP、导入和恢复接口拒绝未知字段及超大请求", async () => {
  const routes = await Promise.all([
    import("@/app/api/settings/probe/route"), import("@/app/api/settings/mcp/route"),
    import("@/app/api/settings/import/route"), import("@/app/api/settings/recovery/route"),
  ]);
  for (const route of routes) {
    const unknown = await route.POST(mutation({ unexpected: "synthetic-marker" }));
    assert.equal(unknown.status, 400);
    assert.doesNotMatch(await unknown.text(), /synthetic-marker/);
    const large = await route.POST(mutation({ unexpected: "x".repeat(16 * 1024) }));
    assert.equal(large.status, 413);
  }
});
