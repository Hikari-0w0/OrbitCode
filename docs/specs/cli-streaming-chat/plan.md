# CLI 流式对话 Plan

状态：已批准
依据：已批准的修订版 `spec.md`

## 架构概览

本阶段新增命令行入口、纯 TypeScript 对话核心、模型供应商抽象、OpenAI 兼容实现、YAML 配置加载器和本地 `.env` 加载器。现有 `src/app/` 与 `src/components/` 不参与 CLI 请求链，也不需要修改页面。

依赖方向保持单向：

```text
CLI 入口与终端适配
  ├──> 本地 .env 加载 ──> YAML 配置加载与 Provider 工厂 ──> OpenAI Provider ──> SSE 解析
  └──> 对话会话核心 ──────────────> Provider 统一接口
```

- CLI 层只负责参数、终端输入输出、信号和退出码，不保存领域状态。
- 核心层只负责消息历史、单轮原子提交和会话状态，不解析 YAML、SSE 或 OpenAI JSON。
- Provider 接口以规范化消息和增量事件为边界；协议实现负责 HTTP 请求及协议数据校验。
- 环境层先把当前进程环境与工作目录 `.env` 安全合并，配置层再把 YAML 和合并后的环境解析为可信运行配置；真实 API Key 不进入通用配置对象和错误详情。

## 需求映射

| 需求 | 负责模块/交互 | 设计说明 |
| --- | --- | --- |
| F1 | CLI 入口、终端适配 | 提供 `npm run cli -- --config <path> [--provider <name>]`，配置成功后启动读取—回复循环并显示提示符。 |
| F2 | YAML 配置加载器 | 解析顶层 `providers` 列表，对每项执行运行时校验、名称唯一性检查、HTTP(S) 地址检查及环境变量引用检查。 |
| F3 | CLI 参数、配置选择、Provider 工厂 | 只有一个配置时可省略 `--provider`；多个配置时必须按名称选择。工厂按 `protocol` 创建会话期内唯一 Provider。 |
| F4 | OpenAI Provider、SSE 解析器、终端适配 | 请求 Chat Completions 流式端点，将合法 `delta.content` 转成统一文本增量，由 CLI 收到即写入 stdout。 |
| F5 | 对话会话核心、CLI 循环 | Provider 正常完成后一次性提交用户和助手消息，再由 CLI 换行并恢复提示符。 |
| F6 | 对话会话核心 | 每轮以已提交历史加当前用户消息构造不可变请求快照，保持顺序且不重复。 |
| F7 | CLI 入口、信号控制 | 空闲时 `/exit`、输入 EOF 或 `SIGINT` 正常退出；流式阶段第一次 `SIGINT` 只取消当前请求。 |
| F8 | 本地环境加载器、配置加载器、CLI 顶层错误边界 | `.env` 读取/解析或 YAML 配置错误均建模为致命启动错误，在请求前输出脱敏摘要并设置非零退出码。 |
| F9 | Provider、对话会话核心、CLI 错误呈现 | 网络、HTTP、协议和截断流错误均为单轮可恢复失败；整轮不提交，历史保持原值，CLI 恢复提示符。 |
| F10 | CLI 信号控制、对话会话核心、Provider | 活跃轮次持有独立 `AbortController`；取消后停止消费和请求，整轮不提交并恢复空闲状态。 |
| F11 | CLI 循环 | 输入经 `trim` 判空；空白不调用核心和 Provider，直接再次提示。 |
| F12 | 本地环境加载器、CLI 组合根 | 启动时从当前工作目录可选加载 `.env`，只补充未设置变量；读取或解析失败在任何模型请求前终止。 |

## 核心类型与接口

以下签名用于固定层间契约；字段命名可在实施时做不改变语义的机械调整。

```ts
type ConversationMessage =
  | { readonly role: "user"; readonly content: string }
  | { readonly role: "assistant"; readonly content: string };

type ModelStreamEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "done" };

interface ChatProvider {
  stream(
    messages: readonly ConversationMessage[],
    options: { readonly signal: AbortSignal },
  ): AsyncIterable<ModelStreamEvent>;
}

type TurnEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "completed"; readonly message: ConversationMessage }
  | { readonly type: "failed"; readonly error: RecoverableChatError }
  | { readonly type: "cancelled" };

interface ConversationSession {
  getHistory(): readonly ConversationMessage[];
  streamTurn(input: string, signal: AbortSignal): AsyncIterable<TurnEvent>;
}

type RecoverableChatError =
  | { readonly kind: "network"; readonly message: string }
  | { readonly kind: "http"; readonly status: number; readonly message: string }
  | { readonly kind: "protocol"; readonly message: string }
  | { readonly kind: "stream"; readonly message: string };

type StartupError =
  | { readonly kind: "arguments"; readonly message: string }
  | { readonly kind: "config-file"; readonly message: string }
  | { readonly kind: "config-value"; readonly message: string }
  | { readonly kind: "credential"; readonly message: string };

type ProviderConfig = {
  readonly name: string;
  readonly protocol: "openai";
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKeyEnvironmentVariable: string;
};
```

关键不变量：

- 历史始终由完整的“用户—助手”消息对组成；当前轮仅存在于请求快照和增量缓冲区，收到完成事件后才原子提交。
- `getHistory` 返回只读快照，外部不能修改会话内部状态。
- 同一会话同时只允许一个活跃轮次；CLI 串行调用，核心仍显式拒绝并发轮次以保护状态。
- Provider 必须且只能发出一个 `done`；缺少完成事件、完成后仍有数据、无法解析的协议事件均归类为协议或流错误。
- `completed` 中只产生助手消息；核心内部同时提交对应用户消息，CLI 不直接写历史。
- Provider 运行配置中的真实 API Key 仅在工厂创建 OpenAI Provider 时从 `process.env` 读取并注入，不进入 `ProviderConfig`、会话历史或可序列化错误。

## 状态与交互

会话状态为 `idle` 或 `streaming`，进程另有启动和结束边界：

1. CLI 解析参数，从当前工作目录加载可选 `.env` 并与进程环境合并；进程中已存在的同名变量保持不变，文件读取或解析失败时输出启动错误并以退出码 `1` 结束。
2. CLI 加载 YAML，以合并后的环境选择具名配置和解析认证变量；配置有效后创建 Provider 与空会话，进入 `idle`。
3. `idle` 收到空白输入时保持原状态；收到 `/exit`、EOF 或 `SIGINT` 时以退出码 `0` 结束。
4. `idle` 收到普通输入后创建本轮 `AbortController`，核心基于已提交历史建立请求快照，进入 `streaming`。
5. 每个文本增量依次经 Provider、核心到达 CLI 并立即写入；核心同时累积本轮助手文本，但不修改已提交历史。
6. 正常 `done` 时，核心原子提交用户消息和完整助手消息，发出 `completed`，CLI 明确换行并回到 `idle`。
7. 可恢复错误时，核心丢弃本轮用户消息与助手缓冲，发出 `failed`；CLI 向 stderr 输出脱敏错误、明确换行并回到 `idle`。
8. `streaming` 收到 `SIGINT` 时调用 `abort()`；核心丢弃整轮并发出 `cancelled`，CLI 显示取消状态并回到 `idle`。下一次 `SIGINT` 可正常退出。
9. CLI 顶层 `finally` 关闭输入接口并移除信号监听，防止进程残留监听器。

本阶段不增加自动请求超时，因为获批配置没有超时字段，固定总时限会错误截断长回复；用户始终可以用 `SIGINT` 取消。网络栈自身的连接失败作为可恢复错误处理，后续可通过独立规格增加可配置超时。

## 模块设计

### CLI 入口与终端适配

- 职责：解析 `--config` 与 `--provider`，协调 `.env` 和 YAML 的启动顺序，建立 readline 交互循环，区分 stdout/stderr，管理 `SIGINT`、EOF、`/exit` 和退出码。
- 对外契约：入口接收可替换的输入、输出、环境变量和 Provider 创建能力，避免测试依赖真实终端与网络。
- 依赖：配置加载器、Provider 工厂、对话会话核心以及 Node 标准库；不得被核心或 Provider 反向依赖。
- 错误处理：启动错误终止进程；轮次错误和取消恢复提示符；意外错误统一转为不含堆栈及敏感数据的顶层错误。

### 本地环境加载器

- 职责：以 CLI 启动时的当前工作目录为基准查找 `.env`；文件不存在时返回进程环境的安全副本，存在时按 dotenv 语法解析并只填充尚未设置的变量。
- 对外契约：接收工作目录、只读进程环境和可替换文件读取能力，返回供配置层使用的合并环境；不修改调用方传入对象，也不暴露全量环境到日志。
- 依赖：Node 文件系统、路径标准库与 `dotenv` 解析库；不依赖核心、Provider、React 或 Next.js。
- 错误处理：仅把文件路径和“读取失败/解析失败”原因映射为启动错误，不附带文件内容、解析结果或环境变量值；缺少 `.env` 本身不是错误。

### 对话会话核心

- 职责：维护已提交消息、创建请求快照、串行化轮次、转发增量、原子提交或回滚当前轮次。
- 对外契约：`ConversationSession` 和 `TurnEvent` 判别联合。
- 依赖：只依赖 Provider 统一接口和领域错误类型，不依赖 Node 终端、文件系统、YAML、React 或 Next.js。
- 错误处理：把 Provider 的已知故障映射为 `failed`，把取消映射为 `cancelled`；用 `finally` 恢复 `idle`，并保持原历史。

### Provider 统一接口与工厂

- 职责：定义消息输入和增量输出协议，根据已经验证的 `protocol` 创建具体 Provider。
- 对外契约：`ChatProvider`、`ModelStreamEvent` 及工厂函数。
- 依赖：接口不依赖 OpenAI JSON；工厂可依赖具体实现，但核心只依赖接口。
- 错误处理：不支持的协议在配置验证阶段拒绝；工厂不回退到其他配置。

### YAML 配置加载器

- 职责：读取用户指定文件，解析顶层 `providers` 列表，把 `unknown` 数据逐字段验证为 `ProviderConfig`，选择配置并解析认证环境变量。
- 对外契约：返回无凭据的配置描述和单独的运行时认证值；YAML 约定如下：

```yaml
providers:
  - name: primary
    protocol: openai
    model: example-model
    base_url: https://example.invalid/v1
    api_key: ORBITCODE_API_KEY
```

- 依赖：Node 文件系统、`yaml` 解析库；不依赖核心或 CLI 展示逻辑。
- 错误处理：拒绝非对象根节点、未知顶层结构、非数组列表、未知字段、空值、重复名称、非 HTTP(S) URL、非 `openai` 协议及不符合环境变量名称规则的 `api_key`。禁止 YAML alias，避免别名膨胀。错误只包含配置名、字段名和原因，不包含字段实际凭据值。

### OpenAI 兼容 Provider

- 职责：对规范化消息构造 `POST {base_url}/chat/completions` 请求，设置 `stream: true`、模型、消息和 Bearer 认证；校验 HTTP 状态和 SSE 响应，将 OpenAI Chat Completions 增量映射为统一事件。
- 对外契约：实现 `ChatProvider`；`base_url` 末尾斜杠会规范化，用户无需填写完整端点路径。
- 依赖：Node 20 提供的 `fetch`、`AbortSignal`、Web Stream；依赖 SSE 解析器，不依赖 CLI 和核心实现。
- 错误处理：网络异常、非 2xx 状态、错误内容类型、非法 JSON、非法增量结构、缺少 `[DONE]`、结束后额外协议数据分别归入结构化可恢复错误。HTTP 错误只报告状态、状态文本和安全的请求标识，不输出响应正文或请求头。

### SSE 增量解析器

- 职责：用流式 `TextDecoder` 处理 UTF-8 字节，按空行划分事件，支持 CRLF、跨数据块事件、单块多事件、多行 `data:` 及最后残留缓冲；识别 `[DONE]`。
- 对外契约：接收异步字节流，产出未经 OpenAI 语义绑定的 SSE data 字符串。
- 依赖：仅依赖标准 Web Stream/编码能力。
- 错误处理：非法 UTF-8、无法形成完整结束事件或读取异常转为协议/流错误；注释行和本阶段不使用的 SSE 字段可安全忽略。

## 文件组织

```text
src/
├── cli/
│   ├── arguments.ts             # CLI 参数解析与帮助信息
│   ├── main.ts                  # 可执行入口和顶层退出边界
│   └── terminal-chat.ts         # readline 循环、输出与信号控制
├── core/
│   ├── conversation.ts          # 会话状态、历史和单轮事务
│   └── errors.ts                # 核心可恢复错误判别联合
├── lib/
│   └── environment.ts           # 可选 .env 加载与环境优先级合并
└── models/
    ├── config.ts                # YAML 加载、校验、选择和环境变量解析
    ├── openai-provider.ts       # OpenAI 兼容 HTTP/SSE 适配
    ├── provider.ts              # 统一 Provider 契约与工厂
    ├── provider-factory.ts      # 按协议创建具体 Provider
    └── sse.ts                   # 协议无关 SSE 增量解析
tests/
├── cli.e2e.test.ts              # 子进程级 CLI 闭环
└── helpers/
    └── openai-mock.ts           # 本地可控流式服务
orbitcode.example.yaml           # 无真实凭据的 YAML 示例
.env.example                     # 示例环境变量名
.gitignore                       # 忽略本地 orbitcode.yaml
package.json                     # CLI 与测试脚本、必要依赖
package-lock.json                # 锁定依赖
README.md                        # 配置和启动说明
```

核心、配置、SSE 和 Provider 的聚焦测试与被测模块同目录放置为 `*.test.ts`，减少测试与契约漂移；跨模块 CLI 场景放在 `tests/`。

## 安全与权限边界

- YAML 的 `api_key` 只接受环境变量名称（如 `ORBITCODE_API_KEY`），不支持字面密钥、`${...}` 插值、命令替换或从其他文件加载；本地 `orbitcode.yaml` 默认忽略，仓库只保留示例。
- 启动工作目录中的 `.env` 在项目根目录使用时由既有 `.gitignore` 规则排除；加载器只读取这一个明确文件，不递归搜索父目录或用户目录，不把内容回写磁盘。进程中已存在的变量优先于 `.env`，避免本地文件意外覆盖调用方显式注入。
- API Key 仅用于构造请求时的内存值，不作为 CLI 参数、错误字段、日志上下文或会话消息传递。任何错误对象都不得携带请求头、完整请求或 `process.env`。
- YAML 从 `unknown` 开始校验，拒绝未知字段与 alias；配置路径只读取用户明确传入的单个文件，不递归扫描目录。
- `base_url` 仅允许 `http:` 或 `https:`。本阶段不会阻止用户明确配置 localhost 或私网地址，因为连接任意 OpenAI 兼容服务是目标能力；不会自动跟随配置以外的凭据来源。
- 携带认证头的模型请求禁止自动跟随重定向，避免配置端点通过跨地址跳转扩大凭据暴露范围；重定向响应作为可恢复 HTTP 错误呈现。
- Provider 不记录请求和响应正文；HTTP 服务返回的错误正文可能包含不可信或敏感内容，因此不会直接显示。
- 增量数据在当前轮内仅保存在内存；失败、取消和进程退出时丢弃，不写入文件。
- 取消使用当前轮独立的 `AbortController`，不得复用已取消 signal；所有监听器均在轮次或进程结束时清理。
- 本阶段没有文件、命令或 Tool Calling 权限，模型文本不能触发本地副作用。

## 依赖决策

- 新增运行时依赖 `yaml`：Node.js 20 标准库不提供 YAML 解析器。手写 YAML 子集会产生与用户预期不一致的语法、转义和安全行为；使用专用解析库后仍由项目代码完成结构校验并禁用 alias。
- 新增运行时依赖 `dotenv`：目标最低版本 Node.js 20.9 没有适合在进程内“可选加载且不覆盖现有变量”的稳定 dotenv 解析接口。手写解析会遗漏引号、转义和注释规则；项目只使用其纯解析能力，文件读取、优先级合并和错误脱敏仍自行实现。
- 新增开发依赖 `tsx`：Node.js 20.9 不能直接执行 TypeScript，现有 Next.js 构建也不会生成独立 CLI。`tsx` 只负责本地运行 CLI 和驱动 Node 内置测试，不提供模型或 Agent 能力，生产逻辑不依赖它。
- HTTP、Bearer 认证、AbortSignal、UTF-8 解码和 Web Stream 使用 Node 20 自带的 `fetch` 及标准 API，不引入 OpenAI SDK、SSE 客户端、CLI 框架或状态管理库。
- 测试使用 Node 内置 `node:test` 与 `assert`，由 `tsx` 执行 TypeScript 测试；不新增独立测试框架。

## 技术决策

| 决策点 | 选择 | 理由 | 被否决方案 |
| --- | --- | --- | --- |
| CLI 运行方式 | 通过 `npm run cli` 使用 `tsx` 执行独立入口 | 适配当前私有 Next.js 仓库与 Node 20，保持 CLI 核心独立且无需先构建整站 | 把 CLI 放进 Next.js 路由；依赖未声明的全局 TypeScript 运行时；本阶段发布全局 npm 二进制 |
| YAML 结构 | 顶层 `providers` 数组，每项名称唯一 | 明确支持多个配置，后续可自然扩展协议 | 单一根配置无法体现 `name` 的多配置价值；以动态键名为配置会让字段验证和错误定位更隐晦 |
| 凭据引用语法 | `api_key` 为纯环境变量名称 | 不执行插值，语义简单，错误可精确定位，也不会把密钥放入参数 | YAML 内保存真实密钥；支持任意 `${...}` 模板或命令替换 |
| 本地环境加载 | 自动读取启动工作目录的可选 `.env`，进程环境优先 | 满足本地真实模型配置，同时保留 CI/显式导出变量的可控性；缺少 `.env` 不阻断合法进程环境 | 要求用户每次手动导出；覆盖进程变量；递归搜索其他 `.env` 文件 |
| 多配置选择 | 一个配置时默认选中，多个配置时要求 `--provider <name>` | 单配置启动简洁，多配置选择明确且非交互脚本可复现 | 启动后交互菜单不利于自动测试；静默选择第一项容易误用服务 |
| OpenAI API 形态 | Chat Completions `POST /chat/completions` + SSE | 与纯文本 `role/content` 多轮消息和广泛兼容服务最匹配 | Responses API 并非所有 OpenAI 兼容服务支持；厂商 SDK增加绑定和依赖 |
| 流处理 | 自研协议无关 SSE 分帧器，OpenAI 层单独解析 JSON | 正确覆盖数据块边界，同时使 SSE 与具体模型协议解耦 | 按网络 chunk 或逐行直接解析会破坏事件边界；缓存完整响应违背实时要求 |
| 历史提交 | 一轮完成后原子提交用户与助手消息 | 失败/取消后历史仍严格成对，重试不会携带半轮上下文 | 收到用户输入即永久追加会在失败后形成悬空用户消息 |
| 错误边界 | 启动错误致命；请求/协议错误单轮可恢复；取消独立建模 | 对应已批准的成功、恢复和终止行为 | 所有错误直接退出会破坏交互；吞掉错误会让状态不可解释 |
| 请求超时 | 本阶段不设固定超时，仅支持用户取消 | 配置字段未包含超时，固定限制可能截断合法长回复 | 隐式固定超时；无取消能力地无限等待 |

## 验证策略

- 环境加载单元测试：在临时目录覆盖 `.env` 不存在、合法引号/注释、已有进程变量优先、空值、读取失败和解析失败；使用唯一哨兵值断言返回错误与测试输出不泄露文件内容或凭据。
- 配置单元测试：覆盖合法单/多配置、选择规则、所有必填字段、未知字段、重复名、协议、URL、alias、环境变量名及缺失凭据，断言错误不含环境变量值。
- SSE 单元测试：用异步字节块覆盖事件跨块、单块多事件、CRLF、多行 data、UTF-8 跨块、`[DONE]`、残缺事件和读取失败。
- 会话单元测试：使用内存 Provider 覆盖实时事件顺序、两轮历史、原子提交、网络/HTTP/协议/流错误、取消、空输入防线和并发调用保护。
- OpenAI Provider 集成测试：启动仅监听本机随机端口的可控 HTTP 服务，断言请求路径、`stream: true`、model、历史消息及 Authorization；服务端返回分批 SSE、非 2xx、重定向、错误类型、畸形 JSON 和截断流。测试输出和失败信息不得打印认证值。
- CLI 端到端测试：用临时工作目录中的 `.env`、YAML、虚拟凭据和本地可控服务启动真实 CLI 子进程，完成环境优先级、两轮提问、空白输入、显式退出、配置失败、请求失败恢复和流中取消，观察增量在 `[DONE]` 前到达。测试结束清理子进程和临时文件。
- 完成实现后依次运行 `npm run test`、`npm run lint`、`npm run typecheck`、`npm run build`；页面代码未改动，因此无需浏览器检查。
- 按仓库约束先在 tmux 中连接本地可控服务完成确定性的失败、无效 SSE 和取消验证；随后使用用户未入库的真实 YAML 与项目根目录 `.env` 启动真实 CLI，至少完成两轮真实模型对话并观察流式输出与上下文连续性。真实模型验收是交付必检项，不得以模拟服务代替；执行和报告过程中不得读取、打印或捕获 `.env` 内容及认证头。
