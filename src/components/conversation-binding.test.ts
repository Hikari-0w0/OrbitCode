import assert from "node:assert/strict";
import test from "node:test";
import { resolveNewConversationBinding } from "./conversation-binding";
const workspaces = [
  { id: "project", name: "Project", available: true, isDefault: false },
  { id: "default", name: "Default", available: true, isDefault: true },
];
const providers = [
  { name: "offline", model: "x", available: false },
  { name: "primary", model: "x", available: true },
  { name: "tertiary", model: "x", available: true },
];
test("旧绑定已移除时，新建使用有效默认配置，保留仍有效的另一项", () => {
  assert.deepEqual(resolveNewConversationBinding("removed", "tertiary", workspaces, providers), { workspaceId: "default", providerId: "tertiary" });
  assert.deepEqual(resolveNewConversationBinding("project", "removed", workspaces, providers), { workspaceId: "project", providerId: "primary" });
  assert.deepEqual(resolveNewConversationBinding("project", "tertiary", workspaces, providers), { workspaceId: "project", providerId: "tertiary" });
});
test("默认项不可用时选择可用项，没有有效配置时不创建", () => {
  assert.deepEqual(resolveNewConversationBinding("removed", "offline", workspaces.map(w => ({ ...w, available: !w.isDefault })), providers), { workspaceId: "project", providerId: "primary" });
  assert.equal(resolveNewConversationBinding("project", "primary", [], providers), undefined);
  assert.equal(resolveNewConversationBinding("project", "offline", workspaces, providers.map(p => ({ ...p, available: false }))), undefined);
});
