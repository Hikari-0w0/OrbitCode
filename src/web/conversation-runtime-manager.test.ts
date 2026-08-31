import assert from "node:assert/strict";
import test from "node:test";

import {
  ConversationRuntimeError,
  ConversationRuntimeManager,
} from "@/web/conversation-runtime-manager";

test("同一持久化会话只允许一个活动操作", () => {
  const manager = new ConversationRuntimeManager();
  const first = manager.begin("conversation-1");
  assert.equal(first.kind, "agent");
  assert.equal(manager.activeKind("conversation-1"), "agent");
  assert.throws(
    () => manager.begin("conversation-1"),
    (error) => error instanceof ConversationRuntimeError && error.kind === "operation-active",
  );
  const other = manager.begin("conversation-2", "compress");
  assert.equal(other.kind, "compress");
  manager.finish("conversation-1", first.id);
  assert.equal(manager.isActive("conversation-1"), false);
  manager.finish("conversation-2", other.id);
});
