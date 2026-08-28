import assert from "node:assert/strict";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { ChatWorkspace } from "@/components/chat-workspace";

test("Provider 选择器在标签被响应式样式隐藏后仍有可访问名称", () => {
  const markup = renderToStaticMarkup(<ChatWorkspace />);

  assert.match(
    markup,
    /<select[^>]*id="provider-select"[^>]*aria-label="MODEL PROVIDER"/,
  );
});

test("示例问题容器使用可命名的分组语义", () => {
  const markup = renderToStaticMarkup(<ChatWorkspace />);

  assert.match(
    markup,
    /<div[^>]*class="suggestionGrid"[^>]*role="group"[^>]*aria-label="示例问题"/,
  );
});
