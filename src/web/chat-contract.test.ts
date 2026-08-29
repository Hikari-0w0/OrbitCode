import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeWebChatEvent,
  MAX_WEB_CHAT_MESSAGE_LENGTH,
  MAX_WEB_CHAT_MESSAGES,
  parseProviderCatalogResponse,
  parsePermissionDecisionRequest,
  parsePermissionDecisionResponse,
  parsePermissionSessionResponse,
  parsePermissionSessionUpdateRequest,
  parseWorkspaceCatalogResponse,
  parseWebChatEvents,
  parseWebChatRequest,
  WebChatContractError,
  type WebChatEvent,
} from "@/web/chat-contract";

test("接受严格的多轮请求并保留消息顺序", () => {
  const result = parseWebChatRequest({
    provider: " primary ",
    workspaceId: "project-a",
    permissionSessionId: "session-1",
    mode: "plan",
    modeTurn: 5,
    messages: [
      { role: "user", content: "第一问" },
      { role: "assistant", content: "第一答" },
      { role: "user", content: "第二问" },
    ],
  });

  assert.equal(result.provider, "primary");
  assert.equal(result.workspaceId, "project-a");
  assert.equal(result.permissionSessionId, "session-1");
  assert.equal(result.mode, "plan");
  assert.equal(result.modeTurn, 5);
  assert.deepEqual(result.messages, [
    { role: "user", content: "第一问" },
    { role: "assistant", content: "第一答" },
    { role: "user", content: "第二问" },
  ]);
});

test("拒绝未知字段、非法角色顺序和空内容", () => {
  const invalidValues: readonly unknown[] = [
    null,
    { provider: "primary", workspaceId: "project", mode: "do", modeTurn: 1, messages: [], extra: true },
    { provider: "", workspaceId: "project", mode: "do", modeTurn: 1, messages: [{ role: "user", content: "问题" }] },
    { provider: "primary", workspaceId: "project", mode: "invalid", modeTurn: 1, messages: [{ role: "user", content: "问题" }] },
    { provider: "primary", workspaceId: "project", mode: "do", modeTurn: 1, messages: [{ role: "system", content: "越界" }] },
    { provider: "primary", workspaceId: "project", mode: "do", modeTurn: 1, messages: [{ role: "assistant", content: "回答" }] },
    {
      provider: "primary",
      workspaceId: "project",
      mode: "do",
      modeTurn: 1,
      messages: [
        { role: "user", content: "问题" },
        { role: "user", content: "重复" },
      ],
    },
    { provider: "primary", workspaceId: "project", mode: "do", modeTurn: 1, messages: [{ role: "user", content: "   " }] },
    {
      provider: "primary",
      workspaceId: "project",
      mode: "do",
      modeTurn: 1,
      messages: [{ role: "user", content: "问题", extra: true }],
    },
  ];

  for (const value of invalidValues) {
    assert.throws(() => parseWebChatRequest(value), WebChatContractError);
  }
});

test("拒绝超长内容和过多历史", () => {
  assert.throws(
    () =>
      parseWebChatRequest({
        provider: "primary",
        workspaceId: "project",
        permissionSessionId: "session-1",
        mode: "do",
        modeTurn: 1,
        messages: [
          { role: "user", content: "x".repeat(MAX_WEB_CHAT_MESSAGE_LENGTH + 1) },
        ],
      }),
    /超过/,
  );

  const messages = Array.from({ length: MAX_WEB_CHAT_MESSAGES + 1 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: String(index),
  }));
  assert.throws(
    () => parseWebChatRequest({ provider: "primary", workspaceId: "project", permissionSessionId: "session-1", mode: "do", modeTurn: 1, messages }),
    /数量/,
  );
});

test("Workspace ID 必须是有界的不透明标识且不接受路径字段", () => {
  for (const workspaceId of ["", " project", "/tmp/project", "../project", "x".repeat(65)]) {
    assert.throws(
      () => parseWebChatRequest({
        provider: "primary",
        workspaceId,
        mode: "do",
        modeTurn: 1,
        messages: [{ role: "user", content: "问题" }],
      }),
      WebChatContractError,
    );
  }
  assert.throws(
    () => parseWebChatRequest({
      provider: "primary",
      workspaceId: "project",
      workspacePath: "/tmp/project",
      mode: "do",
      modeTurn: 1,
      messages: [{ role: "user", content: "问题" }],
    }),
    WebChatContractError,
  );
});

test("模式连续轮次必须是有界正整数", () => {
  for (const modeTurn of [undefined, 0, -1, 1.5, 10_001]) {
    assert.throws(
      () => parseWebChatRequest({
        provider: "primary",
        workspaceId: "project",
        mode: "do",
        modeTurn,
        messages: [{ role: "user", content: "问题" }],
      }),
      WebChatContractError,
    );
  }
});

test("严格解析权限会话、模式更新与只含枚举的授权决定", () => {
  assert.deepEqual(
    parsePermissionSessionResponse({ sessionId: "session-1", mode: "default" }),
    { sessionId: "session-1", mode: "default" },
  );
  assert.deepEqual(parsePermissionSessionUpdateRequest({ mode: "strict" }), {
    mode: "strict",
  });
  assert.deepEqual(
    parsePermissionDecisionRequest({ requestId: "request-1", decision: "allow-once" }),
    { requestId: "request-1", decision: "allow-once" },
  );
  assert.deepEqual(parsePermissionDecisionResponse({ accepted: true }), {
    accepted: true,
  });
  for (const invalid of [
    { mode: "unrestricted" },
    { requestId: "request-1", decision: "allow", parameters: {} },
    { requestId: "bad id", decision: "deny" },
  ]) {
    assert.throws(
      () =>
        "mode" in invalid
          ? parsePermissionSessionUpdateRequest(invalid)
          : parsePermissionDecisionRequest(invalid),
      WebChatContractError,
    );
  }
});

test("Web SSE 事件按网络分块往返解析", async () => {
  const expected: readonly WebChatEvent[] = [
    { type: "progress", iteration: 1, maxIterations: 8, phase: "model" },
    { type: "text-delta", iteration: 1, text: "Orbit" },
    {
      type: "tool-call",
      iteration: 1,
      call: {
        id: "call_1",
        name: "read_file",
        argumentsJson: '{"path":"README.md"}',
      },
      sequence: 0,
    },
    {
      type: "tool-started",
      iteration: 1,
      callId: "call_1",
      name: "read_file",
      sequence: 0,
    },
    {
      type: "permission-requested",
      iteration: 1,
      callId: "call_approval",
      name: "write_file",
      sequence: 1,
      prompt: {
        requestId: "request-1",
        toolCallId: "call_approval",
        toolName: "write_file",
        workspace: { id: "project", name: "Project" },
        summary: { operation: "写入", path: "src/main.ts" },
        risk: { level: "medium", message: "写入需要确认。" },
        source: "mode",
        persistentLayer: "local",
        expiresAt: "2026-08-29T00:00:00.000Z",
      },
    },
    {
      type: "permission-resolved",
      iteration: 1,
      callId: "call_approval",
      name: "write_file",
      sequence: 1,
      requestId: "request-1",
      status: "allowed",
      scope: "once",
    },
    {
      type: "tool-result",
      iteration: 1,
      callId: "call_1",
      name: "read_file",
      sequence: 0,
      result: {
        ok: true,
        output: { path: "README.md", content: "OrbitCode" },
        sideEffect: "none",
        meta: { durationMs: 3, truncated: false, truncatedFields: [] },
      },
    },
    {
      type: "token-usage",
      iteration: 1,
      usage: {
        availability: "reported",
        promptTokens: 2,
        completionTokens: 1,
        totalTokens: 3,
        promptCache: { availability: "tokens", cachedTokens: 1 },
      },
      cumulative: {
        availability: "reported",
        promptTokens: 2,
        completionTokens: 1,
        totalTokens: 3,
        promptCache: { availability: "tokens", cachedTokens: 1 },
      },
    },
    { type: "text-delta", iteration: 2, text: "Code" },
    {
      type: "stopped",
      reason: "final-response",
      iterations: 2,
      sideEffect: "none",
      finalMessage: { role: "assistant", content: "Code" },
    },
  ];
  const bytes = Buffer.concat(expected.map((event) => encodeWebChatEvent(event)));
  const chunks = [bytes.subarray(0, 9), bytes.subarray(9, 23), bytes.subarray(23)];

  const actual: WebChatEvent[] = [];
  for await (const event of parseWebChatEvents(asAsync(chunks))) {
    actual.push(event);
  }
  assert.deepEqual(actual, expected);
});

test("只接受安全的 Provider 摘要", () => {
  assert.deepEqual(
    parseProviderCatalogResponse({
      providers: [{ name: "primary", model: "model", available: true }],
    }),
    {
      providers: [{ name: "primary", model: "model", available: true }],
    },
  );
  assert.throws(
    () =>
      parseProviderCatalogResponse({
        providers: [
          {
            name: "primary",
            model: "model",
            available: true,
            apiKey: "must-not-pass",
          },
        ],
      }),
    /无效的模型配置列表/,
  );
});

test("严格解析 Workspace Catalog 且不允许路径字段", () => {
  const expected = {
    workspaces: [
      { id: "alpha", name: "项目 A", available: true, isDefault: true },
      { id: "beta", name: "项目 B", available: true, isDefault: false },
    ],
    defaultWorkspaceId: "alpha",
  } as const;
  assert.deepEqual(parseWorkspaceCatalogResponse(expected), expected);

  for (const value of [
    { workspaces: [], defaultWorkspaceId: "alpha" },
    {
      workspaces: [
        { id: "alpha", name: "A", available: true, isDefault: false },
      ],
      defaultWorkspaceId: "alpha",
    },
    {
      workspaces: [
        {
          id: "alpha",
          name: "A",
          available: true,
          isDefault: true,
          path: "/private/project",
        },
      ],
      defaultWorkspaceId: "alpha",
    },
  ]) {
    assert.throws(() => parseWorkspaceCatalogResponse(value), WebChatContractError);
  }
});

test("拒绝非法 Web SSE JSON 与事件结构", async () => {
  await assert.rejects(
    collect(parseWebChatEvents(asAsync([Buffer.from("data: nope\n\n")]))),
    /无效的流式事件/,
  );
  await assert.rejects(
    collect(
      parseWebChatEvents(
        asAsync([Buffer.from('data: {"type":"stopped","extra":true}\n\n')]),
      ),
    ),
    /无效的流式事件/,
  );
  await assert.rejects(
    collect(
      parseWebChatEvents(
        asAsync([
          Buffer.from(
            'data: {"type":"tool-started","iteration":1,"callId":"bad id","name":"read_file","sequence":0}\n\n',
          ),
        ]),
      ),
    ),
    /无效的流式事件/,
  );
  await assert.rejects(
    collect(
      parseWebChatEvents(
        asAsync([
          Buffer.from(
            'data: {"type":"stopped","reason":"final-response","iterations":1,"sideEffect":"none","detail":"失败"}\n\n',
          ),
        ]),
      ),
    ),
    /无效的流式事件/,
  );
  await assert.rejects(
    collect(
      parseWebChatEvents(
        asAsync([
          Buffer.from(
            'data: {"type":"token-usage","iteration":1,"usage":{"availability":"reported","promptTokens":2,"completionTokens":1,"totalTokens":3,"promptCache":{"availability":"tokens","cachedTokens":-1}},"cumulative":{"availability":"unavailable"}}\n\n',
          ),
        ]),
      ),
    ),
    /无效的流式事件/,
  );
});

async function* asAsync(
  chunks: readonly Uint8Array[],
): AsyncIterable<Uint8Array> {
  yield* chunks;
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<readonly T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
