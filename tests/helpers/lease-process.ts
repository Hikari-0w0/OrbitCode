import { LocalConversationStore } from "@/lib/local-conversation-store";
async function main() {
  const store = new LocalConversationStore(process.argv[2]);
  const id = process.argv[3];
  const lease = await store.acquireWriteLease(id);
  const checkpoint = await store.load(id);
  await store.markTurnStarted({ conversationId: id, expectedRevision: checkpoint.summary.revision,
    userInput: "子进程中断请求", mode: "do", modeTurn: 1, ownerToken: lease.ownerToken });
  process.stdout.write("READY\n");
  process.stdin.resume();
  process.on("SIGTERM", () => { void lease.release().then(() => process.exit(0)); });
}
void main().catch(() => { process.exitCode = 1; });
