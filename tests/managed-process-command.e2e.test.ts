import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture";
import { DONE_EVENT, textDelta, toolCallDelta, TOOL_FINISH_EVENT, TRANSPORT_DONE_EVENT } from "./helpers/openai-mock";

test("Web/CLI 受管服务运行期间可执行 HTTP 验证，结束后回收服务", async () => {
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  let requests = 0;
  const fixture = await runtimeFixture(request => {
    assert.ok(typeof request.body === "object" && request.body !== null && "tool_choice" in request.body);
    if (request.body.tool_choice === "none") return { chunks: [{ data: textDelta("[]") + DONE_EVENT }] };
    const step = requests++ % 3;
    if (step === 2) return { chunks: [{ data: textDelta("HTTP 验证完成") + DONE_EVENT }] };
    const tool = step === 0
      ? { name: "start_process", argumentsJson: JSON.stringify({ command: `node -e 'require("node:http").createServer((req,res)=>res.end("SERVICE_OK")).listen(${port},"127.0.0.1")'`, ready_port: port }) }
      : { name: "run_command", argumentsJson: JSON.stringify({ command: `node -e 'fetch("http://127.0.0.1:${port}").then(r=>r.text()).then(t=>{if(t!=="SERVICE_OK")process.exit(1);console.log(t)})'`, timeout_ms: 2000 }) };
    return { chunks: [{ data: toolCallDelta({ id: `process-test-${requests}`, ...tool }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT }] };
  });
  try {
    for (const source of ["web", "cli"] as const) {
      requests = 0;
      const checkpoint = await fixture.conversations.create({ workspaceId: "default", providerId: "primary" });
      const session = fixture.permissions.createSession();
      try {
        for await (const event of fixture.runtime.streamTurn({ conversationId: checkpoint.summary.id, expectedRevision: 0,
          permissionSessionId: session.id, input: "启动服务并执行 HTTP 验证", mode: "do", modeTurn: 1, source, signal: AbortSignal.timeout(8000) })) {
          if (event.type === "agent" && event.event.type === "tool-result") {
            assert.equal(event.event.result.ok, true, JSON.stringify(event.event.result));
          }
          if (event.type === "finished") assert.equal(event.stopped.reason, "final-response");
        }
        const saved = await fixture.conversations.load(checkpoint.summary.id);
        assert.match(JSON.stringify(saved), /SERVICE_OK/);
        await assert.rejects(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) }));
      } finally { fixture.permissions.closeSession(session.id); }
    }
  } finally { await fixture.close(); }
});
