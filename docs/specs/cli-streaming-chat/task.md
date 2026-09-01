# CLI 流式对话 Tasks

状态：已批准
依据：已批准的修订版 `spec.md` 与 `plan.md`

## 文件清单

| 操作 | 文件 | 职责 | 对应需求 |
| --- | --- | --- | --- |
| 新建 | `src/models/provider.ts` | 统一消息、流事件、Provider 故障与 Provider 接口；后续补充工厂 | F3、F4、F6、F9、F10 |
| 新建 | `src/core/errors.ts` | 核心可恢复错误和会话状态错误 | F9、F10 |
| 新建 | `src/core/conversation.ts` | 会话历史、请求快照、单轮事务和状态转换 | F5、F6、F9、F10 |
| 新建 | `src/core/conversation.test.ts` | 会话成功、失败、取消、并发和历史测试 | F5、F6、F9、F10 |
| 新建 | `src/lib/environment.ts` | 可选加载工作目录 `.env` 并合并进程环境 | F8、F12 |
| 新建 | `src/lib/environment.test.ts` | `.env` 缺失、解析、优先级和脱敏测试 | F8、F12 |
| 新建 | `src/models/config.ts` | YAML 加载、运行时校验、配置选择和凭据解析 | F2、F3、F8 |
| 新建 | `src/models/config.test.ts` | 配置有效性、选择、安全及错误测试 | F2、F3、F8 |
| 新建 | `src/models/sse.ts` | 协议无关的 SSE 增量分帧 | F4、F9 |
| 新建 | `src/models/sse.test.ts` | 数据块边界、编码、结束和异常测试 | F4、F9 |
| 新建 | `src/models/openai-provider.ts` | OpenAI Chat Completions 请求和增量映射 | F3、F4、F6、F9、F10 |
| 新建 | `src/models/openai-provider.test.ts` | OpenAI Provider 本地 HTTP 集成测试 | F3、F4、F6、F9、F10 |
| 新建 | `src/models/provider-factory.ts` | 按已验证协议创建具体 Provider | F3、F4 |
| 新建 | `src/cli/arguments.ts` | CLI 参数解析与帮助信息 | F1、F3、F8 |
| 新建 | `src/cli/arguments.test.ts` | 参数成功和错误路径测试 | F1、F3、F8 |
| 新建 | `src/cli/terminal-chat.ts` | 终端对话循环、输出和取消控制 | F1、F4、F5、F7、F9、F10、F11 |
| 新建 | `src/cli/terminal-chat.test.ts` | 终端循环、提示符、错误和取消测试 | F1、F5、F7、F9、F10、F11 |
| 新建 | `src/cli/main.ts` | CLI 组合根、顶层错误边界和退出码 | F1、F3、F7、F8 |
| 新建 | `tests/helpers/openai-mock.ts` | 可控的本地 OpenAI 兼容 SSE 服务 | F3、F4、F6、F9、F10 |
| 新建 | `tests/cli.e2e.test.ts` | 真实子进程中的 CLI 多轮闭环 | F1–F12 |
| 新建 | `orbitcode.example.yaml` | 不含真实凭据的多配置 YAML 示例 | F2、F3 |
| 修改 | `.env.example` | 展示与 YAML 对应的环境变量名称 | F3、F8 |
| 修改 | `.gitignore` | 忽略本地 `orbitcode.yaml`，保留用户现有改动 | F2、F8 |
| 修改 | `package.json`、`package-lock.json` | 增加 `yaml`、`dotenv`、`tsx`、CLI 与测试脚本 | F1、F2、F4、F12 |
| 修改 | `README.md` | 记录配置格式、启动、选择、退出与安全约束 | F1、F2、F3、F7、F8 |

## T1：建立领域消息与 Provider 契约

- 对应：F3、F4、F6、F9、F10、N1、N2、N6，`plan.md` 的「核心类型与接口」「Provider 统一接口与工厂」
- 文件：`src/models/provider.ts`、`src/core/errors.ts`
- 依赖：无

步骤：

1. 定义用户/助手消息、文本增量/完成事件和 `ChatProvider` 接口，所有公开输入使用 `readonly`，不暴露 OpenAI JSON 结构。
2. 在 Provider 边界定义网络、HTTP、协议、流和取消相关的安全故障信息；错误字段不得包含请求头、请求正文、响应正文或凭据。
3. 定义核心层可恢复错误判别联合及并发轮次等状态错误；由核心负责把 Provider 故障映射为对话事件，避免具体 Provider 依赖核心实现。
4. 使用 `import type` 和职责边界检查依赖方向，确保 `src/core/` 不导入 React、Next.js、CLI、配置或具体 OpenAI 实现。

验证：

- 运行：`npm run typecheck`
- 期望：退出状态为 `0`；严格类型下契约可编译，核心与 Provider 之间不存在循环运行时依赖。

## T2：实现会话事务与历史管理

- 对应：F5、F6、F9、F10、N1、N2、N5，`plan.md` 的「对话会话核心」「状态与交互」
- 文件：`src/core/conversation.ts`、`src/core/conversation.test.ts`、`package.json`、`package-lock.json`
- 依赖：T1

步骤：

1. 新增开发依赖 `tsx`，配置基于 Node `node:test` 的 `npm run test` 脚本，不引入额外测试框架。
2. 实现 `ConversationSession`：保存不可外部修改的已提交历史，每轮使用“历史快照 + 当前用户消息”调用 Provider，并逐条转发文本增量。
3. 仅在恰好收到一次完成事件后原子提交用户和助手消息；失败、缺少完成、重复完成、完成后继续输出或取消时丢弃整轮缓冲。
4. 显式维护 `idle`/`streaming` 状态并拒绝并发轮次；通过 `finally` 保证任何路径都回到 `idle`。
5. 使用内存 Provider 编写测试，覆盖多轮顺序、只读历史、实时增量、空回复、四类故障、取消、失败后重试以及并发保护。

验证：

- 运行：`npm run test -- src/core/conversation.test.ts`
- 期望：退出状态为 `0`；成功轮次成对提交，失败和取消轮次不改变此前历史，增量事件在完成事件前可观察。

## T3：实现安全的本地环境与 YAML 配置管线

- 对应：F2、F3、F8、F12、N4、N5、N7，`plan.md` 的「本地环境加载器」「YAML 配置加载器」「安全与权限边界」「依赖决策」
- 文件：`src/lib/environment.ts`、`src/lib/environment.test.ts`、`src/models/config.ts`、`src/models/config.test.ts`、`orbitcode.example.yaml`、`.env.example`、`.gitignore`、`package.json`、`package-lock.json`
- 依赖：T1、T2

步骤：

1. 新增运行时依赖 `dotenv` 与 `yaml`；项目代码负责文件读取、优先级、结构校验和错误脱敏。
2. 实现工作目录 `.env` 的可选加载：文件不存在时保留进程环境，存在时解析并只填充尚未设置的变量，不修改输入对象、不搜索其他目录。
3. 为环境加载编写测试，覆盖缺失文件、引号/注释、已有进程变量优先、空值、读取/解析失败和哨兵密钥不泄露。
4. 将 YAML 解析结果从 `unknown` 开始逐层验证并禁用 alias；实现顶层 `providers` 数组及精确字段验证：非空字符串、唯一名称、固定 `openai` 协议、HTTP(S) `base_url`、合法环境变量名称和未知字段拒绝。
5. 实现选择规则：单配置且未指定名称时自动选择；多配置未指定、名称不存在或重复名称时返回可定位的启动错误。
6. 将 `api_key` 解释为环境变量名称并从合并环境读取；缺失或空值返回脱敏凭据错误，返回类型把无凭据描述和运行时秘密分开。
7. 编写表驱动测试覆盖文件缺失、非法 YAML、根结构、空列表、每个必填字段、未知字段、重复名、协议、URL、alias、名称选择和环境变量；用哨兵密钥断言所有错误字符串都不包含密钥。
8. 新增无真实凭据的 `orbitcode.example.yaml`，更新 `.env.example`；只在 `.gitignore` 追加本地 `orbitcode.yaml` 规则，不撤销或改写用户已有的其他差异。

验证：

- 运行：`npm run test -- src/lib/environment.test.ts src/models/config.test.ts`
- 期望：退出状态为 `0`；`.env` 与进程环境按优先级合并，所有非法配置在 Provider 创建前失败，合法多配置可精确选择，测试输出不含哨兵密钥。

## T4：实现跨数据块 SSE 增量解析

- 对应：F4、F9、N3、N5、N7，`plan.md` 的「SSE 增量解析器」
- 文件：`src/models/sse.ts`、`src/models/sse.test.ts`
- 依赖：T1、T2

步骤：

1. 使用流式 `TextDecoder` 消费异步字节块，规范化 CRLF，并以空行识别完整 SSE 事件。
2. 支持一个事件跨多个数据块、单块多个事件、UTF-8 字符跨块、多行 `data:`、注释及不使用字段；按规范拼接 data 内容。
3. 让解析器只输出协议无关 data 字符串，由 OpenAI 层识别 `[DONE]`，保持模块职责单一。
4. 对非法 UTF-8、读取异常及流结束时残缺事件返回结构化错误，不把半个事件当作有效增量。
5. 编写精确控制字节分块的单元测试，确认每个完整事件一到达即可被消费，而不是等待整个响应结束。

验证：

- 运行：`npm run test -- src/models/sse.test.ts`
- 期望：退出状态为 `0`；跨块、同块多事件、CRLF、多行、UTF-8 和异常用例均通过，首事件可在输入流结束前产出。

## T5：实现 OpenAI 兼容流式 Provider

- 对应：F3、F4、F6、F9、F10、N2、N3、N4、N5、N7，`plan.md` 的「OpenAI 兼容 Provider」「Provider 统一接口与工厂」「安全与权限边界」
- 文件：`src/models/openai-provider.ts`、`src/models/openai-provider.test.ts`、`src/models/provider.ts`、`src/models/provider-factory.ts`、`tests/helpers/openai-mock.ts`
- 依赖：T1、T2、T3、T4

步骤：

1. 实现 OpenAI Provider，规范化 `base_url` 后请求 `/chat/completions`，发送 `model`、完整消息快照和 `stream: true`，通过 Bearer 头认证并传递当前轮 `AbortSignal`。
2. 禁止自动重定向，校验 2xx 状态、SSE 内容类型和响应体；HTTP 错误只保留状态、状态文本及安全请求标识，不读取或显示不可信响应正文。
3. 将 SSE data JSON 从 `unknown` 校验为 Chat Completions 文本增量；忽略没有文本的合法元数据块，按序产出非空 `delta.content`，并把唯一 `[DONE]` 映射为完成事件。
4. 区分用户取消与网络异常；将非法 JSON、非法结构、重复/缺失完成标记、完成后数据及截断流转换为安全的 Provider 故障。
5. 在统一工厂中根据已验证的 `protocol` 创建 Provider，确保工厂没有隐式回退，核心无需感知具体协议。
6. 实现只监听本机随机端口的可控模拟服务，支持记录请求、分批发送 SSE、延迟完成、返回 HTTP/重定向/内容类型错误、畸形事件和截断流；默认使用虚拟凭据且不打印请求头。
7. 编写集成测试验证端点、模型、消息历史、认证、首增量时机、分块、完成、错误分类、重定向拒绝和 AbortSignal 确实关闭请求。

验证：

- 运行：`npm run test -- src/models/openai-provider.test.ts`
- 期望：退出状态为 `0`；本地服务观察到正确请求，增量实时到达，所有异常均脱敏并映射为预期故障，测试结束后服务端口关闭。

## T6：接入交互式 CLI 完成纯对话闭环

- 对应：F1、F3、F4、F5、F7、F8、F9、F10、F11、F12、N1、N4、N5、N7、N8，`plan.md` 的「CLI 入口与终端适配」「状态与交互」
- 文件：`src/cli/arguments.ts`、`src/cli/arguments.test.ts`、`src/cli/terminal-chat.ts`、`src/cli/terminal-chat.test.ts`、`src/cli/main.ts`、`tests/cli.e2e.test.ts`、`package.json`
- 依赖：T2、T3、T5

步骤：

1. 实现无 CLI 框架的严格参数解析，支持 `--config <path>`、可选 `--provider <name>` 和 `--help`；拒绝缺值、未知参数和重复参数，并返回可测试的帮助或启动错误。
2. 实现基于 Node readline 的终端循环，配置明确的用户/助手提示边界；空白输入不调用会话，收到增量立即写 stdout，完成、失败和取消后都先整理换行再恢复提示符。
3. 实现 `/exit`、EOF 与信号语义：空闲 `SIGINT` 正常退出；流中 `SIGINT` 只取消当前轮，移除轮次监听后继续会话；清理 readline、信号监听器和活跃请求。
4. 在组合根先加载工作目录 `.env` 并合并进程环境，再加载 YAML、选择 Provider、创建会话并设置退出码；启动错误输出到 stderr 后返回 `1`，正常退出返回 `0`，意外错误不输出堆栈、环境变量或内部请求数据。
5. 在 `package.json` 增加 `cli` 脚本，以 `tsx` 运行独立入口；不修改 Next.js 页面或把核心逻辑接入 App Router。
6. 使用可替换输入输出和内存 Provider 编写参数与终端单元测试；覆盖提示符、空白、两轮、错误恢复、取消、EOF、显式退出、空闲信号和监听器清理。
7. 编写子进程端到端测试，使用临时工作目录的 `.env`、YAML、虚拟凭据和本地模拟服务启动 `npm run cli`，覆盖环境优先级、配置失败、实时分批输出、两轮历史、请求失败后继续、流中 `SIGINT`、空白输入及正常退出。

验证：

- 运行：`npm run test -- src/cli/arguments.test.ts src/cli/terminal-chat.test.ts tests/cli.e2e.test.ts`
- 期望：退出状态为 `0`；真实 CLI 子进程在 `[DONE]` 到达前输出首段文本，失败/取消后仍能继续，正常和错误退出码符合计划。

## T7：完善使用文档并执行全量交付验证

- 对应：F1、F2、F3、F4、F5、F6、F7、F8、F9、F10、F11、F12、N1、N2、N3、N4、N5、N6、N7、N8，`plan.md` 的「验证策略」及全部安全边界
- 文件：`README.md`；必要时仅修复前述任务文件中由验证暴露的既定范围问题
- 依赖：T1–T6

步骤：

1. 更新 README，说明 Node 版本、依赖安装、YAML 结构、环境变量、单/多配置启动命令、交互提示、`/exit`、EOF、`SIGINT` 和本阶段明确排除项；示例只使用占位地址、模型和环境变量名。
2. 运行全部自动化测试，确认测试进程、HTTP 服务、子进程和信号监听器均正确结束，没有悬挂资源。
3. 依次运行 lint、严格类型检查和生产构建，确认新增 CLI 核心没有破坏现有 Next.js 应用。
4. 在 tmux 中先用本地可控服务验证错误后继续、畸形 SSE 恢复和流中取消；再使用用户项目根目录中未入库的 `.env` 与真实 YAML 启动 CLI，连接真实模型完成至少两轮对话，观察增量输出、上下文连续性和正常退出。真实模型验收不得由模拟服务替代。
5. 搜索仓库和测试输出，确认没有真实 API Key、Authorization 值、完整环境变量或本地 `orbitcode.yaml` 被纳入交付文件。

验证：

- 运行：`npm run test`
- 期望：退出状态为 `0`，全部单元、集成和 CLI 端到端测试通过且无残留进程。
- 运行：`npm run lint`
- 期望：退出状态为 `0`，没有 ESLint 错误。
- 运行：`npm run typecheck`
- 期望：退出状态为 `0`，TypeScript 严格检查通过。
- 运行：`npm run build`
- 期望：退出状态为 `0`，Next.js 生产构建成功。
- 可观察验证：tmux 中的模拟异常场景形成“输入—错误/取消—再次提示”闭环；真实模型场景形成至少两轮“输入—增量—完成—再次提示”闭环，且关闭 CLI 和辅助服务后对应 pane 无运行中进程。

## 执行顺序

```text
T1 → T2 ─┬→ T3 ─┐
         └→ T4 ─┴→ T5 → T6 → T7
```

T3 与 T4 在 T2 完成后彼此独立；实际执行可并行，但 T5 必须同时等待两者完成。所有任务完成各自验证后才能进入依赖它的任务。
