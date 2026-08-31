import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LocalAgentRunLog,
  type AgentRunLogEntry,
} from "@/lib/local-agent-run-log";

test("本地运行日志以脱敏 JSONL 串行追加并收紧文件权限", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "orbitcode-run-log-"));
  const logger = new LocalAgentRunLog(directory);
  const base: AgentRunLogEntry = {
    runId: "run-1",
    source: "web",
    conversationId: "conversation-1",
    revisionBefore: 4,
    persistence: { status: "saved", revisionAfter: 5 },
    providerId: "deepseek",
    workspaceId: "project",
    mode: "do",
    modeTurn: 2,
    startedAt: "2026-08-30T01:00:00.000Z",
    finishedAt: "2026-08-30T01:00:01.250Z",
    durationMs: 1_250,
    firstModelOutputMs: 300,
    stopReason: "final-response",
    iterations: 2,
    sideEffect: "none",
    inputChars: 12,
    outputChars: 4,
    usage: {
      availability: "reported",
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
    },
    modelAttempts: [{
      iteration: 1,
      attempt: 1,
      stage: "streaming-tool-arguments",
      elapsedMs: 240,
      traceId: "trace-1",
      toolName: "read_file",
      toolArgumentsChars: 20,
    }],
    tools: [{
      name: "read_file",
      status: "succeeded",
      durationMs: 8,
      authorization: { status: "allowed", waitMs: 420 },
    }],
  };

  try {
    await Promise.all([
      logger.append({ ...base, runId: "run-1" }),
      logger.append({
        ...base,
        runId: "run-2",
        input: "不得落盘的用户原文",
        apiKey: "不得落盘的密钥",
      } as AgentRunLogEntry & { readonly input: string; readonly apiKey: string }),
    ]);

    const filePath = path.join(directory, "agent-runs.jsonl");
    const lines = (await readFile(filePath, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(entries.map((entry) => entry.runId), ["run-1", "run-2"]);
    assert.ok(entries.every((entry) => entry.schemaVersion === 4));
    assert.equal(
      JSON.stringify(entries[0].modelAttempts).includes("README"),
      false,
    );
    assert.equal((await logger.find("run-2")).runId, "run-2");
    assert.deepEqual((await logger.find("run-1")).tools[0]?.authorization, {
      status: "allowed",
      waitMs: 420,
    });
    const legacy: Record<string, unknown> = {
      ...entries[0],
      schemaVersion: 3,
      runId: "run-legacy",
    };
    delete legacy.modelAttempts;
    await appendFile(filePath, `${JSON.stringify(legacy)}\n`);
    await appendFile(filePath, `${JSON.stringify({ schemaVersion: 1, runId: "legacy" })}\n`);
    assert.deepEqual(
      (await logger.findAllForConversation("conversation-1")).map((entry) => entry.runId),
      ["run-1", "run-2", "run-legacy"],
    );
    assert.equal(JSON.stringify(entries).includes("不得落盘"), false);
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
