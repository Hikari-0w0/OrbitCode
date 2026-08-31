import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ConversationList } from "@/components/conversation-list";

test("对话列表展示持久标题并在运行中禁用管理操作", () => {
  const html = renderToStaticMarkup(
    <ConversationList
      conversations={[{
        schemaVersion: 1,
        id: "conversation-1",
        title: "继续实现持久化",
        revision: 2,
        createdAt: "2026-08-30T00:00:00.000Z",
        updatedAt: "2026-08-30T00:01:00.000Z",
        workspaceId: "project",
        providerId: "deepseek",
      }]}
      selectedId="conversation-1"
      disabled
      onSelect={() => undefined}
      onCreate={() => undefined}
      onRename={() => undefined}
      onDelete={() => undefined}
    />,
  );
  assert.match(html, /继续实现持久化/);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 4);
});
