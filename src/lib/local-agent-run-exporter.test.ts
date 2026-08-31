import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalAgentRunExporter } from "@/lib/local-agent-run-exporter";
import { LocalAgentRunLog } from "@/lib/local-agent-run-log";
import { LocalConversationExporter } from "@/lib/local-conversation-exporter";
import { LocalConversationStore } from "@/lib/local-conversation-store";

test("按 runId 导出精确的前后检查点和卸载上下文", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbitcode-run-export-"));
  const runLog = new LocalAgentRunLog(path.join(directory, "logs"));
  const conversations = new LocalConversationStore(
    path.join(directory, "conversations"),
    () => new Date("2026-08-30T02:00:00.000Z"),
  );
  const outputPath = path.join(directory, "run.json");

  try {
    const created = await conversations.create({
      workspaceId: "project",
      providerId: "deepseek",
    });
    const contextObject = await conversations.write({
      sessionId: created.summary.id,
      content: "完整工具输出",
      signal: new AbortController().signal,
    });
    const operationalObject = await conversations.write({
      sessionId: created.summary.id,
      content: "完整操作交换",
      signal: new AbortController().signal,
    });
    const saved = await conversations.save({
      conversationId: created.summary.id,
      expectedRevision: 0,
      checkpoint: {
        schemaVersion: 1,
        summary: {
          schemaVersion: 1,
          id: created.summary.id,
          title: "导出测试",
          createdAt: created.summary.createdAt,
          workspaceId: "project",
          providerId: "deepseek",
          lastStopReason: "final-response",
        },
        mode: "do",
        modeTurn: 1,
        displayMessages: [],
        context: {
          consecutiveSummaryFailures: 0,
          messages: [
            {
              kind: "assistant-tool-call",
              content: null,
              toolCalls: [{ id: "call-1", name: "read_file", argumentsJson: "{}" }],
            },
            {
              kind: "tool-result",
              toolCallId: "call-1",
              payload: {
                storage: "offloaded",
                reference: contextObject.reference,
                preview: "完整工具输出",
                originalBytes: contextObject.byteLength,
                estimatedTokens: 4,
              },
            },
            {
              kind: "boundary",
              content: [
                "<orbitcode_operational_compaction>",
                "tools: write_files",
                `reference: ${operationalObject.reference}`,
                "status: completed",
                "较早的完整工具交换已卸载。",
                "</orbitcode_operational_compaction>",
              ].join("\n"),
            },
          ],
        },
      },
    });
    assert.equal(saved.status, "saved");

    await runLog.append({
      runId: "run-export",
      source: "web",
      conversationId: created.summary.id,
      revisionBefore: 0,
      persistence: { status: "saved", revisionAfter: 1 },
      providerId: "deepseek",
      workspaceId: "project",
      mode: "do",
      modeTurn: 1,
      startedAt: "2026-08-30T01:00:00.000Z",
      finishedAt: "2026-08-30T01:00:01.000Z",
      durationMs: 1_000,
      stopReason: "final-response",
      iterations: 1,
      sideEffect: "none",
      inputChars: 2,
      outputChars: 2,
      usage: { availability: "unavailable" },
      tools: [{ name: "read_file", status: "succeeded", durationMs: 5 }],
    });

    const result = await new LocalAgentRunExporter(
      runLog,
      conversations,
      () => new Date("2026-08-30T03:00:00.000Z"),
    ).exportRun({ runId: "run-export", outputPath });

    assert.equal(result.checkpoints.before.status, "included");
    assert.equal(result.checkpoints.after.status, "included");
    assert.deepEqual(result.context.objects, [
      {
        reference: contextObject.reference,
        status: "included",
        byteLength: contextObject.byteLength,
        content: "完整工具输出",
      },
      {
        reference: operationalObject.reference,
        status: "included",
        byteLength: operationalObject.byteLength,
        content: "完整操作交换",
      },
    ]);
    assert.equal(result.containsSensitiveContent, true);
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
    const disk = JSON.parse(await readFile(outputPath, "utf8")) as {
      readonly run: { readonly runId: string };
    };
    assert.equal(disk.run.runId, "run-export");

    const conversationExport = await new LocalConversationExporter(
      runLog,
      conversations,
      () => new Date("2026-08-30T03:00:00.000Z"),
    ).createExport(created.summary.id);
    assert.equal(conversationExport.format, "orbitcode-conversation");
    assert.deepEqual(
      conversationExport.revisions.map((checkpoint) => checkpoint.summary.revision),
      [0, 1],
    );
    assert.deepEqual(conversationExport.runs.map((run) => run.runId), ["run-export"]);
    assert.equal(conversationExport.context.objects.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
