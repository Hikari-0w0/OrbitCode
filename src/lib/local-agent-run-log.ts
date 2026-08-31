import { createReadStream } from "node:fs";
import { appendFile, chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import type { AgentMode, AgentStopReason } from "@/core/agent-events";
import type { ModelRequestStage } from "@/models/provider";
import type { SideEffectState } from "@/tools/types";

export const DEFAULT_AGENT_RUN_LOG_DIRECTORY = path.join(
  homedir(),
  ".orbitcode",
  "logs",
);

export type AgentRunLogEntry = {
  readonly runId: string;
  readonly source: "web";
  readonly conversationId: string;
  readonly revisionBefore: number;
  readonly persistence:
    | { readonly status: "saved"; readonly revisionAfter: number }
    | { readonly status: "failed" }
    | { readonly status: "not-attempted" };
  readonly providerId: string;
  readonly workspaceId: string;
  readonly mode: AgentMode;
  readonly modeTurn: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly firstModelOutputMs?: number;
  readonly stopReason: AgentStopReason;
  readonly iterations: number;
  readonly sideEffect: SideEffectState;
  readonly inputChars: number;
  readonly outputChars: number;
  readonly usage:
    | {
        readonly availability: "reported";
        readonly promptTokens: number;
        readonly completionTokens: number;
        readonly totalTokens: number;
      }
    | { readonly availability: "unavailable" };
  readonly modelAttempts?: readonly AgentModelAttemptLog[];
  readonly tools: readonly {
    readonly name: string;
    readonly status:
      | "succeeded"
      | "failed"
      | "timed-out"
      | "cancelled"
      | "unfinished";
    readonly durationMs?: number;
    readonly errorKind?: string;
    readonly authorization?: {
      readonly status:
        | "awaiting"
        | "allowed"
        | "denied"
        | "expired"
        | "cancelled"
        | "invalid";
      readonly waitMs: number;
    };
  }[];
};

export type AgentModelAttemptLog = {
  readonly iteration: number;
  readonly attempt: number;
  readonly stage: ModelRequestStage;
  readonly elapsedMs: number;
  readonly traceId?: string;
  readonly toolName?: string;
  readonly toolArgumentsChars?: number;
};

export interface AgentRunLogSink {
  append(entry: AgentRunLogEntry): Promise<void>;
}

export type StoredAgentRunLogEntry = AgentRunLogEntry & {
  readonly schemaVersion: 3 | 4;
};

export class AgentRunLogError extends Error {
  constructor(
    readonly kind: "not-found" | "invalid-data" | "storage",
    message: string,
  ) {
    super(message);
    this.name = "AgentRunLogError";
  }
}

export class LocalAgentRunLog implements AgentRunLogSink {
  readonly #filePath: string;
  #pending: Promise<void> = Promise.resolve();

  constructor(directory = DEFAULT_AGENT_RUN_LOG_DIRECTORY) {
    this.#filePath = path.join(directory, "agent-runs.jsonl");
  }

  append(entry: AgentRunLogEntry): Promise<void> {
    const stored = toStoredEntry(entry);
    const operation = this.#pending.then(async () => {
      const directory = path.dirname(this.#filePath);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await appendFile(this.#filePath, `${JSON.stringify(stored)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await chmod(this.#filePath, 0o600);
    });
    this.#pending = operation.catch(() => undefined);
    return operation;
  }

  async find(runId: string): Promise<StoredAgentRunLogEntry> {
    validateRunId(runId);
    const matches: StoredAgentRunLogEntry[] = [];
    for await (const entry of this.readEntries()) {
      if (entry.runId === runId) matches.push(entry);
    }
    if (matches.length === 0) {
      throw new AgentRunLogError("not-found", `未找到运行记录：${runId}`);
    }
    if (matches.length > 1) {
      throw new AgentRunLogError("invalid-data", `运行 ID 重复，无法安全导出：${runId}`);
    }
    return matches[0];
  }

  async findAllForConversation(
    conversationId: string,
  ): Promise<readonly StoredAgentRunLogEntry[]> {
    validateConversationLogId(conversationId);
    const matches: StoredAgentRunLogEntry[] = [];
    try {
      for await (const entry of this.readEntries()) {
        if (entry.conversationId === conversationId) matches.push(entry);
      }
    } catch (error) {
      if (error instanceof AgentRunLogError && error.kind === "not-found") return [];
      throw error;
    }
    return matches;
  }

  private async *readEntries(): AsyncGenerator<StoredAgentRunLogEntry> {
    let lines;
    try {
      lines = createInterface({
        input: createReadStream(this.#filePath, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        if (line.trim().length === 0) continue;
        let value: unknown;
        try {
          value = JSON.parse(line) as unknown;
        } catch {
          throw new AgentRunLogError("invalid-data", "本地运行日志包含无效 JSON。");
        }
        if (
          !isRecord(value) ||
          (value.schemaVersion !== 3 && value.schemaVersion !== 4)
        ) continue;
        yield parseStoredEntry(value);
      }
    } catch (error) {
      if (error instanceof AgentRunLogError) throw error;
      if (isNodeError(error, "ENOENT")) {
        throw new AgentRunLogError("not-found", "尚无可导出的 Agent 运行日志。");
      }
      throw new AgentRunLogError("storage", "无法读取本地 Agent 运行日志。");
    } finally {
      lines?.close();
    }
  }
}

function toStoredEntry(entry: AgentRunLogEntry): StoredAgentRunLogEntry {
  return {
    schemaVersion: 4,
    runId: entry.runId,
    source: entry.source,
    conversationId: entry.conversationId,
    revisionBefore: entry.revisionBefore,
    persistence: entry.persistence.status === "saved"
      ? { status: "saved", revisionAfter: entry.persistence.revisionAfter }
      : { status: entry.persistence.status },
    providerId: entry.providerId,
    workspaceId: entry.workspaceId,
    mode: entry.mode,
    modeTurn: entry.modeTurn,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    durationMs: entry.durationMs,
    ...(entry.firstModelOutputMs === undefined
      ? {}
      : { firstModelOutputMs: entry.firstModelOutputMs }),
    stopReason: entry.stopReason,
    iterations: entry.iterations,
    sideEffect: entry.sideEffect,
    inputChars: entry.inputChars,
    outputChars: entry.outputChars,
    usage: entry.usage.availability === "reported"
      ? {
          availability: "reported",
          promptTokens: entry.usage.promptTokens,
          completionTokens: entry.usage.completionTokens,
          totalTokens: entry.usage.totalTokens,
        }
      : { availability: "unavailable" },
    modelAttempts: (entry.modelAttempts ?? []).map((attempt) => ({
      iteration: attempt.iteration,
      attempt: attempt.attempt,
      stage: attempt.stage,
      elapsedMs: attempt.elapsedMs,
      ...(attempt.traceId === undefined ? {} : { traceId: attempt.traceId }),
      ...(attempt.toolName === undefined ? {} : { toolName: attempt.toolName }),
      ...(attempt.toolArgumentsChars === undefined
        ? {}
        : { toolArgumentsChars: attempt.toolArgumentsChars }),
    })),
    tools: entry.tools.map((tool) => ({
      name: tool.name,
      status: tool.status,
      ...(tool.durationMs === undefined ? {} : { durationMs: tool.durationMs }),
      ...(tool.errorKind === undefined ? {} : { errorKind: tool.errorKind }),
      ...(tool.authorization === undefined
        ? {}
        : { authorization: { ...tool.authorization } }),
    })),
  };
}

function parseStoredEntry(value: unknown): StoredAgentRunLogEntry {
  if (
    !isRecord(value) ||
    (value.schemaVersion !== 3 && value.schemaVersion !== 4)
  ) {
    throw invalidRunLog();
  }
  const requiredCommon = [
    "schemaVersion", "runId", "source", "providerId",
    "workspaceId", "mode", "modeTurn", "startedAt", "finishedAt", "durationMs",
    "stopReason", "iterations", "sideEffect", "inputChars", "outputChars", "usage", "tools",
  ];
  const optionalCommon = [
    "firstModelOutputMs",
    ...(value.schemaVersion === 3 ? ["modelAttempts"] : []),
  ];
  const versionFields = ["conversationId", "revisionBefore", "persistence"];
  if (
    !hasAllowedFields(
      value,
      [
        ...requiredCommon,
        ...versionFields,
        ...(value.schemaVersion === 4 ? ["modelAttempts"] : []),
      ],
      optionalCommon,
    ) ||
    typeof value.runId !== "string" ||
    value.source !== "web" ||
    typeof value.conversationId !== "string" ||
    typeof value.providerId !== "string" ||
    typeof value.workspaceId !== "string" ||
    (value.mode !== "plan" && value.mode !== "do") ||
    !isNonNegativeInteger(value.modeTurn) ||
    typeof value.startedAt !== "string" ||
    typeof value.finishedAt !== "string" ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    !Number.isFinite(Date.parse(value.finishedAt)) ||
    !isNonNegativeInteger(value.durationMs) ||
    (value.firstModelOutputMs !== undefined && !isNonNegativeInteger(value.firstModelOutputMs)) ||
    typeof value.stopReason !== "string" ||
    !isNonNegativeInteger(value.iterations) ||
    !["none", "possible", "applied"].includes(String(value.sideEffect)) ||
    !isNonNegativeInteger(value.inputChars) ||
    !isNonNegativeInteger(value.outputChars) ||
    !isUsage(value.usage) ||
    (value.modelAttempts !== undefined &&
      (!Array.isArray(value.modelAttempts) ||
        !value.modelAttempts.every(isModelAttemptLog))) ||
    !Array.isArray(value.tools) ||
    !value.tools.every(isToolLog)
  ) throw invalidRunLog();
  validateRunId(value.runId);
  if (
    value.conversationId.length === 0 ||
    !isNonNegativeInteger(value.revisionBefore) ||
    !isPersistence(value.persistence)
  ) {
    throw invalidRunLog();
  }
  return value as StoredAgentRunLogEntry;
}

function validateRunId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new AgentRunLogError("invalid-data", "运行 ID 无效。");
  }
  return value;
}

function validateConversationLogId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new AgentRunLogError("invalid-data", "会话 ID 无效。");
  }
  return value;
}

function isUsage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.availability === "unavailable") {
    return Object.keys(value).length === 1;
  }
  return value.availability === "reported" &&
    hasAllowedFields(
      value,
      ["availability", "promptTokens", "completionTokens", "totalTokens"],
      [],
    ) &&
    isNonNegativeInteger(value.promptTokens) &&
    isNonNegativeInteger(value.completionTokens) &&
    isNonNegativeInteger(value.totalTokens);
}

function isToolLog(value: unknown): boolean {
  return isRecord(value) &&
    hasAllowedFields(
      value,
      ["name", "status"],
      ["durationMs", "errorKind", "authorization"],
    ) &&
    typeof value.name === "string" &&
    ["succeeded", "failed", "timed-out", "cancelled", "unfinished"].includes(String(value.status)) &&
    (value.durationMs === undefined || isNonNegativeInteger(value.durationMs)) &&
    (value.errorKind === undefined || typeof value.errorKind === "string") &&
    (value.authorization === undefined || isAuthorizationLog(value.authorization));
}

function isAuthorizationLog(value: unknown): boolean {
  return isRecord(value) &&
    hasAllowedFields(value, ["status", "waitMs"], []) &&
    ["awaiting", "allowed", "denied", "expired", "cancelled", "invalid"].includes(
      String(value.status),
    ) &&
    isNonNegativeInteger(value.waitMs);
}

function isModelAttemptLog(value: unknown): boolean {
  return isRecord(value) &&
    hasAllowedFields(
      value,
      ["iteration", "attempt", "stage", "elapsedMs"],
      ["traceId", "toolName", "toolArgumentsChars"],
    ) &&
    isNonNegativeInteger(value.iteration) &&
    isNonNegativeInteger(value.attempt) &&
    value.iteration > 0 &&
    value.attempt > 0 &&
    [
      "waiting-first-byte",
      "streaming-text",
      "streaming-tool-arguments",
      "waiting-done",
    ].includes(String(value.stage)) &&
    isNonNegativeInteger(value.elapsedMs) &&
    (value.traceId === undefined ||
      (typeof value.traceId === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value.traceId))) &&
    (value.toolName === undefined ||
      (typeof value.toolName === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value.toolName))) &&
    (value.toolArgumentsChars === undefined ||
      isNonNegativeInteger(value.toolArgumentsChars));
}

function isPersistence(value: unknown): boolean {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  if (value.status === "saved") {
    return hasAllowedFields(value, ["status", "revisionAfter"], []) &&
      isNonNegativeInteger(value.revisionAfter);
  }
  return (value.status === "failed" || value.status === "not-attempted") &&
    hasAllowedFields(value, ["status"], []);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasAllowedFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((field) => field in value) &&
    Object.keys(value).every((field) => allowed.has(field));
}

function invalidRunLog(): AgentRunLogError {
  return new AgentRunLogError("invalid-data", "本地运行日志数据损坏或版本不受支持。");
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
