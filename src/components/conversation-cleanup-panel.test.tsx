import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationCleanupPanel } from "./conversation-cleanup-panel";
test("未选择候选时清理按钮禁用", () => { assert.match(renderToStaticMarkup(<ConversationCleanupPanel onChanged={() => { }}/>), /disabled=""[^>]*>删除选定会话/); });
