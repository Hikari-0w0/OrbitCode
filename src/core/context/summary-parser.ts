import { ContextManagementError } from "@/core/context/context-errors";
import type { ContextSummary } from "@/core/context/types";

const ENVELOPE_FIELDS = new Set(["analysisDraft", "summary"]);
const SUMMARY_FIELDS = [
  "taskGoals",
  "completedWork",
  "keyDecisions",
  "fileChanges",
  "toolResults",
  "errors",
  "nextSteps",
] as const;
const MAX_DRAFT_LENGTH = 20_000;
const MAX_SUMMARY_ITEMS = 64;
const MAX_SUMMARY_ITEM_LENGTH = 2_000;

export function parseSummaryEnvelope(source: string): ContextSummary {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw formatError("摘要模型返回了无效 JSON。", error);
  }
  if (!isRecord(value) || !hasExactKeys(value, ENVELOPE_FIELDS)) {
    throw formatError("摘要响应必须只包含 analysisDraft 和 summary。");
  }
  if (
    typeof value.analysisDraft !== "string" ||
    value.analysisDraft.length === 0 ||
    value.analysisDraft.length > MAX_DRAFT_LENGTH
  ) {
    throw formatError("摘要分析草稿无效。");
  }
  if (!isRecord(value.summary)) {
    throw formatError("正式摘要结构无效。");
  }
  const summaryKeys = new Set<string>(SUMMARY_FIELDS);
  if (!hasExactKeys(value.summary, summaryKeys)) {
    throw formatError("正式摘要必须包含固定的七个章节。");
  }

  const summary: Record<(typeof SUMMARY_FIELDS)[number], readonly string[]> = {
    taskGoals: [],
    completedWork: [],
    keyDecisions: [],
    fileChanges: [],
    toolResults: [],
    errors: [],
    nextSteps: [],
  };
  for (const field of SUMMARY_FIELDS) {
    summary[field] = parseEntries(value.summary[field], field);
  }
  return summary;
}

function parseEntries(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_SUMMARY_ITEMS) {
    throw formatError(`正式摘要章节 ${field} 必须是有界数组。`);
  }
  return value.map((entry) => {
    if (
      typeof entry !== "string" ||
      entry.trim().length === 0 ||
      entry.length > MAX_SUMMARY_ITEM_LENGTH
    ) {
      throw formatError(`正式摘要章节 ${field} 包含无效条目。`);
    }
    return entry;
  });
}

function formatError(message: string, cause?: unknown): ContextManagementError {
  return new ContextManagementError("summary-format", message, {
    cause,
    summaryFailure: true,
  });
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
