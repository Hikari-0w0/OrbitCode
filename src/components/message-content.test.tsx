import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageContent } from "./message-content";
test("消息 HTML 作为文本，不执行危险链接或加载图片", () => { const html = renderToStaticMarkup(<MessageContent text={'<script>alert(1)</script>\n[x](javascript:alert)\n![img](https://example.com/x.png)'}/>); assert.ok(!html.includes('<script>')); assert.ok(!html.includes('href="javascript:')); assert.ok(!html.includes('<img')); assert.match(html, /&lt;script&gt;/); });
