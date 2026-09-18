import assert from "node:assert/strict";
import test from "node:test";
import { runtimeFixture } from "./helpers/runtime-fixture";
import { textDelta, DONE_EVENT } from "./helpers/openai-mock";
import { streamAgentResponse } from "@/web/chat-handler";
import { parseWebChatEvents, readWebStream } from "@/web/chat-contract";

test("Web 与 CLI 通过相同运行时顺序继续同一磁盘会话", async () => {
  const fixture = await runtimeFixture(() => ({ chunks: [{ data: textDelta("同一会话") + DONE_EVENT }] }));
  const session = fixture.permissions.createSession();
  try {
    const first = await fixture.checkpoint();
    const prepared = await fixture.runtime.prepare({ conversationId: first.summary.id, expectedRevision: 0,
      input: "来自 Web", mode: "do", modeTurn: 1, permissionSessionId: session.id,
      source: "web", signal: new AbortController().signal });
    const response = streamAgentResponse({ ...prepared, request: new Request("http://localhost/api/chat") });
    assert.ok(response.body);
    const events = [];
    for await (const event of parseWebChatEvents(readWebStream(response.body))) events.push(event);
    assert.equal(events.at(-1)?.type, "stopped");
    await fixture.controller.handleLine(`/resume ${first.summary.id}`);
    await fixture.controller.handleLine("来自 CLI");
    const saved = await fixture.store.load(first.summary.id);
    assert.equal(saved.summary.revision, 2);
    assert.equal(saved.displayMessages.length, 4);
    assert.match(JSON.stringify(fixture.server.requests[1].body), /来自 Web/);
    const runs = await fixture.log.findAllForConversation(first.summary.id);
    assert.deepEqual(runs.map((run) => run.source).sort(), ["cli", "web"]);
    assert.equal(fixture.errors(), "");
  } finally { fixture.permissions.closeSession(session.id); await fixture.close(); }
});
