import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { LocalConversationStore } from "@/lib/local-conversation-store";
import { LocalAgentRunLog } from "@/lib/local-agent-run-log";
import { AgentRuntime } from "@/runtime/agent-runtime";
import { ConversationService } from "@/runtime/conversation-service";
import { ConversationRuntimeManager } from "@/runtime/conversation-runtime-manager";
import { ConversationOperationGuard } from "@/runtime/conversation-operation-guard";
import { PermissionSessionManager } from "@/runtime/permission-session-manager";
import { loadProviderContext } from "@/runtime/config";
import { loadWorkspaceCatalog } from "@/runtime/workspace-config";
import { MacOsSeatbeltCommandSandbox } from "@/tools/macos-seatbelt-sandbox";
import { TerminalRenderer } from "@/cli/renderer";
import { SessionController } from "@/cli/session-controller";
import { startOpenAIMockServer, type MockRequest, type MockResponse } from "./openai-mock";

export async function runtimeFixture(responder: (request: MockRequest) => MockResponse | Promise<MockResponse>, options: {
  readonly terminal?: boolean;
  readonly context?: string;
  readonly iterations?: string;
  readonly storeFactory?: (root: string) => LocalConversationStore;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "orbit-parity-"));
  const server = await startOpenAIMockServer(responder);
  await writeFile(path.join(root, "orbitcode.yaml"), `providers:\n  - name: primary\n    protocol: openai\n    model: test-model\n    base_url: ${server.baseUrl}\n    api_key: FIXTURE_KEY\n    context:\n      window_tokens: 128000\n${options.context ?? ""}`);
  const loadConfig = () => loadProviderContext(root, { FIXTURE_KEY: "synthetic-fixture-secret", ...(options.iterations ? { ORBITCODE_MAX_AGENT_ITERATIONS: options.iterations } : {}) });
  const loadWorkspaces = () => loadWorkspaceCatalog({ cwd: root });
  const store = options.storeFactory?.(path.join(root, ".conversations")) ?? new LocalConversationStore(path.join(root, ".conversations"));
  const log = new LocalAgentRunLog(path.join(root, ".logs"));
  const manager = new ConversationRuntimeManager();
  const guard = new ConversationOperationGuard(manager, store);
  const permissions = new PermissionSessionManager();
  const runtime = new AgentRuntime({ store, manager, guard, permissions, log,
    loadConfig, loadWorkspaces, sandbox: new MacOsSeatbeltCommandSandbox() });
  const conversations = new ConversationService(store, manager, guard, loadConfig);
  let output = "";
  let errors = "";
  const stdout = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
  const stderr = new Writable({ write(chunk, _encoding, done) { errors += chunk.toString(); done(); } });
  const controller = new SessionController({ cwd: root, terminal: options.terminal ?? false,
    runtime, conversations, permissions, log, loadConfig, loadWorkspaces,
    renderer: new TerminalRenderer(stdout, stderr) });
  await controller.initialize({});
  return { root, server, store, log, manager, guard, permissions, runtime, conversations, controller,
    output: () => output, errors: () => errors,
    async checkpoint() { const entries = await store.list(); return store.load(entries[0].id); },
    async close() { controller.close(); await server.close(); await rm(root, { recursive: true, force: true }); } };
}
export async function waitUntil(predicate: () => boolean, timeout = 3000): Promise<void> {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error("等待测试状态超时。");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
