import test from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown, safeLink } from "./markdown-content";
test("Markdown 保留不完整代码和超限原文", () => { assert.deepEqual(parseMarkdown('```ts\nconst x = 1;'), [{ kind: "code", language: "ts", text: "const x = 1;" }]); const large = "x".repeat(129000); assert.deepEqual(parseMarkdown(large), [{ kind: "paragraph", text: large }]); });
test("Markdown 结构和危险链接", () => { assert.equal(parseMarkdown('# 标题\n\n- 条目\n\n| A | B |\n| --- | --- |\n| 1 | 2 |').length, 3); for (const href of ['javascript:alert(1)', 'data:text/html,hi', '/local', 'file:///tmp'])
    assert.equal(safeLink(href), undefined); assert.equal(safeLink('https://example.com'), 'https://example.com/'); });
