import type { ConversationCheckpoint } from "@/core/conversations/types";
import {
  AgentRunLogError,
  LocalAgentRunLog,
  type StoredAgentRunLogEntry,
} from "@/lib/local-agent-run-log";
import { LocalConversationStore } from "@/lib/local-conversation-store";

const CONTEXT_CHUNK_CHARACTERS = 64 * 1024;

export type ConversationExport = {
  readonly format: "orbitcode-conversation";
  readonly schemaVersion: 1;
  readonly exportedAt: string;
  readonly containsSensitiveContent: true;
  readonly conversationId: string;
  readonly headRevision: number;
  readonly revisions: readonly ConversationCheckpoint[];
  readonly runs: readonly StoredAgentRunLogEntry[];
  readonly context: {
    readonly objects: readonly ExportedContextObject[];
  };
  readonly warnings: readonly string[];
};

type ExportedContextObject =
  | {
      readonly reference: string;
      readonly status: "included";
      readonly byteLength: number;
      readonly content: string;
    }
  | { readonly reference: string; readonly status: "unavailable" };

export class ConversationExportError extends Error {
  constructor(
    readonly kind: "not-found" | "invalid-data" | "storage",
    message: string,
  ) {
    super(message);
    this.name = "ConversationExportError";
  }
}

export class LocalConversationExporter {
  constructor(
    private readonly runLog = new LocalAgentRunLog(),
    private readonly conversations = new LocalConversationStore(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createExport(conversationId: string): Promise<ConversationExport> {
    try {
      const [head, revisions, runs] = await Promise.all([
        this.conversations.load(conversationId),
        this.conversations.listRevisions(conversationId),
        this.runLog.findAllForConversation(conversationId),
      ]);
      const warnings: string[] = [];
      const contextObjects = await this.loadContextObjects(
        conversationId,
        revisions,
        warnings,
      );
      return {
        format: "orbitcode-conversation",
        schemaVersion: 1,
        exportedAt: this.now().toISOString(),
        containsSensitiveContent: true,
        conversationId,
        headRevision: head.summary.revision,
        revisions,
        runs,
        context: { objects: contextObjects },
        warnings,
      };
    } catch (error) {
      if (error instanceof ConversationExportError) throw error;
      if (error instanceof AgentRunLogError) {
        if (error.kind === "not-found") {
          throw new ConversationExportError("not-found", error.message);
        }
        throw new ConversationExportError(error.kind, error.message);
      }
      if (error instanceof Error && "kind" in error) {
        const kind = error.kind;
        if (kind === "not-found" || kind === "invalid-data" || kind === "storage") {
          throw new ConversationExportError(kind, error.message);
        }
      }
      throw new ConversationExportError("storage", "无法读取完整对话记录。");
    }
  }

  private async loadContextObjects(
    conversationId: string,
    revisions: readonly ConversationCheckpoint[],
    warnings: string[],
  ): Promise<readonly ExportedContextObject[]> {
    const references = new Set<string>();
    for (const checkpoint of revisions) {
      for (const message of checkpoint.context.messages) {
        if (message.kind === "tool-result" && message.payload.storage === "offloaded") {
          references.add(message.payload.reference);
        }
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
        throw new ConversationExportError("invalid-data", "上下文对象分块读取没有向前推进。");
      }
      offset = chunk.nextOffset;
    }
  }
}
