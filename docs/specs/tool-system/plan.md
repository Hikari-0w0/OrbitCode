# 单次工具调用系统 Plan

状态：已批准
依据：已批准的 `spec.md`

## 架构概览

本轮在现有纯文本对话旁新增一条“单次工具编排”路径，不把工具循环塞进页面或现有 CLI 会话。整体依赖方向为：

```text
Web 页面
  → Web SSE 契约
    → Next.js Route Handler
      → SingleToolAgent（单次状态机）
        ├→ ChatProvider（模型抽象）
        │   └→ OpenAICompatibleProvider（SSE / Tool Calling）
        └→ ToolRegistry（定义、校验、执行）
            ├→ WorkspaceBoundary（路径、敏感文件、原子文件操作）
            ├→ 六个具体工具
            └→ CommandSandbox
                └→ MacOsSeatbeltCommandSandbox
```

`src/core/` 只编排模型与工具抽象，不依赖 React、Next.js 或 OpenAI SSE 细节。`src/models/` 负责模型消息、工具定义传输和流式响应解析。`src/tools/` 负责参数 Schema、注册、工作区边界及本地执行。Web Route 只组装服务端依赖并把核心事件转换为浏览器 SSE；客户端只维护显示状态和成功完成的普通对话历史。

现有 `InMemoryConversationSession` 继续服务 CLI 纯文本对话。Web 改用新的 `SingleToolAgent`，避免在尚未要求 CLI Tool Calling 的情况下扩大现有入口行为。

## 需求映射

| 需求 | 负责模块/交互 | 设计说明 |
| --- | --- | --- |
| F1 | `src/tools/schema.ts`、`types.ts`、`registry.ts`、`default-registry.ts` | 自研声明式 Schema 同时提供类型推导、运行时解析和 OpenAI JSON Schema；注册中心拒绝重复定义并提供枚举、查找和统一执行。 |
| F2 | `src/tools/read-file.ts`、`workspace.ts` | 通过工作区边界打开普通 UTF-8 文件，执行大小、敏感路径和符号链接检查，返回内容及截断/大小元数据。 |
| F3 | `src/tools/write-file.ts`、`workspace.ts` | 校验现有父目录与目标后，在同目录写临时文件并原子替换；失败时清理临时文件。 |
| F4 | `src/tools/edit-file.ts`、`workspace.ts` | 读取快照、计算唯一匹配、验证目标未并发变化后原子替换；零次、多次和无变化均为结构化冲突。 |
| F5 | `src/tools/run-command.ts`、`command-sandbox.ts`、`macos-seatbelt-sandbox.ts` | 通过严格隔离后端运行 shell 命令，收集并限制 stdout/stderr，保留退出码、终止信号、超时和取消。 |
| F6 | `src/tools/find-files.ts`、`glob.ts`、`workspace.ts` | 自研受限 Glob 匹配器和安全目录遍历返回排序后的相对路径，不跟随符号链接。 |
| F7 | `src/tools/search-code.ts`、`glob.ts`、`workspace.ts` | 对安全遍历得到的 UTF-8 文本执行有界字面量搜索，返回路径、行列和截断片段。 |
| F8 | `src/tools/schema.ts`、`registry.ts` | 注册中心在调用具体工具前用同一 Schema 解析未知输入；失败直接生成 `invalid-arguments`，不调用执行方法。 |
| F9 | `src/tools/workspace.ts`、`protected-paths.ts` | 统一校验相对路径、真实根目录、每级符号链接、目标身份及敏感路径；文件工具不自行拼接或信任路径。 |
| F10 | `src/tools/command-sandbox.ts`、`macos-seatbelt-sandbox.ts` | Seatbelt 默认拒绝，按最小集合开放工作区、系统运行资源和进程能力；过滤环境并做首次逃逸自检，失败不执行命令。 |
| F11 | `src/tools/registry.ts`、各工具、命令沙箱 | 注册中心组合调用方取消信号与工具超时；遍历工具协作取消，命令工具终止整个进程组并输出统一终态。 |
| F12 | `src/models/provider.ts`、`openai-provider.ts` | Provider 请求接受工具定义；OpenAI 适配器按 `index` 与调用标识累计名称和参数片段，并发送 `parallel_tool_calls: false`。 |
| F13 | `src/models/openai-provider.ts` | 严格验证 `choices`、`delta`、`finish_reason`、调用索引/标识/名称和响应模式；不确定或多个调用均抛出协议错误。 |
| F14 | `src/core/single-tool-agent.ts` | 第一次模型响应在“纯文本完成”和“一个工具调用”间分支；工具分支执行后构造当前轮内部工具消息，再发起最终文本请求。 |
| F15 | `src/core/single-tool-agent.ts`、`src/models/openai-provider.ts` | 第二次请求不提供工具并要求文本终止；任何工具调用或非正常完成均终止，不进入第三次模型请求。 |
| F16 | `src/tools/types.ts`、`registry.ts`、`src/core/single-tool-agent.ts` | 参数、权限、工具和命令失败均统一成可序列化结果供第二次模型请求使用；用户取消被提升为轮次取消，不继续请求模型。 |
| F17 | `src/core/single-tool-agent.ts`、`src/web/chat-contract.ts`、`src/components/message-list.tsx` | 核心产生工具开始/完成事件，Web 契约严格解析，消息组件在助手消息内展示工具卡片和受限结果。 |
| F18 | `src/core/single-tool-agent.ts`、`src/components/chat-workspace.tsx` | 只有最终文本成功后提交普通历史；副作用风险随失败事件传到 UI，内部工具消息不由浏览器持久化。 |
| F19 | Route Handler、`src/web/chat-handler.ts`、`SingleToolAgent`、注册中心、命令沙箱、客户端 | 请求信号贯穿模型与工具；ReadableStream 取消时触发统一 Abort，所有层在 `finally` 中释放读取器、计时器、监听器和子进程。 |

## 核心类型与接口

### 工具 Schema 与定义

```ts
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export interface ToolInputSchema<TInput> {
  readonly jsonSchema: JsonObject;
  parse(value: unknown): SchemaParseResult<TInput>;
}

export type SchemaParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly SchemaIssue[] };

export interface Tool<TInput, TOutput extends JsonValue> {
  readonly name: ToolName;
  readonly description: string;
  readonly inputSchema: ToolInputSchema<TInput>;
  readonly mutability: "read-only" | "workspace-write" | "command";
  execute(
    input: TInput,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult<TOutput>>;
}

export interface ModelToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: JsonObject;
  };
}
```

Schema DSL 只实现六个工具所需的闭集：严格对象、字符串、布尔值和有界整数，支持必填/可选、长度/范围与枚举约束；对象一律输出 `additionalProperties: false`。每个工具的 TypeScript 输入类型从 Schema 声明推导，不再手写一套重复接口。Schema 的 `parse` 与 `jsonSchema` 从同一声明节点生成，满足单一事实来源。

工具名称固定为：

```ts
export type ToolName =
  | "read_file"
  | "write_file"
  | "edit_file"
  | "run_command"
  | "find_files"
  | "search_code";
```

### 工具结果与注册中心

```ts
export type ToolErrorKind =
  | "invalid-arguments"
  | "not-found"
  | "permission-denied"
  | "protected-path"
  | "conflict"
  | "unsupported-content"
  | "limit-exceeded"
  | "sandbox-unavailable"
  | "command-failed"
  | "timeout"
  | "cancelled"
  | "execution-failed";

export type SideEffectState = "none" | "possible" | "applied";

export type ToolExecutionResult<TOutput extends JsonValue = JsonValue> =
  | {
      readonly ok: true;
      readonly output: TOutput;
      readonly sideEffect: SideEffectState;
      readonly meta: ToolResultMeta;
    }
  | {
      readonly ok: false;
      readonly error: ToolExecutionError;
      readonly output?: TOutput;
      readonly sideEffect: SideEffectState;
      readonly meta: ToolResultMeta;
    };

export interface ToolRegistry {
  definitions(): readonly ModelToolDefinition[];
  has(name: string): name is ToolName;
  execute(
    name: string,
    rawArguments: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}

export interface ToolExecutionContext {
  readonly workspace: WorkspaceBoundary;
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
}
```

`ToolResultMeta` 至少包含持续时间、是否截断以及被截断字段；不得包含绝对路径、内部异常、环境变量或未经清洗的系统错误。错误 `message` 面向模型和本地用户，`retryable` 表示模型是否可通过调整参数恢复。未知异常只映射到安全的 `execution-failed`。

命令非零退出使用 `ok: false` 与 `command-failed`，但 `output` 仍包含完整的有界命令终态。命令启动后即将 `sideEffect` 设为 `possible`；文件写入原子提交后为 `applied`。只读工具始终为 `none`。

### 工作区边界

```ts
export interface ResolvedWorkspacePath {
  readonly absolutePath: string;
  readonly relativePath: string;
}

export interface WorkspaceBoundary {
  readonly root: string;
  resolveExistingFile(path: string): Promise<ResolvedWorkspacePath>;
  resolveExistingDirectory(path?: string): Promise<ResolvedWorkspacePath>;
  resolveWriteTarget(path: string): Promise<ResolvedWorkspacePath>;
  walk(options: WalkOptions): AsyncIterable<WorkspaceEntry>;
  readTextFile(path: string, options: ReadLimits): Promise<TextFileSnapshot>;
  atomicWrite(target: ResolvedWorkspacePath, content: string): Promise<void>;
  replaceSnapshot(snapshot: TextFileSnapshot, content: string): Promise<void>;
}
```

边界对象在构造时把授权根目录解析为真实绝对路径。所有外部路径必须是规范化相对路径；拒绝空路径、绝对路径、NUL、`..`、平台分隔符歧义和过长路径。遍历不跟随任何符号链接；直接操作符号链接也拒绝。已有文件记录设备号、inode、大小和修改时间，写入提交前重新核对，发现身份或内容快照变化即返回冲突。

写入在目标同目录创建随机、独占的临时文件，完整写入并关闭后原子重命名；清理逻辑放在 `finally`。覆盖时保留合理的原文件权限，不继承凭据或目录权限。修改工具通过 `replaceSnapshot` 防止读取后被并发替换。

敏感路径策略集中维护，默认拒绝：`.env`、`.env.*`（允许 `.env.example`）、`orbitcode.yaml`、`.npmrc`、`.netrc`、`.git-credentials`、`auth.json`，以及 `.pem`、`.key`、`.p12`、`.pfx` 结尾的文件。目录遍历直接跳过这些目标，错误与结果只显示安全相对路径和拒绝类别。

### 六个工具契约

```ts
type ReadFileInput = { readonly path: string };
type WriteFileInput = { readonly path: string; readonly content: string };
type EditFileInput = {
  readonly path: string;
  readonly old_text: string;
  readonly new_text: string;
};
type RunCommandInput = {
  readonly command: string;
  readonly cwd?: string;
  readonly timeout_ms?: number;
};
type FindFilesInput = {
  readonly pattern: string;
  readonly path?: string;
};
type SearchCodeInput = {
  readonly query: string;
  readonly path?: string;
  readonly file_pattern?: string;
  readonly case_sensitive?: boolean;
};
```

- `read_file`：最大读取 512 KiB；超过上限返回 `limit-exceeded`，不返回部分文件，避免模型把截断内容误认为完整文件。
- `write_file`：内容最大 512 KiB；父目录必须存在；完整创建或覆盖。
- `edit_file`：目标最大 512 KiB；`old_text` 必须非空且恰好匹配一次，`new_text` 可为空；快照冲突不重试。
- `run_command`：命令最大 8 KiB；默认 30 秒，允许 100–120,000 ms；stdout 与 stderr 各保留前 128 KiB并分别标记截断；调用方取消优先于超时。
- `find_files`：Glob 最大 512 字符，支持字面字符、`*`、`?` 和跨目录 `**`；最多返回 1,000 个普通文件路径，稳定按 Unicode 码点排序并标记截断。
- `search_code`：`query` 是 1–1,024 字符的字面量，不接受正则；`file_pattern` 使用同一 Glob 子集；单文件最大扫描 1 MiB，最多返回 500 条匹配，每条包含相对路径、1 基行列和最多 500 字符的行片段，超限字段带截断信息。

目录遍历默认跳过 `.git`、`node_modules`、`.next`、`dist`、`build`、`coverage` 以及敏感路径，以避免无界扫描；若起始路径本身处于跳过或保护范围则返回明确拒绝。Glob 编译器只生成线性、受限的内部匹配逻辑，不执行模型提供的 JavaScript 正则。

所有文件/遍历工具默认 10 秒，单工具最长不超过 120 秒。遍历循环按固定批次检查 `AbortSignal`，以便及时取消。

### 命令沙箱

```ts
export interface CommandRequest {
  readonly command: string;
  readonly cwd: ResolvedWorkspacePath;
  readonly timeoutMs: number;
  readonly outputLimitBytes: number;
}

export interface CommandExecution {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly terminationSignal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface CommandSandbox {
  probe(workspace: WorkspaceBoundary): Promise<SandboxAvailability>;
  run(
    request: CommandRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<CommandExecution>;
}
```

本轮实现 `MacOsSeatbeltCommandSandbox`：

1. 只在 `darwin` 且 `/usr/bin/sandbox-exec` 是预期的系统普通文件时可候选启用。
2. 首次命令前运行一次真实能力探测并缓存结果：工作区普通文件读写必须成功；工作区外哨兵文件读写、敏感文件读取、继承密钥环境变量和子进程逃逸必须失败。任一断言不成立则整个命令后端标记为不可用。
3. 每次执行生成经过真实对抗探测的 Seatbelt profile：默认允许命令所需的系统运行资源，显式拒绝网络，并拒绝工作区外的用户数据根目录、系统临时数据和其他挂载卷；只对授权工作区及 Node 运行时根开放必要访问。敏感文件始终显式拒绝，HOME/TMPDIR 指向工作区内当前执行专属目录。当前 macOS 上纯 deny-by-default profile 会使系统 shell 在启动阶段异常终止，因此以“系统资源允许 + 用户数据显式拒绝”的等效边界实现严格隔离。
4. 服务端仅传入固定最小环境：受控 `PATH`、`LANG`、`LC_ALL`、`HOME`、`TMPDIR`。不继承 API Key、Provider 配置变量或其他完整 `process.env`。
5. 使用参数数组调用 `/usr/bin/sandbox-exec` 和 `/bin/sh -c`，不把 profile、路径或命令拼接成外层 shell 字符串；模型命令只是 `sh -c` 的单个参数。
6. 子进程作为独立进程组启动。取消或超时先向进程组发送 `SIGTERM`，短暂宽限后仍存活则发送 `SIGKILL`；持续读取但丢弃超过上限的输出，避免管道阻塞。
7. Seatbelt 策略与子进程继承共同约束后代进程。运行时出现沙箱拒绝、启动异常或清理异常时返回安全错误，不回显 profile、绝对路径或系统诊断全文。

`sandbox-exec` 在当前 macOS 26.5.2 环境存在但被系统标记为 deprecated。为避免把弃用工具当作永久保证，后端必须始终通过能力探测而不是版本判断；未来可新增 Linux/容器后端实现同一接口。当前后端不可用时 `run_command` 返回 `sandbox-unavailable`，不会退化为普通 `spawn`。

### 模型消息与 Provider

```ts
export type ConversationMessage =
  | { readonly role: "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: null;
      readonly toolCalls: readonly [ModelToolCall];
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly content: string;
    };

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly argumentsJson: string;
}

export type ModelStreamEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "tool-call"; readonly call: ModelToolCall }
  | { readonly type: "done"; readonly finishReason: "stop" | "tool-call" };

export interface ChatProvider {
  stream(
    messages: readonly ConversationMessage[],
    options: {
      readonly signal: AbortSignal;
      readonly tools?: readonly ModelToolDefinition[];
      readonly toolChoice: "auto" | "none";
    },
  ): AsyncIterable<ModelStreamEvent>;
}
```

OpenAI 请求层负责把领域消息转换成 wire format：助手工具调用使用 `tool_calls`，工具结果使用 `role: tool`、`tool_call_id` 和序列化 JSON 内容。第一次请求传六个定义、`tool_choice: "auto"`、`parallel_tool_calls: false`；第二次请求不传工具定义并使用 `tool_choice: "none"`。纯文本 CLI 调用也使用 `toolChoice: "none"`。

OpenAI 增量解析器维护单个响应累加器：

- 文本模式只接受字符串 `content` 片段，结束原因为 `stop`。
- 工具模式只接受索引 `0` 的一个调用；`id` 必须出现且后续一致，`function.name` 与 `arguments` 字符串片段按事件顺序追加，结束原因为 `tool_calls`。
- 工具启用阶段允许一个响应同时包含说明文本与一个工具调用，文本增量照常展示，工具片段独立累计；单调用分片缺省索引或 `null` 索引归一为 `0`，显式非零/非数字索引、多个 choice、多个工具调用、字段类型错误、完成原因不匹配、`length`/`content_filter` 等非成功终止均转为 `ProviderError("protocol", ...)`。
- 收到完成原因后产出完整工具调用或文本完成事件；仍要求最终 `[DONE]`，完成后额外事件继续视为协议错误。
- Provider 只拼接 `argumentsJson`，不在协议层信任或解释参数；核心层解析 JSON，注册中心再按工具 Schema 校验。

### 单次工具编排器

```ts
export type AgentTurnEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | {
      readonly type: "tool-started";
      readonly callId: string;
      readonly name: string;
    }
  | {
      readonly type: "tool-completed";
      readonly callId: string;
      readonly name: string;
      readonly result: ToolExecutionResult;
    }
  | {
      readonly type: "completed";
      readonly message: AssistantTextMessage;
    }
  | {
      readonly type: "failed";
      readonly error: RecoverableAgentError;
      readonly sideEffect: SideEffectState;
    }
  | {
      readonly type: "cancelled";
      readonly sideEffect: SideEffectState;
    };

export interface SingleToolAgent {
  getHistory(): readonly PlainConversationMessage[];
  streamTurn(input: string, signal: AbortSignal): AsyncIterable<AgentTurnEvent>;
}
```

编排器状态是单向且每轮只有一个终态：

```text
idle
  → requesting-initial-model
      ├→ streaming-direct-text → completed
      └→ executing-tool
           → requesting-final-model
             → streaming-final-text → completed

任意活动状态 → failed | cancelled → idle
```

关键不变量：

- 第一响应在出现首个文本增量后锁定为纯文本模式；出现工具调用后锁定为工具模式。
- 工具调用 JSON 先用 `JSON.parse` 得到 `unknown`；解析失败被包装为该调用的 `invalid-arguments` 工具结果，而不是执行工具。
- 未知工具、参数错误、权限错误、非零退出和超时都产生 `tool-completed`，然后序列化为工具消息请求最终文本；用户取消产生 `cancelled` 并立即停止。
- 第二次模型请求只允许文本增量和 `stop`。任何工具调用、无文本成功结束或协议失败都产生 `failed`，绝不第三次请求模型。
- 工具消息只存在于本轮内部请求数组。仅当最终文本完整结束时，持久普通历史追加“用户消息 + 最终助手文本”；失败与取消不提交历史。
- `sideEffect` 初始为 `none`，与工具结果取更高风险值并随失败/取消事件传出。命令一旦启动至少为 `possible`；文件原子提交后为 `applied`。
- 编排器会实时转发第一次工具响应中的说明文本，但不会将其作为最终回复写入成功历史；工具执行后的第二次纯文本响应仍是本轮唯一提交的助手回复。

### Web SSE 与 UI 状态

Web 新增严格事件：

```ts
export type WebChatEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | {
      readonly type: "tool-started";
      readonly callId: string;
      readonly name: ToolName;
    }
  | {
      readonly type: "tool-completed";
      readonly callId: string;
      readonly name: ToolName;
      readonly result: ToolExecutionResult;
    }
  | { readonly type: "completed" }
  | {
      readonly type: "failed";
      readonly message: string;
      readonly sideEffect: SideEffectState;
    };
```

服务端只发送通过安全序列化的结果，不发送工具对象、Schema 执行器、绝对路径、原始异常或环境。客户端解析器继续拒绝未知字段和错误判别组合。

`VisibleMessage` 增加 `toolExecutions`，每项以 `callId` 唯一定位，状态为 `running | succeeded | failed | timed-out | cancelled`。`tool-started` 创建工具卡，`tool-completed` 更新终态；文本增量仍追加到同一助手消息。停止按钮在工具执行阶段保持可用。客户端成功收到 `completed` 后仍只向普通 `history` 追加用户消息与最终助手文本，工具卡仅用于当前页面展示，不作为下一轮请求输入。

工具结果组件以预格式化纯文本/键值视图展示：默认折叠长内容，显示截断标识、退出码和错误类别，不使用 `dangerouslySetInnerHTML`。页面文案从“纯对话模式”更新为“单次工具 Agent”，并明确当前工作目录由服务端启动目录授权。

## 状态与交互

### 纯文本路径

1. Route 校验浏览器的 Provider 名称和普通 `user/assistant` 历史。
2. 创建 `SingleToolAgent`，注入 Provider、默认工具注册中心、授权根目录与请求取消信号。
3. 第一次模型请求携带六个工具定义。
4. Provider 产出文本增量；核心、Route 与浏览器逐层透传。
5. 收到 `stop` 与 `[DONE]` 后提交普通历史并发送 `completed`。

### 工具成功或可恢复失败路径

1. Provider 完整拼接一个工具调用并以 `tool-call` 事件交给核心。
2. 核心发送 `tool-started`，解析参数 JSON，并通过注册中心查找、校验和执行。
3. 注册中心总是把非取消结果收敛为 `ToolExecutionResult`；核心发送 `tool-completed`。
4. 核心构造“原用户消息 → 助手工具调用 → 工具结构化结果”，在此前普通历史之后发起第二次模型请求。
5. 第二次响应只接受最终文本并实时显示；完整结束后只提交用户消息和最终助手文本到普通历史。

### 失败、超时与取消路径

- 工具参数、权限、匹配、命令非零退出、沙箱不可用、工具超时：作为结构化工具失败继续请求最终模型回复。
- Provider 网络、HTTP、SSE 或协议失败：终止轮次，不提交历史。
- 第二次模型再次调用工具或未正常文本结束：终止轮次并报告已累积的副作用风险。
- 用户取消或请求断开：同一个 AbortSignal 中止当前模型或工具；命令终止进程组；不发起后续请求、不提交历史。
- 文件提交或命令启动后发生未知错误：错误结果/轮次事件标记 `possible` 或 `applied`，UI 提醒用户检查工作区，不声称回滚。

## 模块设计

### Schema 与工具注册

- 职责：声明工具输入、生成 OpenAI 定义、运行时解析、按名称分派及错误归一化。
- 对外契约：`ToolInputSchema`、`Tool`、`ToolRegistry`、`createDefaultToolRegistry`。
- 依赖：仅 TypeScript/JavaScript 与工具领域类型；不依赖模型 Provider、React 或 Next.js。
- 错误处理：Schema 问题转为有界 issue 列表；注册和执行异常转为安全 `ToolExecutionResult`。

### 工作区与文件工具

- 职责：统一路径授权、敏感文件策略、安全读取、遍历、快照和原子提交；六个工具只调用边界能力。
- 对外契约：`WorkspaceBoundary` 及六个 `Tool` 实例。
- 依赖：Node.js `fs/promises`、`path`、`crypto` 标准库。
- 错误处理：Node 错误码映射成稳定工具错误；内部绝对路径和异常 cause 不跨边界。

### 命令沙箱

- 职责：能力探测、Seatbelt profile、最小环境、进程组生命周期和有界输出。
- 对外契约：`CommandSandbox`、`MacOsSeatbeltCommandSandbox`。
- 依赖：Node.js `child_process`、`fs/promises`、`os`、`path` 标准库和系统 `/usr/bin/sandbox-exec`。
- 错误处理：不可用、安全探测失败、启动失败、非零退出、超时、取消分别保留；底层诊断只进入不含凭据的内部 cause，不发往模型或浏览器。

### Provider 与 OpenAI 解析

- 职责：表达工具消息和流事件，把注册工具定义发送给兼容端点，严格组装流式 Tool Calling。
- 对外契约：扩展后的 `ConversationMessage`、`ModelStreamEvent` 和 `ChatProvider.stream`。
- 依赖：现有 SSE 解析器、Fetch、模型领域类型和只读 `ModelToolDefinition`。
- 错误处理：所有线协议异常使用 `ProviderError`；取消保持独立类别；不记录响应正文或认证头。

### 单次工具 Agent

- 职责：执行至多两次模型请求和至多一次工具执行，维护普通历史、状态、终止条件与副作用风险。
- 对外契约：`SingleToolAgent.streamTurn`、`AgentTurnEvent`。
- 依赖：`ChatProvider` 与 `ToolRegistry` 抽象，不依赖具体 OpenAI、文件工具或 UI。
- 错误处理：模型失败转可恢复 Agent 错误；工具失败继续模型；取消立即终止；所有路径在 `finally` 回到 idle。

### Web 服务端与客户端

- 职责：服务端组装授权根、Provider、注册中心和 Agent；客户端严格解析事件并展示工具生命周期。
- 对外契约：扩展后的 Web 请求/事件协议和现有 `/api/chat` SSE 入口。
- 依赖：Route 依赖核心/模型/工具；组件只依赖 Web DTO，不导入任何 Node 工具模块。
- 错误处理：启动错误返回安全 JSON；流中错误返回 `failed`；浏览器取消通过请求信号传播，客户端本地完成取消视觉状态。

## 文件组织

```text
src/
├── app/
│   ├── api/chat/route.ts                 # 组装 SingleToolAgent 并转换 SSE 事件
│   └── globals.css                       # 工具卡与状态样式
├── components/
│   ├── chat-workspace.tsx                # 消费工具事件、维护显示状态和普通历史
│   └── message-list.tsx                  # 展示工具生命周期与安全结果
├── core/
│   ├── errors.ts                         # 可恢复 Agent 错误与安全映射
│   ├── single-tool-agent.ts              # 至多一次工具的核心状态机
│   └── single-tool-agent.test.ts         # 纯文本、工具、失败、取消和终止测试
├── models/
│   ├── provider.ts                       # 扩展消息、工具调用和 Provider 契约
│   ├── openai-provider.ts                # OpenAI 工具请求与流式分片解析
│   └── openai-provider.test.ts           # 文本与 Tool Calling 协议测试
├── tools/
│   ├── types.ts                          # JSON、工具、结果和执行上下文类型
│   ├── schema.ts                         # 自研 Schema DSL、校验及 JSON Schema 转换
│   ├── schema.test.ts
│   ├── registry.ts                       # 注册、枚举、查找、校验和错误归一化
│   ├── registry.test.ts
│   ├── protected-paths.ts                # 敏感路径策略
│   ├── workspace.ts                      # 路径边界、文本快照、安全遍历和原子写入
│   ├── workspace.test.ts
│   ├── glob.ts                           # 受限 Glob 解析与匹配
│   ├── glob.test.ts
│   ├── read-file.ts
│   ├── write-file.ts
│   ├── edit-file.ts
│   ├── find-files.ts
│   ├── search-code.ts
│   ├── file-tools.test.ts                # 五个文件/搜索工具的行为与边界测试
│   ├── command-sandbox.ts                # 平台无关命令沙箱契约
│   ├── macos-seatbelt-sandbox.ts          # macOS 严格隔离与进程生命周期
│   ├── macos-seatbelt-sandbox.test.ts     # 真实逃逸、环境、超时与子进程测试
│   ├── run-command.ts
│   ├── run-command.test.ts
│   └── default-registry.ts               # 六个工具的唯一生产注册入口
└── web/
    ├── chat-contract.ts                  # 工具 SSE DTO、编码和严格解析
    ├── chat-contract.test.ts
    └── chat-handler.ts                   # 可注入依赖的服务端 Agent/SSE 编排

tests/
├── helpers/openai-mock.ts                # 支持 Tool Calling 分片的可控模型替身
└── web-tool-agent.e2e.test.ts            # Route 级单次工具闭环与安全历史测试

README.md                                 # 更新 Web 工具能力、工作区和平台隔离边界
```

现有 `conversation.ts` 与 CLI 文件只做适配扩展后 Provider 签名所必需的最小修改，不把工具注册中心注入 CLI。若实现时无需修改某个文件，不为匹配目录图制造空模块。

## 安全与权限边界

- 授权根只来自服务端 `process.cwd()`，浏览器和模型均不能覆盖绝对根目录。
- 所有工具路径经过同一个 `WorkspaceBoundary`；不允许各工具自行使用未经解析的字符串路径。
- 文件工具拒绝所有符号链接而非尝试跟随“看似仍在根内”的链接，降低循环、逃逸和竞态面。
- 写入与修改采用快照身份检查和原子替换；发现并发变化返回 `conflict`，不覆盖新内容。
- 敏感路径策略同时用于直接文件工具、遍历工具和命令 Seatbelt profile；允许示例文件不等于允许本地凭据文件。
- 命令工作目录仍必须通过 `WorkspaceBoundary`；`cwd` 限制与 OS 沙箱同时存在，不能互相替代。
- 命令默认无网络、无真实 HOME、无完整环境；API Key 不进入子进程。严格沙箱不可用即拒绝。
- 命令输出、文件内容和模型结果可能含用户项目数据，只回到当前本地 Web 会话；所有输出仍受大小和纯文本渲染限制。
- 工具错误不包含绝对路径、Seatbelt profile、内部堆栈或 Node 原始 cause；上游模型错误继续沿用现有脱敏策略。
- 客户端只能请求普通对话，不能提交伪造的工具消息、调用标识或执行结果；内部工具 transcript 由服务端构造。
- 用户取消是终止条件，不把“取消”包装成可让模型继续行动的工具失败。
- 工具副作用不提供事务回滚；Agent 事件持续携带 `sideEffect`，防止最终回复失败时误导用户。

## 依赖决策

- 不新增运行时依赖，也不引入 Agent 框架、Schema 库、Glob 库或 Shell 库。
- 工具 Schema 使用小型自研闭集 DSL，因为现有依赖不提供运行时校验；闭集比引入通用校验包更容易保持 OpenAI Schema 与执行校验一致。
- 文件查找和搜索使用 Node.js 标准库实现，以兼容项目声明的 Node.js 20.9；不依赖 Node 22 才稳定提供的 Glob API，也不要求系统安装 `rg`。
- 命令执行使用 Node.js `child_process` 与 macOS 自带 Seatbelt。Seatbelt 已弃用是已知平台风险，因此以真实能力探测和安全拒绝兜底，不新增容器运行时依赖。
- 测试继续使用 Node.js 内置 test runner 和现有 `tsx`，不引入额外测试框架。

## 技术决策

| 决策点 | 选择 | 理由 | 被否决方案 |
| --- | --- | --- | --- |
| 工具调用深度 | 一次工具、最多两次模型请求 | 精确满足本阶段上限，状态和副作用可解释 | 通用 while Agent Loop 会越过已批准范围；只执行第一个并忽略其余会破坏协议 |
| Web 与 CLI 接入 | Web 使用独立 `SingleToolAgent`，CLI 保持纯文本会话 | 避免无意改变 CLI，同时让核心可复用 | 直接把工具逻辑写进 Route/UI；强制 CLI 同步启用工具 |
| Schema 来源 | 自研声明式闭集同时生成校验器和 JSON Schema | 零依赖且消除双份规则漂移 | 手写 JSON Schema + 手写校验易不一致；新增 Zod/Ajv 非必要 |
| 参数 JSON 解析 | Provider 只拼接字符串，核心解析，注册中心校验 | 分离线协议、JSON 语法和工具语义 | Provider 直接断言参数类型会把不可信数据带入核心 |
| 多工具响应 | 整个响应协议失败且零执行 | 保证不出现部分执行和未回复调用 | 只执行第一个或依次执行都会违反上限或 OpenAI transcript 完整性 |
| 文件符号链接 | 全部拒绝 | 比跟随后再判断更容易验证，减少竞态与循环 | 允许根内 symlink 增加 TOCTOU 和平台差异 |
| 写入一致性 | 同目录临时文件 + 快照复核 + 原子重命名 | 避免部分文件和静默覆盖并发修改 | 直接 `writeFile` 可能留下部分写入；全局锁无法覆盖外部编辑器 |
| 内容搜索语法 | 字面量查询 + 可选大小写 | 避免不可信正则 ReDoS，足以完成代码内容搜索 | JS 正则无法可靠中断；依赖 `rg` 不满足可移植/零外部依赖 |
| 文件模式 | 自研受限 `*`、`?`、`**` Glob | 可预测、可限时、兼容 Node 20.9 | 完整 Bash Glob 过于复杂；Node 新版 API 不满足最低版本 |
| 命令隔离 | macOS Seatbelt deny-by-default + 真实探测 | 满足用户选择的严格边界，当前环境可用 | 仅设置 cwd 不构成隔离；命令白名单仍可被参数/脚本绕过；容器新增外部前提 |
| Seatbelt 不可用 | `sandbox-unavailable`，禁止降级 | 保持安全声明真实 | 普通 `spawn` 回退会违反已批准 Spec |
| 命令网络 | 默认拒绝 | 本阶段只要求本地工具，降低外传项目数据风险 | 默认开放网络扩大未审批能力和泄露面 |
| 子进程环境 | 固定最小环境 + 受控 HOME/TMPDIR | 防止 API Key 和用户主目录配置继承 | 复制 `process.env` 会把秘密交给模型命令 |
| 工具 transcript | 仅服务端当前轮内部持有 | 防止浏览器伪造工具结果，仍满足模型跟进 | 客户端回传内部 tool 消息会扩大信任边界；服务端持久会话不在本轮范围 |
| 工具结果展示 | SSE 发送安全、受限结构化 DTO | 用户能观察真实执行，客户端无需本地能力 | 只显示“成功/失败”证据不足；发送工具实现/原始异常不安全 |
| 副作用处理 | 显式 `none/possible/applied`，不回滚 | 命令无法通用事务化，失败时仍可诚实提示 | 声称自动回滚不现实；隐藏副作用会误导用户 |

## 验证策略

### 单元测试

- Schema：合法输入、未知字段、缺失字段、类型/长度/范围错误，以及生成 JSON Schema 的 `required` 与 `additionalProperties`。
- 注册中心：六个定义顺序、重复名称、未知工具、JSON 参数错误、执行异常、超时与取消归一化。
- Workspace：绝对路径、`..`、NUL、符号链接、敏感文件、父目录不存在、快照冲突、原子写入清理和安全错误映射。
- Glob/搜索：`*`、`?`、`**`、非法模式、稳定排序、忽略目录、UTF-8、行列、大小写和截断上限。
- 文件工具：读、创建、覆盖、唯一替换、零/多次匹配、无变化、搜索无匹配与所有结构化输出。
- Provider：文本流、调用名称/参数跨 SSE 与网络分块、多个调用、混合模式、错误索引、无效 JSON、完成原因、取消和第二次禁止工具。
- Agent：纯文本、工具成功、每类可恢复工具失败、再次调用终止、最终模型失败、历史提交、副作用状态和并发轮次拒绝。
- Web 契约：新增事件往返、未知字段拒绝、结果大小及敏感字段不透传。

### 严格隔离集成测试

仅在 Darwin 且候选系统工具存在时执行真实 Seatbelt 测试；当前开发环境必须运行而不能跳过：

- 工作区文件读写成功。
- `/tmp` 哨兵、用户目录哨兵、相邻项目和敏感文件读写失败。
- `sh`、Node 脚本和派生子进程均不能逃逸。
- 哨兵 API Key/环境变量在命令中不存在。
- 网络连接被拒绝。
- 非零退出、stdout/stderr 截断、超时、取消、`SIGTERM` 宽限与 `SIGKILL` 清理均有真实证据。
- 能力探测任一失败时普通命令没有被执行。

非 Darwin CI 验证 `sandbox-unavailable` 安全路径；未来增加其他后端时复用相同契约测试。

### 集成与端到端测试

- 扩展本地 OpenAI mock，记录工具定义和两次请求 transcript，并发送任意分块的 Tool Calling。
- Route 级测试覆盖：纯文本一次请求、工具成功两次请求、参数/权限/超时失败回传、第二次工具调用终止、取消和成功历史过滤。
- 完成实现后依次运行 `npm run test`、`npm run lint`、`npm run typecheck`、`npm run build`。
- 启动开发服务器，用真实浏览器验证工具卡、增量最终回复、长输出、失败、副作用提示、停止、控制台和移动视口；结束后关闭浏览器与服务器。
- Agent 主流程可运行后，在 tmux 中使用用户本地未入库的真实模型配置完成纯文本与六种工具请求，并覆盖无效参数、唯一替换失败、命令非零退出、超时、取消、沙箱逃逸拒绝和第二次工具调用终止；输出不得包含密钥或敏感文件内容。
