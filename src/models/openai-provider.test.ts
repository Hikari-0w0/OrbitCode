import assert from "node:assert/strict";
import test from "node:test";

import { OpenAICompatibleProvider } from "@/models/openai-provider";
import { ProviderError, type ModelStreamEvent } from "@/models/provider";
import {
  DONE_EVENT,
  startOpenAIMockServer,
  textDelta,
  TEXT_FINISH_EVENT,
  toolCallDelta,
  TOOL_FINISH_EVENT,
  TRANSPORT_DONE_EVENT,
  usageEvent,
} from "../../tests/helpers/openai-mock";

async function collect(
  source: AsyncIterable<ModelStreamEvent>,
): Promise<ModelStreamEvent[]> {
  const result: ModelStreamEvent[] = [];
  for await (const event of source) {
    result.push(event);
  }
  return result;
}

test("发送正确请求并按网络分块实时产出文本", async () => {
  let doneWasSent = false;
  const server = await startOpenAIMockServer(() => ({
    chunks: [
      { data: textDelta("你").slice(0, 12) },
      { data: textDelta("你").slice(12) },
      { data: textDelta("好"), delayMs: 20 },
      {
        data: DONE_EVENT,
        delayMs: 40,
      },
    ],
  }));
  try {
    const provider = new OpenAICompatibleProvider({
      model: "test-model",
      baseUrl: `${server.baseUrl}/`,
      apiKey: "test-secret",
    });
    const iterator = provider
      .stream([{ role: "user", content: "问候" }], {
        signal: new AbortController().signal,
        toolChoice: "none",
      })
      [Symbol.asyncIterator]();

    assert.deepEqual(await iterator.next(), {
      done: false,
      value: { type: "text-delta", text: "你" },
    });
    assert.equal(doneWasSent, false);
    const remaining: ModelStreamEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      remaining.push(next.value);
      if (next.value.type === "done") {
        doneWasSent = true;
      }
    }

    assert.deepEqual(remaining, [
      { type: "text-delta", text: "好" },
      { type: "done", finishReason: "stop" },
    ]);
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].method, "POST");
    assert.equal(server.requests[0].url, "/v1/chat/completions");
    assert.equal(server.requests[0].authorization, "Bearer test-secret");
    assert.deepEqual(server.requests[0].body, {
      model: "test-model",
      messages: [{ role: "user", content: "问候" }],
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: "none",
    });
  } finally {
    await server.close();
  }
});

test("忽略合法元数据并支持一个块中的多个事件", async () => {
  const server = await startOpenAIMockServer(() => ({
    chunks: [
      {
        data:
          'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
          textDelta("文本") +
          'data: {"choices":[]}\n\n' +
          DONE_EVENT,
      },
    ],
  }));
  try {
    const provider = new OpenAICompatibleProvider({
      model: "test-model",
      baseUrl: server.baseUrl,
      apiKey: "test-secret",
    });
    assert.deepEqual(
      await collect(
        provider.stream([], {
          signal: new AbortController().signal,
          toolChoice: "none",
        }),
      ),
      [
        { type: "text-delta", text: "文本" },
        { type: "done", finishReason: "stop" },
      ],
    );
  } finally {
    await server.close();
  }
});

test("HTTP、重定向和内容类型错误不泄露响应正文", async () => {
  const sentinel = "sentinel-response-secret";
  const scenarios = [
    { status: 401, chunks: [{ data: sentinel }] },
    {
      status: 302,
      headers: { location: "https://redirect.invalid/v1" },
      chunks: [{ data: sentinel }],
    },
    {
      headers: { "content-type": "application/json" },
      chunks: [{ data: sentinel }],
    },
  ] as const;

  for (const scenario of scenarios) {
    const server = await startOpenAIMockServer(() => scenario);
    try {
      const provider = new OpenAICompatibleProvider({
        model: "test-model",
        baseUrl: server.baseUrl,
        apiKey: "test-secret",
      });
      await assert.rejects(
        collect(
          provider.stream([], {
            signal: new AbortController().signal,
            toolChoice: "none",
          }),
        ),
        (error: unknown) => {
          assert.ok(error instanceof ProviderError);
          assert.equal(error.message.includes(sentinel), false);
          return true;
        },
      );
    } finally {
      await server.close();
    }
  }
});

test("非法 JSON、非法结构、完成后事件和缺少完成标记均失败", async () => {
  const scenarios = [
    "data: not-json\n\n" + DONE_EVENT,
    'data: {"invalid":true}\n\n' + DONE_EVENT,
    DONE_EVENT + textDelta("late"),
    textDelta("truncated"),
  ];

  for (const scenario of scenarios) {
    const server = await startOpenAIMockServer(() => ({
      chunks: [{ data: scenario }],
    }));
    try {
      const provider = new OpenAICompatibleProvider({
        model: "test-model",
        baseUrl: server.baseUrl,
        apiKey: "test-secret",
      });
      await assert.rejects(
        collect(
          provider.stream([], {
            signal: new AbortController().signal,
            toolChoice: "none",
          }),
        ),
        ProviderError,
      );
    } finally {
      await server.close();
    }
  }
});

test("流截断和用户取消分别归类", async () => {
  const truncatedServer = await startOpenAIMockServer(() => ({
    chunks: [{ data: textDelta("partial") }],
    destroyAfterChunks: true,
  }));
  try {
    const provider = new OpenAICompatibleProvider({
      model: "test-model",
      baseUrl: truncatedServer.baseUrl,
      apiKey: "test-secret",
    });
    await assert.rejects(
      collect(
        provider.stream([], {
          signal: new AbortController().signal,
          toolChoice: "none",
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.kind, "stream");
        return true;
      },
    );
  } finally {
    await truncatedServer.close();
  }

  const cancelServer = await startOpenAIMockServer(() => ({
    chunks: [
      { data: textDelta("partial") },
      { data: DONE_EVENT, delayMs: 2_000 },
    ],
  }));
  try {
    const provider = new OpenAICompatibleProvider({
      model: "test-model",
      baseUrl: cancelServer.baseUrl,
      apiKey: "test-secret",
    });
    const controller = new AbortController();
    const iterator = provider
      .stream([], { signal: controller.signal, toolChoice: "none" })
      [Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, "text-delta");
    controller.abort();
    await assert.rejects(iterator.next(), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.kind, "cancelled");
      return true;
    });
  } finally {
    await cancelServer.close();
  }
});

test("连接失败被归类为可恢复网络错误", async () => {
  const closedServer = await startOpenAIMockServer(() => ({
    chunks: [{ data: DONE_EVENT }],
  }));
  const closedBaseUrl = closedServer.baseUrl;
  await closedServer.close();

  const provider = new OpenAICompatibleProvider({
    model: "test-model",
    baseUrl: closedBaseUrl,
    apiKey: "test-secret",
  });
  await assert.rejects(
    collect(
      provider.stream([], {
        signal: new AbortController().signal,
        toolChoice: "none",
      }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.kind, "network");
      assert.equal(error.message.includes("test-secret"), false);
      return true;
    },
  );
});

test("跨事件与网络分块拼接单个工具调用并发送标准定义", async () => {
  const first = toolCallDelta({
    id: "call_1",
    name: "read_",
    argumentsJson: '{"pa',
  });
  const second = toolCallDelta({ name: "file", argumentsJson: 'th":"README.md"}' });
  const server = await startOpenAIMockServer(() => ({
    chunks: [
      { data: first.slice(0, 31) },
      { data: first.slice(31) + second + TOOL_FINISH_EVENT },
      { data: TRANSPORT_DONE_EVENT },
    ],
  }));
  try {
    const provider = new OpenAICompatibleProvider({
      model: "test-model",
      baseUrl: server.baseUrl,
      apiKey: "test-secret",
    });
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "read_file",
          description: "读取文件",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
        },
      },
    ];
    assert.deepEqual(
      await collect(
        provider.stream([{ role: "user", content: "读取" }], {
          signal: new AbortController().signal,
          tools,
          toolChoice: "auto",
        }),
      ),
      [
        {
          type: "tool-call",
          call: {
            id: "call_1",
            name: "read_file",
            argumentsJson: '{"path":"README.md"}',
          },
        },
        { type: "done", finishReason: "tool-call" },
      ],
    );
    assert.deepEqual(server.requests[0].body, {
      model: "test-model",
      messages: [{ role: "user", content: "读取" }],
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: "auto",
      tools,
      parallel_tool_calls: true,
    });
  } finally {
    await server.close();
  }
});

test("按索引拼接多个工具调用并在完成后接收 Token 用量", async () => {
  const server = await startOpenAIMockServer(() => ({
    chunks: [
      {
        data:
          toolCallDelta({
            index: 0,
            id: "call_read",
            name: "read_",
            argumentsJson: '{"path":"',
          }) +
          toolCallDelta({
            index: 1,
            id: "call_search",
            name: "search_",
            argumentsJson: '{"query":"Agent',
          }),
      },
      {
        data:
          toolCallDelta({ index: 0, name: "file", argumentsJson: 'README.md"}' }) +
          toolCallDelta({ index: 1, name: "code", argumentsJson: 'Loop"}' }) +
          TOOL_FINISH_EVENT +
          usageEvent({ promptTokens: 12, completionTokens: 8, totalTokens: 20 }) +
          TRANSPORT_DONE_EVENT,
      },
    ],
  }));
  try {
    const provider = new OpenAICompatibleProvider({
      model: "test-model",
      baseUrl: server.baseUrl,
      apiKey: "test-secret",
    });
    const tools = [{
      type: "function" as const,
      function: {
        name: "read_file",
        description: "读取",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    }];
    assert.deepEqual(
      await collect(provider.stream([], {
        signal: new AbortController().signal,
        tools,
        toolChoice: "auto",
      })),
      [
        {
          type: "tool-call",
          call: {
            id: "call_read",
            name: "read_file",
            argumentsJson: '{"path":"README.md"}',
          },
        },
        {
          type: "tool-call",
          call: {
            id: "call_search",
            name: "search_code",
            argumentsJson: '{"query":"AgentLoop"}',
          },
        },
        { type: "done", finishReason: "tool-call" },
        {
          type: "usage",
          usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 },
        },
      ],
    );
  } finally {
    await server.close();
  }
});

test("最多接受十六个连续工具调用并拒绝第十七个", async () => {
  const rawCalls = (count: number): string => `data: ${JSON.stringify({
    choices: [{
      delta: {
        tool_calls: Array.from({ length: count }, (_, index) => ({
          index,
          id: `call_${index}`,
          type: "function",
          function: { name: "read_file", arguments: "{}" },
        })),
      },
    }],
  })}\n\n`;
  const server = await startOpenAIMockServer(() => ({
    chunks: [{
      data: server.requests.length === 1
        ? rawCalls(16) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT
        : rawCalls(17) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT,
    }],
  }));
  try {
    const provider = new OpenAICompatibleProvider({
      model: "test-model",
      baseUrl: server.baseUrl,
      apiKey: "test-secret",
    });
    const tools = [{
      type: "function" as const,
      function: {
        name: "read_file",
        description: "读取",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    }];

    const accepted = await collect(provider.stream([], {
      signal: new AbortController().signal,
      tools,
      toolChoice: "auto",
    }));
    assert.deepEqual(
      accepted.filter((event) => event.type === "tool-call").map((event) => event.call.id),
      Array.from({ length: 16 }, (_, index) => `call_${index}`),
    );
    await assert.rejects(
      collect(provider.stream([], {
        signal: new AbortController().signal,
        tools,
        toolChoice: "auto",
      })),
      ProviderError,
    );
  } finally {
    await server.close();
  }
});

test("缺失 Token 用量保持兼容，非法或递减用量被拒绝", async () => {
  const scenarios = [
    usageEvent({ promptTokens: 2, completionTokens: 3, totalTokens: 9 }),
    usageEvent({ promptTokens: 2, completionTokens: 3, totalTokens: 5 }) +
      usageEvent({ promptTokens: 2, completionTokens: 2, totalTokens: 4 }),
  ];
  for (const usage of scenarios) {
    const server = await startOpenAIMockServer(() => ({
      chunks: [{ data: TEXT_FINISH_EVENT + usage + TRANSPORT_DONE_EVENT }],
    }));
    try {
      const provider = new OpenAICompatibleProvider({
        model: "test-model",
        baseUrl: server.baseUrl,
        apiKey: "test-secret",
      });
      await assert.rejects(
        collect(provider.stream([], {
          signal: new AbortController().signal,
          toolChoice: "none",
        })),
        ProviderError,
      );
    } finally {
      await server.close();
    }
  }
});

test("兼容 Token 用量位于完成原因之前", async () => {
  const server = await startOpenAIMockServer(() => ({
    chunks: [{
      data:
        usageEvent({ promptTokens: 4, completionTokens: 2, totalTokens: 6 }) +
        textDelta("完成") +
        TEXT_FINISH_EVENT +
        TRANSPORT_DONE_EVENT,
    }],
  }));
  try {
    const provider = new OpenAICompatibleProvider({
      model: "test-model",
      baseUrl: server.baseUrl,
      apiKey: "test-secret",
    });
    assert.deepEqual(
      await collect(provider.stream([], {
        signal: new AbortController().signal,
        toolChoice: "none",
      })),
      [
        { type: "text-delta", text: "完成" },
        { type: "done", finishReason: "stop" },
        {
          type: "usage",
          usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
        },
      ],
    );
  } finally {
    await server.close();
  }
});

test("兼容 SiliconFlow 在文本结束 chunk 中附带 Token 用量", async () => {
  const server = await startOpenAIMockServer(() => ({
    chunks: [{
      data:
        `data: ${JSON.stringify({
          choices: [{
            delta: { content: "完成" },
            finish_reason: "stop",
          }],
          usage: {
            prompt_tokens: 4,
            completion_tokens: 2,
            total_tokens: 6,
          },
        })}\n\n` + TRANSPORT_DONE_EVENT,
    }],
  }));
  try {
    const provider = new OpenAICompatibleProvider({
      model: "test-model",
      baseUrl: server.baseUrl,
      apiKey: "test-secret",
    });
    assert.deepEqual(
      await collect(provider.stream([], {
        signal: new AbortController().signal,
        toolChoice: "none",
      })),
      [
        { type: "text-delta", text: "完成" },
        { type: "done", finishReason: "stop" },
        {
          type: "usage",
          usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
        },
      ],
    );
  } finally {
    await server.close();
  }
});

test("兼容 SiliconFlow 在工具调用结束 chunk 中附带 Token 用量", async () => {
  const server = await startOpenAIMockServer(() => ({
    chunks: [{
      data:
        `data: ${JSON.stringify({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_write",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: '{"path":"hello.txt","content":"Hello World"}',
                },
              }],
            },
            finish_reason: "tool_calls",
          }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 8,
            total_tokens: 18,
          },
        })}\n\n` + TRANSPORT_DONE_EVENT,
    }],
  }));
  try {
    const provider = new OpenAICompatibleProvider({
      model: "test-model",
      baseUrl: server.baseUrl,
      apiKey: "test-secret",
    });
    assert.deepEqual(
      await collect(provider.stream([], {
        signal: new AbortController().signal,
        toolChoice: "auto",
        tools: [{
          type: "function",
          function: {
            name: "write_file",
            description: "写入文件",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" },
                content: { type: "string" },
              },
              required: ["path", "content"],
              additionalProperties: false,
            },
          },
        }],
      })),
      [
        {
          type: "tool-call",
          call: {
            id: "call_write",
            name: "write_file",
            argumentsJson: '{"path":"hello.txt","content":"Hello World"}',
          },
        },
        { type: "done", finishReason: "tool-call" },
        {
          type: "usage",
          usage: { promptTokens: 10, completionTokens: 8, totalTokens: 18 },
        },
      ],
    );
  } finally {
    await server.close();
  }
});

test("兼容 SiliconFlow 用空响应选项承载尾随 Token 用量", async () => {
  const server = await startOpenAIMockServer(() => ({
    chunks: [{
      data:
        toolCallDelta({
          id: "call_write",
          name: "write_file",
          argumentsJson: '{"path":"hello.txt","content":"hello world"}',
        }) +
        TOOL_FINISH_EVENT +
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: null }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 8,
            total_tokens: 18,
          },
        })}\n\n` +
        TRANSPORT_DONE_EVENT,
    }],
  }));
  try {
    const provider = new OpenAICompatibleProvider({
      model: "test-model",
      baseUrl: server.baseUrl,
      apiKey: "test-secret",
    });
    assert.deepEqual(
      await collect(provider.stream([], {
        signal: new AbortController().signal,
        toolChoice: "auto",
        tools: [{
          type: "function",
          function: {
            name: "write_file",
            description: "写入文件",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" },
                content: { type: "string" },
              },
              required: ["path", "content"],
              additionalProperties: false,
            },
          },
        }],
      })),
      [
        {
          type: "tool-call",
          call: {
            id: "call_write",
            name: "write_file",
            argumentsJson: '{"path":"hello.txt","content":"hello world"}',
          },
        },
        { type: "done", finishReason: "tool-call" },
        {
          type: "usage",
          usage: { promptTokens: 10, completionTokens: 8, totalTokens: 18 },
        },
      ],
    );
  } finally {
    await server.close();
  }
});

test("将 SiliconFlow 每个增量携带的累计 Token 用量归一为最终值", async () => {
  const event = (
    delta: Record<string, unknown>,
    completionTokens: number,
    finishReason: string | null = null,
  ): string => `data: ${JSON.stringify({
    choices: [{ delta, finish_reason: finishReason }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: completionTokens,
      total_tokens: 10 + completionTokens,
    },
  })}\n\n`;
  const server = await startOpenAIMockServer(() => ({
    chunks: [{
      data:
        event({ role: "assistant", content: "" }, 0) +
        event({ content: "", reasoning_content: "分析" }, 1) +
        event({
          content: "",
          tool_calls: [{
            index: 0,
            id: "call_write",
            type: "function",
            function: {
              name: "write_file",
              arguments: '{"path":"hello.txt",',
            },
          }],
        }, 4) +
        event({
          content: "",
          tool_calls: [{
            index: 0,
            id: null,
            type: "function",
            function: { name: null, arguments: '"content":"Hello World"}' },
          }],
        }, 8) +
        event({ content: "" }, 8, "tool_calls") +
        usageEvent({ promptTokens: 10, completionTokens: 8, totalTokens: 18 }) +
        TRANSPORT_DONE_EVENT,
    }],
  }));
  try {
    const provider = new OpenAICompatibleProvider({
      model: "test-model",
      baseUrl: server.baseUrl,
      apiKey: "test-secret",
    });
    assert.deepEqual(
      await collect(provider.stream([], {
        signal: new AbortController().signal,
        toolChoice: "auto",
        tools: [{
          type: "function",
          function: {
            name: "write_file",
            description: "写入文件",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" },
                content: { type: "string" },
              },
              required: ["path", "content"],
              additionalProperties: false,
            },
          },
        }],
      })),
      [
        {
          type: "tool-call",
          call: {
            id: "call_write",
            name: "write_file",
            argumentsJson: '{"path":"hello.txt","content":"Hello World"}',
          },
        },
        { type: "done", finishReason: "tool-call" },
        {
          type: "usage",
          usage: { promptTokens: 10, completionTokens: 8, totalTokens: 18 },
        },
      ],
    );
  } finally {
    await server.close();
  }
});

test("兼容未结束的文本增量携带累计 Token 用量", async () => {
  const server = await startOpenAIMockServer(() => ({
    chunks: [{
      data:
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "尚未" }, finish_reason: null }],
          usage: {
            prompt_tokens: 4,
            completion_tokens: 2,
            total_tokens: 6,
          },
        })}\n\n` +
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "完成" }, finish_reason: null }],
          usage: {
            prompt_tokens: 4,
            completion_tokens: 3,
            total_tokens: 7,
          },
        })}\n\n` +
        TEXT_FINISH_EVENT +
        TRANSPORT_DONE_EVENT,
    }],
  }));
  try {
    const provider = new OpenAICompatibleProvider({
      model: "test-model",
      baseUrl: server.baseUrl,
      apiKey: "test-secret",
    });
    assert.deepEqual(
      await collect(provider.stream([], {
        signal: new AbortController().signal,
        toolChoice: "none",
      })),
      [
        { type: "text-delta", text: "尚未" },
        { type: "text-delta", text: "完成" },
        { type: "done", finishReason: "stop" },
        {
          type: "usage",
          usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 },
        },
      ],
    );
  } finally {
    await server.close();
  }
});

test("兼容后续工具分片用 null 表示未提供字段", async () => {
  const server = await startOpenAIMockServer(() => ({
    chunks: [{
      data:
        toolCallDelta({ id: "call_null", name: "read_file", argumentsJson: '{"path":' }) +
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":null,"type":"function","function":{"name":null,"arguments":"\\"README.md\\"}"}}]}}]}\n\n' +
        TOOL_FINISH_EVENT +
        TRANSPORT_DONE_EVENT,
    }],
  }));
  try {
    const provider = new OpenAICompatibleProvider({
      model: "test-model",
      baseUrl: server.baseUrl,
      apiKey: "test-secret",
    });
    const tools = [{
      type: "function" as const,
      function: {
        name: "read_file",
        description: "读取",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    }];
    assert.deepEqual(
      await collect(provider.stream([], {
        signal: new AbortController().signal,
        tools,
        toolChoice: "auto",
      })),
      [
        {
          type: "tool-call",
          call: {
            id: "call_null",
            name: "read_file",
            argumentsJson: '{"path":"README.md"}',
          },
        },
        { type: "done", finishReason: "tool-call" },
      ],
    );
  } finally {
    await server.close();
  }
});

test("兼容单工具分片省略索引或用 null 表示索引", async () => {
  const tools = [{
    type: "function" as const,
    function: {
      name: "read_file",
      description: "读取",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  }];
  const scenarios = [
    {
      tool_calls: [{
        id: "call_missing_index",
        type: "function",
        function: { name: "read_file", arguments: "{}" },
      }],
      expectedId: "call_missing_index",
    },
    {
      tool_calls: [{
        index: null,
        id: "call_null_index",
        type: "function",
        function: { name: "read_file", arguments: "{}" },
      }],
      expectedId: "call_null_index",
    },
  ] as const;

  for (const scenario of scenarios) {
    const toolDelta = `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: scenario.tool_calls } }],
    })}\n\n`;
    const server = await startOpenAIMockServer(() => ({
      chunks: [{ data: toolDelta + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT }],
    }));
    try {
      const provider = new OpenAICompatibleProvider({
        model: "test-model",
        baseUrl: server.baseUrl,
        apiKey: "test-secret",
      });
      assert.deepEqual(
        await collect(provider.stream([], {
          signal: new AbortController().signal,
          tools,
          toolChoice: "auto",
        })),
        [
          {
            type: "tool-call",
            call: {
              id: scenario.expectedId,
              name: "read_file",
              argumentsJson: "{}",
            },
          },
          { type: "done", finishReason: "tool-call" },
        ],
      );
    } finally {
      await server.close();
    }
  }
});

test("兼容说明文本与单个工具调用出现在同一响应", async () => {
  const server = await startOpenAIMockServer(() => ({
    chunks: [{
      data:
        textDelta("我来查看项目。") +
        toolCallDelta({
          id: "call_mixed",
          name: "read_file",
          argumentsJson: '{"path":"README.md"}',
        }) +
        textDelta("正在读取。") +
        TOOL_FINISH_EVENT +
        TRANSPORT_DONE_EVENT,
    }],
  }));
  try {
    const provider = new OpenAICompatibleProvider({
      model: "test-model",
      baseUrl: server.baseUrl,
      apiKey: "test-secret",
    });
    const tools = [{
      type: "function" as const,
      function: {
        name: "read_file",
        description: "读取",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    }];
    assert.deepEqual(
      await collect(provider.stream([], {
        signal: new AbortController().signal,
        tools,
        toolChoice: "auto",
      })),
      [
        { type: "text-delta", text: "我来查看项目。" },
        { type: "text-delta", text: "正在读取。" },
        {
          type: "tool-call",
          call: {
            id: "call_mixed",
            name: "read_file",
            argumentsJson: '{"path":"README.md"}',
          },
        },
        { type: "done", finishReason: "tool-call" },
      ],
    );
  } finally {
    await server.close();
  }
});

test("禁用工具时拒绝工具响应，且工具消息按协议序列化", async () => {
  const server = await startOpenAIMockServer(() => ({
    chunks: [
      {
        data:
          toolCallDelta({ id: "call_2", name: "read_file", argumentsJson: "{}" }) +
          TOOL_FINISH_EVENT +
          TRANSPORT_DONE_EVENT,
      },
    ],
  }));
  try {
    const provider = new OpenAICompatibleProvider({
      model: "test-model",
      baseUrl: server.baseUrl,
      apiKey: "test-secret",
    });
    await assert.rejects(
      collect(
        provider.stream(
          [
            {
              role: "assistant",
              content: null,
              toolCalls: [
                { id: "call_1", name: "read_file", argumentsJson: '{"path":"a"}' },
              ],
            },
            { role: "tool", toolCallId: "call_1", content: '{"ok":true}' },
          ],
          { signal: new AbortController().signal, toolChoice: "none" },
        ),
      ),
      /禁用工具/,
    );
    assert.deepEqual((server.requests[0].body as { messages: unknown }).messages, [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: '{"ok":true}' },
    ]);
  } finally {
    await server.close();
  }
});

test("拒绝冲突/重复/不安全标识、错误索引、超长参数和错误完成原因", async () => {
  const raw = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
  const indexed = raw({
    choices: [{
      delta: {
        tool_calls: [{
          index: 1,
          id: "bad-index",
          type: "function",
          function: { name: "read_file", arguments: "{}" },
        }],
      },
    }],
  });
  const scenarios = [
    toolCallDelta({ id: "one", name: "read_file", argumentsJson: "{}" }) +
      toolCallDelta({ id: "two" }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT,
    toolCallDelta({ name: "read_file", argumentsJson: "{}" }) +
      TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT,
    indexed + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT,
    toolCallDelta({
      index: 0,
      id: "duplicate",
      name: "read_file",
      argumentsJson: "{}",
    }) + toolCallDelta({
      index: 1,
      id: "duplicate",
      name: "read_file",
      argumentsJson: "{}",
    }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT,
    toolCallDelta({ id: "unsafe id", name: "read_file", argumentsJson: "{}" }) +
      TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT,
    toolCallDelta({ id: "safe_id", name: "../write_file", argumentsJson: "{}" }) +
      TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT,
    toolCallDelta({
      id: "too_large",
      name: "read_file",
      argumentsJson: "x".repeat(64 * 1024 + 1),
    }) + TOOL_FINISH_EVENT + TRANSPORT_DONE_EVENT,
    toolCallDelta({ id: "wrong_finish", name: "read_file", argumentsJson: "{}" }) +
      DONE_EVENT,
  ];
  const tools = [{
    type: "function" as const,
    function: {
      name: "read_file",
      description: "读取文件",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  }];

  for (const scenario of scenarios) {
    const server = await startOpenAIMockServer(() => ({ chunks: [{ data: scenario }] }));
    try {
      const provider = new OpenAICompatibleProvider({
        model: "test-model",
        baseUrl: server.baseUrl,
        apiKey: "test-secret",
      });
      await assert.rejects(
        collect(provider.stream([], {
          signal: new AbortController().signal,
          tools,
          toolChoice: "auto",
        })),
        ProviderError,
      );
    } finally {
      await server.close();
    }
  }
});
