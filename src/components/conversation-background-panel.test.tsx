import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationBackgroundPanel } from "./conversation-background-panel";
test("背景面板首次展示不需要请求模型", () => { const html = renderToStaticMarkup(<ConversationBackgroundPanel conversationId="c"/>); assert.match(html, /项目背景与长期记忆/); assert.match(html, /检查 \/ 刷新/); });
