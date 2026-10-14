import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SettingsService } from "@/runtime/settings-service";
import { LocalSettingsStore } from "@/lib/local-settings-store";
import { DONE_EVENT, startOpenAIMockServer, textDelta } from "./helpers/openai-mock";
import type { McpServerConfig } from "@/runtime/mcp-config";
import { configureMcpFixture } from "./helpers/mcp-fixture";

test("设置 API 整链路覆盖私密投影、冲突、模型探测与两种 MCP 显式连接重连", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-settings-api-"));
  const dataDir = path.join(root, "data");
  const previous = process.env.ORBITCODE_DATA_DIR;
  process.env.ORBITCODE_DATA_DIR = dataDir;
  const model = await startOpenAIMockServer((request) => request.authorization === "Bearer synthetic-valid-key"
    ? { chunks: [{ data: textDelta("OK") + DONE_EVENT }] }
    : { status: 401, chunks: [{ data: '{"error":{"message":"synthetic-private-error"}}' }] });
  const http = await configureMcpFixture(root, "http");
  const stdio = await configureMcpFixture(root, "stdio");
  const routes = await import("@/app/api/settings/route");
  const probe = await import("@/app/api/settings/probe/route");
  const mcp = await import("@/app/api/settings/mcp/route");
  const { webMcpHost } = await import("@/runtime/mcp-host");
  try {
    const response = await routes.GET(new Request("http://localhost:3000/api/settings", { headers: { host: "localhost:3000" } }));
    const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    const token = response.headers.get("x-orbitcode-settings-token") ?? "";
    const request = (body: unknown, signal?: AbortSignal) => new Request("http://localhost:3000/api/settings", {
      method: "POST", headers: { host: "localhost:3000", origin: "http://localhost:3000", cookie,
        "content-type": "application/json", "x-orbitcode-settings-token": token }, body: JSON.stringify(body), signal });
    const service = new SettingsService(new LocalSettingsStore(dataDir));
    const added = await service.apply(0, { type: "provider-add", displayName: "模型", model: "mock-model", baseUrl: model.baseUrl,
      windowTokens: 128000, credential: { kind: "local", value: "synthetic-valid-key" } });
    const id = added.providers[0].id;
    const workspace = await service.apply(1, { type: "workspace-add", name: "工作区", rootPath: root });
    const workspaceId = workspace.workspaces[0].id;
    assert.equal((await routes.PATCH(request({ expectedRevision: 0, action: { type: "provider-edit", id, displayName: "冲突" } }))).status, 409);
    const valid = await probe.POST(request({ providerId: id, expectedRevision: 2 }));
    assert.equal(valid.status, 200);
    assert.equal((await valid.json()).status, "succeeded");
    assert.equal(model.requests.length, 1);
    const requestBody = model.requests[0].body;
    assert.ok(typeof requestBody === "object" && requestBody !== null && !("tools" in requestBody));
    assert.doesNotMatch(JSON.stringify(requestBody), /synthetic-valid-key|synthetic-invalid-key/);
    await service.apply(2, { type: "provider-edit", id, credential: { kind: "local", value: "synthetic-invalid-key" } });
    const invalid = await probe.POST(request({ providerId: id, expectedRevision: 3 }));
    assert.equal(invalid.status, 502);
    assert.doesNotMatch(await invalid.text(), /synthetic-private-error|synthetic-invalid-key/);
    assert.ok(http.httpUrl);
    const configs: readonly McpServerConfig[] = [{ type: "http", url: http.httpUrl, headers: {} },
      { type: "stdio", command: process.execPath, args: [path.resolve("tests/fixtures/mcp/stdio-server.mjs")],
        env: { MCP_MARKER: stdio.marker, MCP_CALL_LOG: stdio.callLog } }];
      for (const [index, config] of configs.entries()) {
        const name = `fixture${index}`;
        const revision = (await service.load())!.revision;
        await service.apply(revision, { type: "mcp-upsert", name, scope: "workspace", workspaceId, config });
        if (index === 0) assert.equal(http.methods.length, 0);
        else await assert.rejects(readFile(stdio.marker));
        const expectedRevision = revision + 1;
        for (const action of ["connect", "disconnect", "connect", "disconnect"]) {
          const managed = await mcp.POST(request({ action, serverName: name, workspaceId, expectedRevision }));
          assert.equal(managed.status, 200, await managed.clone().text());
          const value = await managed.json();
          if (action === "connect") assert.deepEqual(value.tools, ["echo"]);
        }
      }
      const beforeDisable = (await service.load())!.revision;
      assert.equal((await mcp.POST(request({ action: "connect", serverName: "fixture1", workspaceId, expectedRevision: beforeDisable }))).status, 200);
      const pid = Number(await readFile(stdio.marker, "utf8"));
      assert.doesNotThrow(() => process.kill(pid, 0));
      const disabled = await routes.PATCH(request({ expectedRevision: beforeDisable, action: { type: "mcp-enable", name: "fixture1", scope: "workspace", workspaceId, enabled: false } }));
      assert.equal(disabled.status, 200, await disabled.clone().text());
      assert.throws(() => process.kill(pid, 0));
      assert.equal(http.methods.filter((method) => method === "initialize").length, 2);
      assert.equal(http.methods.filter((method) => method === "tools/call").length, 0);
      assert.doesNotMatch(await readFile(stdio.callLog, "utf8"), /tools\/call/);
      context.mock.method(webMcpHost(), "reconcile", async () => { throw new Error("synthetic-cleanup-error"); });
      const beforeWarning = (await service.load())!.revision;
      const warning = await routes.PATCH(request({ expectedRevision: beforeWarning, action: { type: "provider-edit", id, displayName: "保存仍成功" } }));
      assert.equal(warning.status, 200);
      const warningBody = await warning.json();
      assert.equal(warningBody.revision, beforeWarning + 1);
      assert.match(warningBody.warning, /设置已保存.*清理未完成/);
      assert.doesNotMatch(JSON.stringify(warningBody), /synthetic-cleanup-error|synthetic-invalid-key/);
      context.mock.restoreAll();
      const publicResponse = await routes.GET(new Request("http://localhost:3000/api/settings", { headers: { host: "localhost:3000" } }));
      assert.doesNotMatch(await publicResponse.text(), /synthetic-valid-key|synthetic-invalid-key/);
  } finally {
    context.mock.restoreAll();
    await webMcpHost().close(); await http.close(); await stdio.close(); await model.close();
    if (previous === undefined) delete process.env.ORBITCODE_DATA_DIR; else process.env.ORBITCODE_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
