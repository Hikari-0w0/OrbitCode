import { open } from "node:fs/promises";
import path from "node:path";

import type { ConversationCheckpoint } from "@/core/conversations/types";
import { collectContextReferences } from "@/lib/context-references";
import {
  AgentRunLogError,
  LocalAgentRunLog,
  type StoredAgentRunLogEntry,
} from "@/lib/local-agent-run-log";
import { LocalConversationStore } from "@/lib/local-conversation-store";

const CONTEXT_CHUNK_CHARACTERS = 64 * 1024;

export type AgentRunExport = {
  readonly format: "orbitcode-agent-run";
  readonly schemaVersion: 1;
  readonly exportedAt: string;
  readonly containsSensitiveContent: true;
  readonly run: StoredAgentRunLogEntry;
  readonly checkpoints: {
    readonly before: ExportedCheckpoint;
    readonly after: ExportedCheckpoint;
  };
  readonly context: {
    readonly included: boolean;
    readonly objects: readonly ExportedContextObject[];
  };
  readonly warnings: readonly string[];
};

type ExportedCheckpoint =
  | {
      readonly status: "included";
      readonly revision: number;
      readonly checkpoint: ConversationCheckpoint;
    }
  | { readonly status: "unavailable"; readonly revision: number }
  | { readonly status: "not-saved" };

type ExportedContextObject =
  | {
      readonly reference: string;
      readonly status: "included";
      readonly byteLength: number;
      readonly content: string;
    }
  | { readonly reference: string; readonly status: "unavailable" };

export class AgentRunExportError extends Error {
  constructor(
    readonly kind: "not-found" | "invalid-data" | "output-exists" | "storage",
    message: string,
  ) {
    super(message);
    this.name = "AgentRunExportError";
  }
}

export class LocalAgentRunExporter {
  constructor(
    private readonly runLog = new LocalAgentRunLog(),
    private readonly conversations = new LocalConversationStore(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async exportRun(input: {
    readonly runId: string;
    readonly outputPath: string;
    readonly includeContext?: boolean;
  }): Promise<AgentRunExport> {
    const result = await this.createRunExport(input);
    await writeExclusiveJson(path.resolve(input.outputPath), result);
    return result;
  }

  async createRunExport(input: {
    readonly runId: string;
    readonly includeContext?: boolean;
  }): Promise<AgentRunExport> {
    try {
      return await this.buildRunExport(
        await this.runLog.find(input.runId),
        input.includeContext ?? true,
      );
    } catch (error) {
      throw normalizeExportError(error);
    }
  }

  private async buildRunExport(
    run: StoredAgentRunLogEntry,
    includeContext: boolean,
  ): Promise<AgentRunExport> {
    const warnings: string[] = [];
    const checkpoints = await this.loadCheckpoints(run, warnings);
    const contextObjects = includeContext
      ? await this.loadContextObjects(run.conversationId, checkpoints, warnings)
      : [];
    if (!includeContext) warnings.push("已按参数省略卸载的工具上下文对象。");
    return {
      format: "orbitcode-agent-run",
      schemaVersion: 1,
      exportedAt: this.now().toISOString(),
      containsSensitiveContent: true,
      run,
      checkpoints,
      context: { included: includeContext, objects: contextObjects },
      warnings,
    };
  }

  private async loadCheckpoints(
    run: StoredAgentRunLogEntry,
    warnings: string[],
  ): Promise<AgentRunExport["checkpoints"]> {
    const before = await this.loadCheckpoint(
      run.conversationId,
      run.revisionBefore,
      "运行前",
      warnings,
    );
    if (run.persistence.status !== "saved") {
      if (run.persistence.status === "failed") {
        warnings.push("本轮运行保存失败，因此没有运行后的持久化检查点。");
      }
      return { before, after: { status: "not-saved" } };
    }
    const after = await this.loadCheckpoint(
      run.conversationId,
      run.persistence.revisionAfter,
      "运行后",
      warnings,
    );
    return { before, after };
  }

  private async loadCheckpoint(
    conversationId: string,
    revision: number,
    label: string,
    warnings: string[],
  ): Promise<ExportedCheckpoint> {
    try {
      return {
        status: "included",
        revision,
        checkpoint: await this.conversations.loadRevision(conversationId, revision),
      };
    } catch {
      warnings.push(`${label}检查点 revision ${revision} 不可用，可能已被删除或损坏。`);
      return { status: "unavailable", revision };
    }
  }

  private async loadContextObjects(
    conversationId: string,
    checkpoints: AgentRunExport["checkpoints"],
    warnings: string[],
  ): Promise<readonly ExportedContextObject[]> {
    const references = new Set<string>();
    for (const item of [checkpoints.before, checkpoints.after]) {
      if (item.status !== "included") continue;
      for (const reference of collectContextReferences(item.checkpoint.context.messages)) {
        references.add(reference);
      }
    }
    const objects: ExportedContextObject[] = [];
    for (const reference of references) {
      try {
        const content = await this.readContextObject(conversationId, reference);
        objects.push({
          reference,
          status: "included",
          byteLength: Buffer.byteLength(content, "utf8"),
          content,
        });
      } catch {
        warnings.push(`上下文对象 ${reference} 不可用，导出中仅保留引用。`);
        objects.push({ reference, status: "unavailable" });
      }
    }
    return objects;
  }

  private async readContextObject(
    conversationId: string,
    reference: string,
  ): Promise<string> {
    const signal = new AbortController().signal;
    let offset = 0;
    let content = "";
    for (;;) {
      const chunk = await this.conversations.read({
        sessionId: conversationId,
        reference,
        offset,
        limit: CONTEXT_CHUNK_CHARACTERS,
        signal,
      });
      content += chunk.content;
      if (!chunk.hasMore) return content;
      if (chunk.nextOffset <= offset) {
        throw new AgentRunExportError("invalid-data", "上下文对象分块读取没有向前推进。");
      }
      offset = chunk.nextOffset;
    }
  }
}

async function writeExclusiveJson(target: string, value: unknown): Promise<void> {
  let handle;
  try {
    handle = await open(target, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    if (isNodeError(error, "EEXIST")) {
      throw new AgentRunExportError("output-exists", `导出文件已存在：${target}`);
    }
    if (error instanceof AgentRunExportError) throw error;
    throw new AgentRunExportError("storage", `无法写入导出文件：${target}`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function normalizeExportError(error: unknown): AgentRunExportError {
  if (error instanceof AgentRunExportError) return error;
  if (error instanceof AgentRunLogError) {
    return new AgentRunExportError(error.kind, error.message);
  }
  return new AgentRunExportError("storage", "无法读取本地运行数据。");
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
