import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { LocalSettingsStore } from "@/lib/local-settings-store";
import { LocalConversationStore } from "@/lib/local-conversation-store";
import type { PersistedDisplayMessage } from "@/core/conversations/types";
async function main() {
    const args = process.argv.slice(2);
    const directory = args[args.indexOf("--data-dir") + 1];
    if (!args.includes("--prepare") || !args.includes("--data-dir") || !directory || !path.isAbsolute(directory))
        throw new Error("必须显式指定隔离目录和 --prepare。");
    const store = new LocalSettingsStore(directory);
    if (await store.load())
        throw new Error("隔离目录已有设置，拒绝覆盖。");
    const port = Number(args.includes("--port") ? args[args.indexOf("--port") + 1] : 18997);
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
        throw new Error("端口无效。");
    const workspace = path.join(directory, "workspace");
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await writeFile(path.join(workspace, "README.md"), "# OrbitCode 测试工作区\n这是隔离的界面验收数据。\n");
    await store.save(0, { schemaVersion: 1, providers: [{ id: "fixture", displayName: "本地测试模型", model: "ui-fixture", baseUrl: `http://127.0.0.1:${port}/v1`, credential: { kind: "local", value: "fixture-not-a-real-key" }, enabled: true, context: { windowTokens: 128000, singleToolResultTokens: 8000, toolResultGroupTokens: 12000, recentMessagesTokens: 10000, automaticReserveTokens: 13000, manualReserveTokens: 3000, previewChars: 2000 } }], workspaces: [{ id: "demo", name: "示例项目", rootPath: workspace, enabled: true }], mcpServers: [], defaultProviderId: "fixture", defaultWorkspaceId: "demo", defaultPermissionMode: "default", maxIterations: 3, maxRuntimeMinutes: 1 });
    const conversations = new LocalConversationStore(path.join(directory, "conversations-v1"));
    const long = await conversations.create({ workspaceId: "demo", providerId: "fixture", title: "项目架构与性能分析" });
    const messages: PersistedDisplayMessage[] = Array.from({ length: 200 }, (_, index) => ({ id: `sample-${index}`, role: index % 2 ? "assistant" : "user", state: "complete", content: `## 任务 ${index + 1}\n\n${"项目分析与实现建议。".repeat(40)}\n\n- 阅读现有代码\n- 保持权限边界\n\n\`\`\`ts\nconst message = '你好，OrbitCode';\n\`\`\``, ...(index % 4 === 1 ? { toolExecutions: [{ iteration: 1, sequence: index, callId: `call-${index}`, name: "read_file", argumentsJson: "{}", state: "succeeded", result: { ok: true, output: { content: index === 1 ? "x".repeat(100 * 1024) : "隔离工具结果" }, sideEffect: "none", meta: { durationMs: 12, truncated: false, truncatedFields: [] } } }] } : {}) }));
    await conversations.save({ conversationId: long.summary.id, expectedRevision: 0, checkpoint: { ...long, displayMessages: messages } });
    await conversations.create({ workspaceId: "demo", providerId: "fixture", title: "设计组件与交互规范" });
    const empty = await conversations.create({ workspaceId: "demo", providerId: "fixture", title: "新对话" });
    const past = new LocalConversationStore(path.join(directory, "conversations-v1"), () => new Date(Date.now() - 32 * 86400000));
    await past.create({ workspaceId: "demo", providerId: "fixture", title: "过期测试记录" });
    process.stdout.write(JSON.stringify({ directory, workspace, longConversationId: long.summary.id, conversationId: empty.summary.id }) + "\n");
}
void main();
