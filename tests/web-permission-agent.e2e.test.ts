import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentLoop } from "@/core/agent-loop";
import type { PermissionUserDecision } from "@/core/permissions/approval";
import type {
  ChatProvider,
  ConversationMessage,
  ModelStreamEvent,
} from "@/models/provider";
import { createModeToolPolicy } from "@/tools/mode-policy";
import {
  addLocalPermissionAllow,
  loadPermissionRules,
  type PermissionConfigLocations,
} from "@/tools/permission-config";
import { PermissionGateway } from "@/tools/permission-gateway";
import { readFileTool } from "@/tools/read-file";
import { ToolRegistry } from "@/tools/registry";
import { createWorkspaceBoundary } from "@/tools/workspace";
import { writeFileTool } from "@/tools/write-file";
import {
  parseWebChatEvents,
  readWebStream,
  type WebChatEvent,
} from "@/web/chat-contract";
import { streamAgentResponse } from "@/web/chat-handler";
import { PermissionSessionManager } from "@/web/permission-session-manager";

test(
  "本次允许从 SSE 暂停点恢复原 Agent Loop 且不泄露写入正文",
  { timeout: 10_000 },
  async () => {
    const fixture = await createFixture();
    const sentinelBody = "WRITE_BODY_SENTINEL_SHOULD_NOT_REACH_SSE";
    try {
      const provider = new ScriptedProvider([
        toolScript("call-write", "write_file", {
          path: "generated.txt",
          content: sentinelBody,
        }),
        finalScript("文件已写入。"),
      ]);
      const result = await runPermissionAgent({
        fixture,
        provider,
        decide: "allow-once",
      });

      assert.equal(await readFile(path.join(fixture.root, "generated.txt"), "utf8"), sentinelBody);
      assert.deepEqual(
        result.events
          .filter((event) =>
            event.type === "permission-requested" ||
            event.type === "permission-resolved" ||
            event.type === "tool-started" ||
            event.type === "tool-result"
          )
          .map((event) => event.type),
        ["permission-requested", "permission-resolved", "tool-started", "tool-result"],
      );
      assert.equal(result.events.filter((event) => event.type === "stopped").length, 1);
      assert.equal(JSON.stringify(result.events).includes(sentinelBody), false);
      assert.equal(JSON.stringify(result.events).includes(fixture.root), false);
      assert.equal(JSON.stringify(provider.requests).includes(sentinelBody), false);
      assert.equal(JSON.stringify(provider.requests).includes(fixture.root), false);
    } finally {
      await fixture.cleanup();
    }
  },
);

test("本会话允许复用同一精确目标但不扩大到其他路径", async () => {
  const fixture = await createFixture();
  try {
    const provider = new ScriptedProvider([
      toolScript("write-1", "write_file", { path: "same.txt", content: "first" }),
      toolScript("write-2", "write_file", { path: "same.txt", content: "second" }),
      toolScript("write-3", "write_file", { path: "other.txt", content: "other" }),
      finalScript("完成。"),
    ]);
    const result = await runPermissionAgent({
      fixture,
      provider,
      decide(requestIndex) {
        return requestIndex === 0 ? "allow-session" : "deny";
      },
    });

    assert.equal(
      result.events.filter((event) => event.type === "permission-requested").length,
      2,
    );
    assert.equal(await readFile(path.join(fixture.root, "same.txt"), "utf8"), "second");
    await assert.rejects(readFile(path.join(fixture.root, "other.txt"), "utf8"));
    assert.equal(
      result.events.some(
        (event) =>
          event.type === "tool-result" &&
          !event.result.ok &&
          event.result.error.kind === "user-denied",
      ),
      true,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("永久允许原子写入本地规则并在新会话重载后生效", async () => {
  const fixture = await createFixture();
  try {
    const first = await runPermissionAgent({
      fixture,
      provider: new ScriptedProvider([
        toolScript("write-first", "write_file", {
          path: "persistent.txt",
          content: "first",
        }),
        finalScript("首次完成。"),
      ]),
      decide: "allow-permanent",
    });
    assert.equal(
      first.events.filter((event) => event.type === "permission-requested").length,
      1,
    );

    const second = await runPermissionAgent({
      fixture,
      provider: new ScriptedProvider([
        toolScript("write-second", "write_file", {
          path: "persistent.txt",
          content: "second",
        }),
        finalScript("再次完成。"),
      ]),
      decide() {
        throw new Error("重载后的精确 allow 不应再次询问");
      },
    });
    assert.equal(
      second.events.some((event) => event.type === "permission-requested"),
      false,
    );
    assert.equal(await readFile(path.join(fixture.root, "persistent.txt"), "utf8"), "second");
    const localConfig = await readFile(fixture.locations.local, "utf8");
    assert.match(localConfig, /write_file\(persistent\.txt\)/u);
    assert.equal(localConfig.includes("first"), false);
    assert.equal(localConfig.includes("second"), false);
  } finally {
    await fixture.cleanup();
  }
});

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function runPermissionAgent(options: {
  readonly fixture: Fixture;
  readonly provider: ScriptedProvider;
  readonly decide:
    | PermissionUserDecision
    | ((requestIndex: number) => PermissionUserDecision);
}): Promise<{ readonly events: readonly WebChatEvent[] }> {
  const manager = new PermissionSessionManager();
  const session = manager.createSession();
  const turn = manager.beginTurn(session.id, {
    workspace: { id: "test", name: "Test Workspace" },
    providerId: "mock-provider",
  });
  const toolTargets = options.fixture.registry.permissionTargets();
  const gateway = new PermissionGateway({
    agentMode: "do",
    permissionMode: "default",
    workspace: options.fixture.workspace,
    broker: turn.broker,
    loadRules: async () =>
      (await loadPermissionRules({
        workspaceRoot: options.fixture.root,
        toolTargets,
        locations: options.fixture.locations,
      })).rules,
    persistAllow: async (expression) => {
      await addLocalPermissionAllow({
        workspaceRoot: options.fixture.root,
        toolTargets,
        locations: options.fixture.locations,
        expression,
      });
    },
  });
  const agent = new AgentLoop(
    options.provider,
    (mode) => createModeToolPolicy(options.fixture.registry, mode),
    options.fixture.workspace,
    {
      maxIterations: 8,
      promptEnvironment: {
        workspace: { id: "test", name: "Test Workspace" },
        platform: "darwin",
        currentDate: "2026-08-29",
        timeZone: "Asia/Shanghai",
        pathSemantics: "workspace-relative-posix",
      },
      permissionGatewayForMode: () => gateway,
    },
  );
  const response = streamAgentResponse({
    request: new Request("http://localhost/api/chat", { method: "POST" }),
    agent,
    input: "执行测试写入",
    mode: "do",
    modeTurn: 1,
  });
  assert.ok(response.body);
  const events: WebChatEvent[] = [];
  let requestIndex = 0;
  for await (const event of parseWebChatEvents(readWebStream(response.body))) {
    events.push(event);
    if (event.type === "permission-requested") {
      const decision = typeof options.decide === "function"
        ? options.decide(requestIndex)
        : options.decide;
      requestIndex += 1;
      manager.resolveDecision(session.id, event.prompt.requestId, decision);
    }
  }
  manager.closeSession(session.id);
  return { events };
}

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-permission-e2e-"));
  const userDirectory = path.join(root, "test-user");
  const orbitDirectory = path.join(root, ".orbitcode");
  await mkdir(userDirectory);
  await mkdir(orbitDirectory);
  const workspace = await createWorkspaceBoundary(root);
  const registry = new ToolRegistry([readFileTool, writeFileTool]);
  const locations: PermissionConfigLocations = {
    user: path.join(userDirectory, "permissions.yaml"),
    project: path.join(orbitDirectory, "permissions.yaml"),
    local: path.join(orbitDirectory, "permissions.local.yaml"),
  };
  return {
    root,
    workspace,
    registry,
    locations,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

class ScriptedProvider implements ChatProvider {
  readonly requests: ConversationMessage[][] = [];

  constructor(private readonly scripts: readonly (readonly ModelStreamEvent[])[]) {}

  stream(
    messages: readonly ConversationMessage[],
  ): AsyncIterable<ModelStreamEvent> {
    this.requests.push(messages.map((message) => ({ ...message })));
    const script = this.scripts[this.requests.length - 1];
    if (!script) throw new Error("测试缺少 Provider 脚本。");
    return emit(script);
  }
}

function toolScript(
  id: string,
  name: "read_file" | "write_file",
  input: Readonly<Record<string, string>>,
): readonly ModelStreamEvent[] {
  return [
    {
      type: "tool-call",
      call: { id, name, argumentsJson: JSON.stringify(input) },
    },
    { type: "done", finishReason: "tool-call" },
  ];
}

function finalScript(content: string): readonly ModelStreamEvent[] {
  return [
    { type: "text-delta", text: content },
    { type: "done", finishReason: "stop" },
  ];
}

async function* emit(
  events: readonly ModelStreamEvent[],
): AsyncIterable<ModelStreamEvent> {
  yield* events;
}
