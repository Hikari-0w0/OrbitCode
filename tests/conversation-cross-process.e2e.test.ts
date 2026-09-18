import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { LocalConversationStore } from "@/lib/local-conversation-store";
import { runtimeFixture, waitUntil } from "./helpers/runtime-fixture";
import { DONE_EVENT } from "./helpers/openai-mock";

test("独立进程写租约拒绝另一入口，强杀后只恢复完整磁盘证据", async () => {
  const fixture = await runtimeFixture(() => ({ chunks: [{ data: DONE_EVENT }] }));
  const c = await fixture.checkpoint();
  const root = path.join(fixture.root, ".conversations");
  const child = spawn(process.execPath, ["--import", "tsx", "tests/helpers/lease-process.ts", root, c.summary.id], { stdio: "pipe" });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    await waitUntil(() => output.includes("READY"));
    await assert.rejects(fixture.conversations.rename({ conversationId: c.summary.id, expectedRevision: 0, title: "争用" }));
    assert.equal((await fixture.store.load(c.summary.id)).summary.revision, 0);
    child.kill("SIGKILL"); await exited;
    const recoveredStore = new LocalConversationStore(root, () => new Date(Date.now() + 180_000));
    assert.equal((await recoveredStore.inspectActivity(c.summary.id)).status, "interrupted");
    const recovered = await recoveredStore.recoverInterruptedTurn(c.summary.id);
    assert.equal(recovered.summary.revision, 1);
    assert.match(JSON.stringify(recovered.displayMessages), /子进程中断请求/);
    assert.equal(fixture.server.requests.length, 0);
  } finally { if (child.exitCode === null) child.kill("SIGKILL"); await fixture.close(); }
});
