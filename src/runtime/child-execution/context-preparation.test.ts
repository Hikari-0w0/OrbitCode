import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ManagedContextMessage } from "@/core/context/types";
import type { ChildTaskContract } from "@/core/sub-agents/task-contract";
import { LocalContextStore } from "@/lib/local-context-store";
import { testTaskSpecification } from "../../../tests/helpers/task-admission";
import { prepareChildContext } from "./context-preparation";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function contract(messages: readonly ManagedContextMessage[]): ChildTaskContract {
  const specification = testTaskSpecification({ kind: "fork", prompt: "查找原文", background: true }, 4, 5000);
  return { version: 1, taskId: "child", scope: { conversationId: "parent", lifecycleEpoch: "epoch" }, turnId: "turn", callId: "call", createdAt: 1, deadlineAt: 5001,
    specification: { ...specification, context: { ...specification.context, messages: messages.length, sha256: digest(JSON.stringify(messages)) } } };
}

test("迁移清单记录实际中文正文、引用映射与哈希，摘要预览不冒充全文", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "child-manifest-"));
  try {
    const parentStore = new LocalContextStore(path.join(root, "parent")), childStore = new LocalContextStore(path.join(root, "child")), signal = new AbortController().signal;
    const content = "中文😀实际正文", stored = await parentStore.write({ sessionId: "parent", content, signal });
    const messages: ManagedContextMessage[] = [{ kind: "assistant-tool-call", content: null, toolCalls: [{ id: "read", name: "read_file", argumentsJson: "{}" }] },
      { kind: "tool-result", toolCallId: "read", payload: { storage: "offloaded", reference: stored.reference, preview: "仅预览", originalBytes: Buffer.byteLength(content), estimatedTokens: 10 } }];
    const admitted = contract(messages), prepared = await prepareChildContext({ contract: admitted, messages, parentStore, childStore, signal });
    const manifest = prepared.manifest, mapping = manifest.references[0];
    assert.equal(manifest.sourceSha256, admitted.specification.context.sha256); assert.equal(manifest.sha256, digest(JSON.stringify(prepared.history)));
    assert.equal(manifest.serializedBytes, Buffer.byteLength(JSON.stringify(prepared.history))); assert.equal(manifest.copiedBytes, Buffer.byteLength(content));
    assert.equal(manifest.copiedReferences, 1); assert.equal(mapping.source, stored.reference); assert.notEqual(mapping.destination, mapping.source);
    assert.equal(mapping.sha256, digest(content)); assert.equal(prepared.referenceAliases.get(stored.reference), mapping.destination);
    assert.equal((await childStore.read({ sessionId: "child", reference: mapping.destination, offset: 0, limit: 1000, signal })).content, content);
    assert.ok(Object.isFrozen(mapping)); assert.equal(manifest.referencesOmitted, 0);
    await assert.rejects(childStore.read({ sessionId: "other", reference: mapping.destination, offset: 0, limit: 1000, signal }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("接纳历史被替换时拒绝准备，不能给新历史签发旧快照哈希", async () => {
  const store = new LocalContextStore("/unused");
  await assert.rejects(prepareChildContext({ contract: contract([]), messages: [{ kind: "user", content: "迟到输入" }], parentStore: store, childStore: store, signal: new AbortController().signal }), /接纳快照不一致/);
});

test("引用清单有界且保留全部复制计数与实际字节总量", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "child-manifest-bounded-"));
  try {
    const parentStore = new LocalContextStore(path.join(root, "parent")), childStore = new LocalContextStore(path.join(root, "child")), signal = new AbortController().signal;
    const messages: ManagedContextMessage[] = [];
    let bytes = 0;
    for (let index = 0; index < 20; index++) {
      const content = `原文${index}`; bytes += Buffer.byteLength(content);
      const stored = await parentStore.write({ sessionId: "parent", content, signal });
      messages.push({ kind: "assistant-tool-call", content: null, toolCalls: [{ id: `read-${index}`, name: "read_file", argumentsJson: "{}" }] },
        { kind: "tool-result", toolCallId: `read-${index}`, payload: { storage: "offloaded", reference: stored.reference, preview: "预览", originalBytes: stored.byteLength, estimatedTokens: 4 } });
    }
    const prepared = await prepareChildContext({ contract: contract(messages), messages, parentStore, childStore, signal });
    assert.equal(prepared.manifest.copiedReferences, 20); assert.equal(prepared.manifest.references.length, 16); assert.equal(prepared.manifest.referencesOmitted, 4);
    assert.equal(prepared.manifest.copiedBytes, bytes); assert.equal(prepared.referenceAliases.size, 20); assert.equal(prepared.history.length, 40);
  } finally { await rm(root, { recursive: true, force: true }); }
});
