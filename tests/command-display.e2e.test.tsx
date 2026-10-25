import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolExecutionCard } from "@/components/tool-execution-card";
import { LocalConversationStore } from "@/lib/local-conversation-store";
import { createRunCommandTool } from "@/tools/run-command";
import { createWorkspaceBoundary } from "@/tools/workspace";

test("Basic Auth 原文仅交给沙箱，结果、会话恢复和页面均使用脱敏命令", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orbitcode-command-privacy-"));
  try {
    const workspace = await createWorkspaceBoundary(root);
    const store = new LocalConversationStore(path.join(root, "conversations"));
    for (const [index, command] of [
      "curl -u demo:SYNTHETIC_PASSWORD https://example.invalid",
      'curl --user="demo:SYNTHETIC PASSWORD" https://example.invalid',
      "curl -udemo:SYNTHETIC_PASSWORD https://example.invalid",
    ].entries()) {
      let executed = "";
      const tool = createRunCommandTool({
        async probe() { return { available: true }; },
        async run(input) {
          executed = input.command;
          return { stdout: "", stderr: "", exitCode: index === 1 ? 1 : 0, terminationSignal: null, timedOut: index === 2, cancelled: false, stdoutTruncated: false, stderrTruncated: false };
        },
      });
      const result = await tool.execute({ command }, { workspace, signal: new AbortController().signal, deadlineMs: Date.now() + 1000 });
      assert.equal(executed, command);
      assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC|PASSWORD/);
      const checkpoint = await store.create({ workspaceId: "test", providerId: "fixture" });
      const execution = { iteration: 1, sequence: 0, callId: "command", name: "run_command", argumentsJson: "{}", state: result.ok ? "succeeded" as const : "failed" as const, result };
      await store.save({ conversationId: checkpoint.summary.id, expectedRevision: 0, checkpoint: { ...checkpoint, displayMessages: [{ id: "answer", role: "assistant", content: "", state: "complete", toolExecutions: [execution] }] } });
      const restored = await store.load(checkpoint.summary.id);
      assert.doesNotMatch(JSON.stringify(restored.displayMessages), /SYNTHETIC|PASSWORD/);
      const savedExecution = restored.displayMessages[0].toolExecutions?.[0];
      assert.ok(savedExecution);
      const markup = renderToStaticMarkup(<ToolExecutionCard execution={savedExecution}/>);
      assert.match(markup, /curl/);
      assert.match(markup, /&lt;redacted&gt;/);
      assert.doesNotMatch(markup, /SYNTHETIC|PASSWORD/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
