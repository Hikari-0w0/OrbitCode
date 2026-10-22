import { createHash } from "node:crypto";
import type { ContextStore, ManagedContextMessage } from "@/core/context/types";
import type { ChildTaskContract, PreparedChildContextManifest } from "@/core/sub-agents/task-contract";
import { immutableSnapshot } from "@/lib/immutable-snapshot";
import { selectSkillHistory } from "./history";

export async function prepareChildContext(input: {
  readonly contract: ChildTaskContract;
  readonly messages: readonly ManagedContextMessage[];
  readonly parentStore: ContextStore;
  readonly childStore: ContextStore;
  readonly signal: AbortSignal;
}) {
  const { contract } = input;
  const messages = immutableSnapshot(input.messages);
  if (createHash("sha256").update(JSON.stringify(messages)).digest("hex") !== contract.specification.context.sha256) throw new Error("子任务历史与接纳快照不一致。");
  const referenceAliases = new Map<string, string>();
  const references: PreparedChildContextManifest["references"][number][] = [];
  let copiedReferences = 0, copiedBytes = 0;
  const history = await selectSkillHistory({ messages,
    history: { kind: contract.specification.task.kind === "fork" ? "all" : "none" },
    parentId: contract.scope.conversationId, childId: contract.taskId, parentStore: input.parentStore,
    childStore: input.childStore, signal: input.signal, referenceAliases,
    onReferenceCopied: reference => {
      copiedReferences++; copiedBytes += reference.byteLength;
      if (references.length < 16) references.push(reference);
    } });
  const serialized = JSON.stringify(history);
  const manifest: PreparedChildContextManifest = immutableSnapshot({ version: 1,
    sourceSha256: contract.specification.context.sha256, messages: history.length,
    serializedBytes: Buffer.byteLength(serialized), sha256: createHash("sha256").update(serialized).digest("hex"),
    copiedReferences, copiedBytes, references, referencesOmitted: copiedReferences - references.length });
  return { history, referenceAliases, manifest };
}
