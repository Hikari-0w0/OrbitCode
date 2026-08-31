import type { ConversationDetailResponse } from "@/web/chat-contract";

const DEFAULT_MAX_ATTEMPTS = 40;
const DEFAULT_INTERVAL_MS = 50;

export async function waitForCancelledTurnCheckpoint(options: {
  readonly previousRevision: number;
  readonly load: () => Promise<ConversationDetailResponse>;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly maxAttempts?: number;
  readonly intervalMs?: number;
}): Promise<ConversationDetailResponse> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const delay = options.delay ?? wait;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("停止恢复重试次数必须是正整数。");
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 0) {
    throw new Error("停止恢复间隔必须是非负整数。");
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const checkpoint = await options.load();
    if (
      checkpoint.activity.status !== "active" &&
      checkpoint.summary.revision > options.previousRevision
    ) {
      return checkpoint;
    }
    if (attempt < maxAttempts) await delay(intervalMs);
  }
  throw new Error("停止结果尚未完成保存，请重新加载会话后重试。");
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
