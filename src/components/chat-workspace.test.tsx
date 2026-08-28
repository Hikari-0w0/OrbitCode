import assert from "node:assert/strict";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { ChatComposer } from "@/components/chat-composer";
import { ChatWorkspace } from "@/components/chat-workspace";
import { MessageList } from "@/components/message-list";
import { WorkspaceSelector } from "@/components/workspace-selector";

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

test("Workspace 选择器仅渲染安全摘要并具有可访问名称", () => {
  const sentinelPath = "/private/sentinel-workspace";
  const markup = renderToStaticMarkup(
    <WorkspaceSelector
      workspaces={[
        { id: "alpha", name: "项目 A", available: true, isDefault: true },
      ]}
      selectedWorkspaceId="alpha"
      disabled={false}
      onChange={() => undefined}
    />,
  );
  assert.match(markup, /aria-label="LOCAL WORKSPACE"/);
  assert.match(markup, /项目 A（默认）/);
  assert.equal(markup.includes(sentinelPath), false);
});

test("Plan/Do 切换使用按钮分组且明示当前模式", () => {
  const markup = renderToStaticMarkup(
    <ChatComposer
      value=""
      mode="plan"
      disabled={false}
      isStreaming={false}
      isStopping={false}
      onModeChange={() => undefined}
      onChange={() => undefined}
      onSubmit={() => undefined}
      onStop={() => undefined}
    />,
  );
  assert.match(markup, /role="group" aria-label="Agent 模式"/);
  assert.match(markup, /aria-pressed="true"[^>]*>PLAN/);
  assert.match(markup, /只读文件、查找与搜索/);
});

test("仅指定的最新 Plan 回复显示执行操作", () => {
  const markup = renderToStaticMarkup(
    <MessageList
      messages={[
        { id: "old", role: "assistant", content: "旧计划", state: "complete" },
        { id: "latest", role: "assistant", content: "新计划", state: "complete" },
      ]}
      onSuggestion={() => undefined}
      executablePlanMessageId="latest"
      planActionDisabled={false}
      onExecutePlan={() => undefined}
    />,
  );
  assert.equal(markup.match(/按此计划执行/g)?.length, 1);
});

test("失败工具卡同时展示错误与调用参数", () => {
  const markup = renderToStaticMarkup(
    <MessageList
      messages={[{
        id: "failed",
        role: "assistant",
        content: "",
        state: "failed",
        toolExecutions: [{
          iteration: 1,
          sequence: 0,
          callId: "call-1",
          name: "write_file",
          argumentsJson: '{"path":"/absolute/main.cpp"}',
          state: "failed",
          result: {
            ok: false,
            error: {
              kind: "permission-denied",
              message: "路径必须是有效的相对路径。",
              retryable: true,
            },
            sideEffect: "none",
            meta: {
              durationMs: 1,
              truncated: false,
              truncatedFields: [],
            },
          },
        }],
      }]}
      onSuggestion={() => undefined}
      planActionDisabled={false}
      onExecutePlan={() => undefined}
    />,
  );

  assert.match(markup, /查看错误详情与调用参数/);
  assert.match(markup, /路径必须是有效的相对路径/);
  assert.match(markup, /\/absolute\/main\.cpp/);
});
