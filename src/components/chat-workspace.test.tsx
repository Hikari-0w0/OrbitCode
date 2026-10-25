import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderSelector } from "@/components/provider-selector";
import { ChatComposer } from "@/components/chat-composer";
import { ChatWorkspace } from "@/components/chat-workspace";
import { MessageList } from "@/components/message-list";
import { WorkspaceSelector } from "@/components/workspace-selector";
test("Provider 选择器在标签被响应式样式隐藏后仍有可访问名称", () => {
    const markup = renderToStaticMarkup(<ProviderSelector providers={[]} selected="" disabled={false} onChange={() => undefined}/>);
    assert.match(markup, /<select[^>]*id="provider-select"[^>]*aria-label="MODEL PROVIDER"/);
});
test("对话页提供完整对话导出按钮", () => {
    const markup = renderToStaticMarkup(<ChatWorkspace />);
    assert.match(markup, /<button[^>]*class="exportButton"[^>]*>.*导出对话.*<\/button>/);
});
test("示例问题容器使用可命名的分组语义", () => {
    const markup = renderToStaticMarkup(<ChatWorkspace />);
    assert.match(markup, /<div[^>]*class="suggestionGrid"[^>]*role="group"[^>]*aria-label="示例问题"/);
});
test("Workspace 选择器仅渲染安全摘要并具有可访问名称", () => {
    const sentinelPath = "/private/sentinel-workspace";
    const markup = renderToStaticMarkup(<WorkspaceSelector workspaces={[
            { id: "alpha", name: "项目 A", available: true, isDefault: true },
        ]} selectedWorkspaceId="alpha" disabled={false} onChange={() => undefined}/>);
    assert.match(markup, /aria-label="LOCAL WORKSPACE"/);
    assert.match(markup, /项目 A（默认）/);
    assert.equal(markup.includes(sentinelPath), false);
});
test("Plan/Do 切换使用按钮分组且明示当前模式", () => {
    const markup = renderToStaticMarkup(<ChatComposer value="" mode="plan" disabled={false} isStreaming={false} isStopping={false} onModeChange={() => undefined} onChange={() => undefined} onSubmit={() => undefined} onStop={() => undefined}/>);
    assert.match(markup, /role="group" aria-label="Agent 模式"/);
    assert.match(markup, /aria-pressed="true"[^>]*>规划/);
    assert.match(markup, /只读文件、查找与搜索/);
});
test("仅指定的最新 Plan 回复显示执行操作", () => {
    const markup = renderToStaticMarkup(<MessageList messages={[
            { id: "old", role: "assistant", content: "旧计划", state: "complete" },
            { id: "latest", role: "assistant", content: "新计划", state: "complete" },
        ]} onSuggestion={() => undefined} executablePlanMessageId="latest" planActionDisabled={false} onExecutePlan={() => undefined}/>);
    assert.equal(markup.match(/按此计划执行/g)?.length, 1);
});
test("失败工具卡展示安全错误但不回显原始调用参数", () => {
    const markup = renderToStaticMarkup(<MessageList messages={[{
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
            }]} onSuggestion={() => undefined} planActionDisabled={false} onExecutePlan={() => undefined}/>);
    assert.match(markup, /访问受到限制/);
    assert.match(markup, /原始结果/);
    assert.match(markup, /路径必须是有效的相对路径/);
    assert.equal(markup.includes("/absolute/main.cpp"), false);
});
test("对话页显示自主执行且不暴露审批模式选择", () => {
 const markup=renderToStaticMarkup(<ChatWorkspace/>);assert.match(markup,/自主执行/);assert.equal(markup.includes('aria-label="权限模式"'),false);assert.equal(markup.includes('严格审批'),false);
});

test("历史授权卡保留安全摘要但不再提供决定按钮", () => {
    const sentinel = "must-not-render-secret";
    const markup = renderToStaticMarkup(<MessageList messages={[{
                id: "approval",
                role: "assistant",
                content: "",
                state: "streaming",
                toolExecutions: [{
                        iteration: 1,
                        sequence: 0,
                        callId: "call-approval",
                        name: "run_command",
                        argumentsJson: JSON.stringify({ command: sentinel }),
                        state: "awaiting-approval",
                        permission: {
                            state: "awaiting",
                            prompt: {
                                requestId: "request-1",
                                toolCallId: "call-approval",
                                toolName: "run_command",
                                workspace: { id: "project", name: "Project" },
                                summary: { operation: "执行命令", command: "git status", cwd: "." },
                                risk: { level: "high", message: "命令需要确认。" },
                                source: "mode",
                                persistentLayer: "local",
                                expiresAt: "2026-08-29T00:00:00.000Z",
                            },
                        },
                    }],
            }]} onSuggestion={() => undefined} planActionDisabled={false} onExecutePlan={() => undefined}/>);
    assert.match(markup,/历史授权记录/);
    assert.equal(markup.includes("授权决定"),false);
    assert.equal(markup.includes("本次允许"),false);
    assert.match(markup, /git status/);
    assert.equal(markup.includes(sentinel), false);
});
