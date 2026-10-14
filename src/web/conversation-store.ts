import { LocalConversationStore } from "@/lib/local-conversation-store";
import { LocalContextStore } from "@/lib/local-context-store";
import { webConversationDirectory, webContextDirectory } from "@/web/storage-paths";
import { ConversationRuntimeManager } from "@/web/conversation-runtime-manager";
import { ConversationOperationGuard } from "@/web/conversation-operation-guard";

export const localConversationStore = new LocalConversationStore(webConversationDirectory);
export const conversationRuntimeManager = new ConversationRuntimeManager();
export const conversationOperationGuard = new ConversationOperationGuard(
  conversationRuntimeManager,
  localConversationStore,
);

const legacyContextStore = new LocalContextStore(webContextDirectory);
let legacyCleanup: Promise<void> | undefined;

export function cleanupLegacyContextSessions(): Promise<void> {
  legacyCleanup ??= legacyContextStore.cleanupExpiredSessions({
    olderThanMs: 24 * 60 * 60 * 1_000,
  }).then(() => undefined);
  return legacyCleanup;
}
