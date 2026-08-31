import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeWebChatEvent,
  MAX_WEB_CHAT_INPUT_LENGTH,
  parseContextCompressionResponse,
  parseConversationCatalogResponse,
  parseConversationCreateRequest,
  parseConversationDetailResponse,
  parseConversationMutationRequest,
  parseConversationRenameRequest,
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

test("接受只携带本轮输入、持久化会话修订和权限会话的请求", () => {
  const result = parseWebChatRequest({
    conversationId: "conversation-1",
    revision: 7,
    permissionSessionId: "session-1",
    mode: "plan",
    modeTurn: 5,
    input: "第二问",
  });

  assert.equal(result.conversationId, "conversation-1");
  assert.equal(result.revision, 7);
  assert.equal(result.permissionSessionId, "session-1");
  assert.equal(result.mode, "plan");
  assert.equal(result.modeTurn, 5);
  assert.equal(result.input, "第二问");
});

test("拒绝未知字段、缺失会话标识和空输入", () => {
  const valid = {
    conversationId: "conversation-1",
    revision: 0,
    permissionSessionId: "permission-1",
    mode: "do",
    modeTurn: 1,
    input: "问题",
  } as const;
  const invalidValues: readonly unknown[] = [
    null,
    { ...valid, extra: true },
    { ...valid, conversationId: "" },
    { ...valid, revision: -1 },
    { ...valid, permissionSessionId: "bad id" },
    { ...valid, mode: "invalid" },
    { ...valid, input: "   " },
    { ...valid, messages: [{ role: "user", content: "旧协议" }] },
  ];

  for (const value of invalidValues) {
    assert.throws(() => parseWebChatRequest(value), WebChatContractError);
  }
});

test("拒绝超长用户输入", () => {
  assert.throws(
    () =>
      parseWebChatRequest({
        conversationId: "conversation-1",
        revision: 0,
        permissionSessionId: "session-1",
        mode: "do",
        modeTurn: 1,
        input: "x".repeat(MAX_WEB_CHAT_INPUT_LENGTH + 1),
      }),
    /超过/,
  );
});

test("Conversation ID 必须是有界的不透明标识且不接受路径字段", () => {
  for (const conversationId of ["", " project", "/tmp/project", "../project", "x".repeat(129)]) {
    assert.throws(
      () => parseWebChatRequest({
        conversationId,
        revision: 0,
        permissionSessionId: "permission-1",
        mode: "do",
        modeTurn: 1,
        input: "问题",
      }),
      WebChatContractError,
    );
  }
  assert.throws(
    () => parseWebChatRequest({
      conversationId: "conversation-1",
      revision: 0,
      permissionSessionId: "permission-1",
      workspacePath: "/tmp/project",
      mode: "do",
      modeTurn: 1,
      input: "问题",
    }),
    WebChatContractError,
  );
});

test("模式连续轮次必须是有界正整数", () => {
  for (const modeTurn of [undefined, 0, -1, 1.5, 10_001]) {
    assert.throws(
      () => parseWebChatRequest({
        conversationId: "conversation-1",
        revision: 0,
        permissionSessionId: "permission-1",
        mode: "do",
        modeTurn,
        input: "问题",
      }),
      WebChatContractError,
    );
  }
});

test("严格解析手动压缩结果", () => {
  assert.deepEqual(
    parseContextCompressionResponse({
      status: "succeeded",
      trigger: "manual",
      before: { tokens: 18_000, source: "approximation" },
      after: { tokens: 6_000, source: "approximation" },
    }),
    {
      status: "succeeded",
      trigger: "manual",
      before: { tokens: 18_000, source: "approximation" },
      after: { tokens: 6_000, source: "approximation" },
    },
  );
  assert.throws(
    () => parseContextCompressionResponse({ status: "succeeded", trigger: "auto" }),
    WebChatContractError,
  );
});

test("会话 API 只向浏览器返回显示检查点且严格校验修改请求", () => {
  const summary = {
    schemaVersion: 1,
    id: "conversation-1",
    title: "持久化会话",
    revision: 2,
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:01:00.000Z",
    workspaceId: "project",
    providerId: "primary",
  } as const;
  assert.equal(parseConversationCatalogResponse({ conversations: [summary] }).conversations[0]?.id, "conversation-1");
  const detail = {
    schemaVersion: 1,
    summary,
    mode: "do",
    modeTurn: 1,
    displayMessages: [
      { id: "user-1", role: "user", content: "继续", state: "complete" },
    ],
    availability: "ready",
    activity: { status: "idle" },
  } as const;
  assert.equal(parseConversationDetailResponse(detail).summary.revision, 2);
  assert.throws(
    () => parseConversationDetailResponse({
      ...detail,
      context: { messages: [{ kind: "assistant", content: "不得下发" }] },
    }),
    WebChatContractError,
  );
  assert.deepEqual(
    parseConversationCreateRequest({ providerId: " primary ", workspaceId: "project" }),
    { providerId: "primary", workspaceId: "project" },
  );
  assert.deepEqual(parseConversationMutationRequest({ expectedRevision: 2 }), { expectedRevision: 2 });
  assert.deepEqual(
    parseConversationRenameRequest({ expectedRevision: 2, title: " 新标题 " }),
    { expectedRevision: 2, title: "新标题" },
  );
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
      durationMs: 1_234,
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

test("授权请求作为长等待前最后一帧时会强制刷新 SSE 缓冲", async () => {
  const event: WebChatEvent = {
    type: "permission-requested",
    iteration: 1,
    callId: "call-approval",
    name: "run_command",
    sequence: 0,
    prompt: {
      requestId: "request-1",
      toolCallId: "call-approval",
      toolName: "run_command",
      workspace: { id: "project", name: "Project" },
      summary: {
        operation: "执行命令",
        command: "node --version && npm --version",
        cwd: ".",
      },
      risk: { level: "high", message: "命令需要确认。" },
      source: "mode",
      persistentLayer: "local",
      expiresAt: "2026-08-31T06:00:00.000Z",
    },
  };

  const encoded = encodeWebChatEvent(event);
  assert.ok(encoded.byteLength >= 2_048);

  const actual: WebChatEvent[] = [];
  for await (const item of parseWebChatEvents(asAsync([encoded]))) actual.push(item);
  assert.deepEqual(actual, [event]);
});

test("Web SSE 接受 unlimited、长迭代序号和运行时间停止", async () => {
  const expected: readonly WebChatEvent[] = [
    {
      type: "progress",
      iteration: 33,
      maxIterations: "unlimited",
      phase: "model",
    },
    {
      type: "stopped",
      reason: "max-runtime",
      iterations: 33,
      durationMs: 60_000,
      sideEffect: "none",
      detail: "Agent 已达到最大运行时间 1 分钟。",
    },
  ];
  const stream = (async function* () {
    for (const event of expected) yield encodeWebChatEvent(event);
  })();
  const actual = [];
  for await (const event of parseWebChatEvents(stream)) actual.push(event);
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
