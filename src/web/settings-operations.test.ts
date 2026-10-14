import assert from "node:assert/strict";
import test from "node:test";
import { SettingsOperations, settingsOperations, type SettingsOperationEvent } from "@/web/settings-operations";
import { GET, DELETE } from "@/app/api/settings/operations/[operationId]/route";
import { openSettingsSession } from "@/web/local-management-guard";

function session() {
  const opened = openSettingsSession(new Request("http://localhost:3000/api/settings", { headers: { host: "localhost:3000" } }));
  const token = opened.get("x-orbitcode-settings-token") ?? "";
  const cookie = opened.get("set-cookie")?.split(";")[0] ?? "";
  return { token, request: (method: string) => new Request("http://localhost:3000/api/settings/operations/id", {
    method, headers: { host: "localhost:3000", origin: "http://localhost:3000", cookie, "x-orbitcode-settings-token": token },
  }) };
}

test("管理操作先订阅后执行，终态唯一且取消不会覆盖已完成结果", async () => {
  const operations = new SettingsOperations();
  let calls = 0;
  const id = operations.start("owner", async () => { calls++; return Response.json({ status: "succeeded", detail: "完成" }); });
  assert.equal(calls, 0);
  const events: SettingsOperationEvent[] = [];
  await new Promise<void>((resolve) => operations.subscribe("owner", id, (event) => { events.push(event); if (event.type === "finished") resolve(); }));
  assert.equal(calls, 1);
  assert.deepEqual(events.map((event) => event.type), ["started", "finished"]);
  assert.equal(operations.cancel("other-owner", id), false);
  assert.equal(operations.cancel("owner", id), true);
  const replay: SettingsOperationEvent[] = [];
  operations.subscribe("owner", id, (event) => replay.push(event));
  assert.equal(replay.length, 1);
  assert.equal(replay[0].type === "finished" && replay[0].httpStatus, 200);
});

test("最后一个订阅者断开会取消外部等待，迟到的成功不会复活操作", async () => {
  const operations = new SettingsOperations();
  let aborted = false;
  const id = operations.start("owner", async (signal) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
    return Response.json({ status: "succeeded" });
  });
  const events: SettingsOperationEvent[] = [];
  const unsubscribe = operations.subscribe("owner", id, (event) => events.push(event));
  unsubscribe();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(aborted, true);
  const terminal: SettingsOperationEvent[] = [];
  operations.subscribe("owner", id, (event) => terminal.push(event));
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].type === "finished" && terminal[0].httpStatus, 499);
});

test("不同管理会话不能订阅或取消其他 operationId，合法 SSE 包含唯一终态", async () => {
  const first = session(), second = session();
  assert.notEqual(first.token, second.token);
  const id = settingsOperations.start(first.token, async () => Response.json({ status: "succeeded" }));
  const context = { params: Promise.resolve({ operationId: id }) };
  assert.equal((await GET(second.request("GET"), context)).status, 404);
  assert.equal((await DELETE(second.request("DELETE"), context)).status, 404);
  const response = await GET(first.request("GET"), context);
  assert.equal(response.status, 200);
  const source = await response.text();
  const events = source.trim().split("\n\n").map((line) => JSON.parse(line.slice(6)));
  assert.deepEqual(events.map((event) => event.type), ["started", "finished"]);
  assert.equal((await DELETE(first.request("DELETE"), context)).status, 204);
});
