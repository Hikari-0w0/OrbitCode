import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LocalSettingsStore } from "@/lib/local-settings-store";
import { LocalConversationStore } from "@/lib/local-conversation-store";
async function main() {
    const root = await mkdtemp(path.join(os.tmpdir(), "orbitcode-memory-e2e-")), data = path.join(root, "data"), workspace = path.join(root, "workspace");
    await mkdir(data, { mode: 0o700 });
    await mkdir(workspace);
    await mkdir(path.join(workspace, ".orbitcode"));
    await writeFile(path.join(workspace, "README.md"), "测试工作区事实：共享 Web 与 CLI。\n");
    await writeFile(path.join(workspace, "AGENTS.md"), "项目根规则：回答中文。\n@include <conventions.md>\n");
    await writeFile(path.join(workspace, "conventions.md"), "检查实际结果后回复。\n");
    await writeFile(path.join(workspace, ".orbitcode/instructions.md"), "项目专属规则：称呼本项目为测试项目。\n");
    await writeFile(path.join(data, "instructions.md"), "用户约定：简洁说明。\n");
    const port = Number(process.argv[2] ?? 18991);
    await new LocalSettingsStore(data).save(0, { schemaVersion: 1, providers: [{ id: "fixture", displayName: "本地测试替身", model: "fixture", baseUrl: `http://127.0.0.1:${port}/v1`, credential: { kind: "local", value: "test-placeholder-not-a-key" }, context: { windowTokens: 64000, singleToolResultTokens: 8000, toolResultGroupTokens: 12000, recentMessagesTokens: 10000, automaticReserveTokens: 13000, manualReserveTokens: 3000, previewChars: 2000 }, enabled: true }], workspaces: [{ id: "test", name: "测试项目", rootPath: workspace, enabled: true }], mcpServers: [], defaultProviderId: "fixture", defaultWorkspaceId: "test", defaultPermissionMode: "permissive", maxIterations: 3, maxRuntimeMinutes: 1 });
    const store = new LocalConversationStore(path.join(data, "conversations-v1")), cp = await store.create({ workspaceId: "test", providerId: "fixture" });
    const past = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000), oldStore = new LocalConversationStore(path.join(data, "conversations-v1"), () => past), expired = await oldStore.create({ workspaceId: "test", providerId: "fixture", title: "可清理测试会话" }), blocked = await oldStore.create({ workspaceId: "test", providerId: "fixture", title: "待恢复测试会话" });
    await oldStore.markTurnStarted({ conversationId: blocked.summary.id, expectedRevision: 0, userInput: "中断测试", mode: "do", modeTurn: 1, ownerToken: "fixture-interruption" });
    process.stdout.write(JSON.stringify({ root, data, workspace, conversationId: cp.summary.id, expiredId: expired.summary.id, blockedId: blocked.summary.id }) + "\n");
}
void main();
