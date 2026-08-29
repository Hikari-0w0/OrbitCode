import { ContextManagementError } from "@/core/context/context-errors";
import { parseSummaryEnvelope } from "@/core/context/summary-parser";
import {
  buildSummaryInput,
  SUMMARY_SYSTEM_PROMPT,
} from "@/core/context/summary-prompt";
import type {
  ContextSummary,
  ManagedContextMessage,
} from "@/core/context/types";
import {
  ProviderError,
  type ChatProvider,
} from "@/models/provider";

export class ToolFreeSummaryGenerator {
  constructor(private readonly provider: ChatProvider) {}

  async generate(
    messages: readonly ManagedContextMessage[],
    signal: AbortSignal,
  ): Promise<ContextSummary> {
    let content = "";
    let completed = false;
    let usageReceived = false;
    try {
      for await (const event of this.provider.stream(
        [
          { role: "system", content: SUMMARY_SYSTEM_PROMPT },
          { role: "user", content: buildSummaryInput(messages) },
        ],
        { signal, toolChoice: "none" },
      )) {
        if (signal.aborted) {
          throw new ContextManagementError("cancelled", "上下文压缩已取消。");
        }
        if (event.type === "reasoning-delta") {
          if (completed) throw protocolError("摘要完成后仍返回推理内容。");
        } else if (event.type === "text-delta") {
          if (completed) throw protocolError("摘要完成后仍返回文本。");
          content += event.text;
        } else if (event.type === "tool-call") {
          throw protocolError("摘要模型在禁用工具时仍返回了工具调用。");
        } else if (event.type === "usage") {
          if (usageReceived) throw protocolError("摘要模型重复返回 Token 用量。");
          usageReceived = true;
        } else {
          if (completed || event.finishReason !== "stop") {
            throw protocolError("摘要模型没有以纯文本成功结束。");
          }
          completed = true;
        }
      }
    } catch (error) {
      if (error instanceof ContextManagementError) throw error;
      if (error instanceof ProviderError) {
        throw new ContextManagementError(
          error.kind === "protocol" ? "summary-protocol" : "summary-network",
          `摘要请求失败：${error.message}`,
          { cause: error, summaryFailure: true },
        );
      }
      throw new ContextManagementError(
        "summary-network",
        "摘要请求发生未知错误。",
        { cause: error, summaryFailure: true },
      );
    }
    if (!completed || content.trim().length === 0) {
      throw protocolError("摘要模型响应不完整。");
    }
    return parseSummaryEnvelope(content);
  }
}

function protocolError(message: string): ContextManagementError {
  return new ContextManagementError("summary-protocol", message, {
    summaryFailure: true,
  });
}
