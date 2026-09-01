# 单次工具调用系统 Tasks

状态：已批准
依据：已批准的 `spec.md` 与 `plan.md`

## 文件清单

| 操作 | 文件 | 职责 | 对应需求 |
| --- | --- | --- | --- |
| 新建 | `src/tools/types.ts` | 工具名称、JSON 值、统一结果、错误、副作用和执行上下文类型 | F1、F8、F11、F16 |
| 新建 | `src/tools/schema.ts`、`src/tools/schema.test.ts` | 声明式 Schema DSL、运行时解析、OpenAI JSON Schema 与单元测试 | F1、F8 |
| 新建 | `src/tools/registry.ts`、`src/tools/registry.test.ts` | 工具登记、重复检测、定义转换、校验、超时和错误归一化 | F1、F8、F11、F16 |
| 新建 | `src/tools/protected-paths.ts`、`src/tools/workspace.ts`、`src/tools/workspace.test.ts` | 敏感路径、授权根、路径解析、文本快照、安全遍历和原子写入 | F2–F4、F6–F11 |
| 新建 | `src/tools/glob.ts`、`src/tools/glob.test.ts` | 有界 `*`、`?`、`**` 路径模式匹配 | F6、F7、F8 |
| 新建 | `src/tools/read-file.ts`、`write-file.ts`、`edit-file.ts`、`find-files.ts`、`search-code.ts`、`file-tools.test.ts` | 五个文件/搜索工具及行为测试 | F2–F4、F6–F9、F11、F16 |
| 新建 | `src/tools/command-sandbox.ts`、`macos-seatbelt-sandbox.ts`、`macos-seatbelt-sandbox.test.ts` | 沙箱抽象、macOS Seatbelt 隔离、能力探测、进程组和真实安全测试 | F5、F10、F11 |
| 新建 | `src/tools/run-command.ts`、`src/tools/run-command.test.ts` | 命令工具参数、结构化进程终态和错误映射 | F5、F8、F11、F16 |
| 新建 | `src/tools/default-registry.ts` | 六个生产工具的唯一集中注册入口 | F1、F12 |
| 修改 | `src/models/provider.ts`、`src/models/openai-provider.ts`、`src/models/openai-provider.test.ts` | 工具消息、Provider 选项、Tool Calling 分片组装与协议验证 | F12、F13、F15 |
| 修改 | `src/core/conversation.ts`、`src/core/conversation.test.ts` | 适配 Provider 的显式禁用工具选项，保持 CLI 纯文本语义 | F14、N9 |
| 新建/修改 | `src/core/single-tool-agent.ts`、`single-tool-agent.test.ts`、`errors.ts` | 单次工具状态机、历史提交、取消、错误和副作用传播 | F14–F19 |
| 修改 | `src/web/chat-contract.ts`、`src/web/chat-contract.test.ts` | 工具 SSE DTO、严格编码/解析与安全字段验证 | F17–F19 |
| 新建 | `src/web/chat-handler.ts` | 可注入依赖的服务端 Agent 与 ReadableStream 编排 | F14–F19 |
| 修改 | `src/app/api/chat/route.ts` | 读取服务端配置、授权工作区、组装生产依赖并调用 Web 处理器 | F10、F14、F19 |
| 修改 | `src/components/chat-workspace.tsx`、`message-list.tsx`、`src/app/globals.css` | 消费工具事件、显示工具卡、终态与副作用提示 | F17–F19 |
| 修改 | `tests/helpers/openai-mock.ts` | 生成和记录流式 Tool Calling，支持两次模型请求测试 | F12–F16 |
| 新建 | `tests/web-tool-agent.e2e.test.ts` | 使用本地模型替身覆盖 Web 服务端单次工具闭环 | F14–F19 |
| 修改 | `README.md` | 记录六个工具、授权根、敏感文件、Seatbelt 平台边界和单次调用限制 | F2–F19 |

## T1：建立工具领域类型、Schema 与注册中心

- 对应：F1、F8、F11、F16，`plan.md` 的「工具 Schema 与定义」「工具结果与注册中心」
- 文件：`src/tools/types.ts`、`src/tools/schema.ts`、`src/tools/schema.test.ts`、`src/tools/registry.ts`、`src/tools/registry.test.ts`
- 依赖：无

步骤：

1. 定义 `JsonValue`、六个 `ToolName`、`ToolExecutionResult`、`ToolExecutionError`、`SideEffectState`、`ToolExecutionContext` 和有界元数据；保证所有结果可安全 JSON 序列化。
2. 实现只包含严格对象、字符串、布尔值和有界整数的 Schema DSL，从同一声明生成 TypeScript 推导、运行时 `parse` 和 OpenAI 参数 Schema；对象默认拒绝未知字段。
3. 实现泛型 `Tool` 契约和类型擦除后的 `ToolRegistry`，集中处理重复名称、稳定定义顺序、未知工具、参数校验、执行超时、取消和未知异常归一化。
4. 用无副作用假工具证明非法参数不会进入 `execute`，并验证错误中没有原始异常、绝对路径或非 JSON 值。

验证：

- 运行：`npm test -- src/tools/schema.test.ts src/tools/registry.test.ts`
- 期望：Schema 合法/非法边界、JSON Schema 一致性、重复/未知工具、超时、取消和错误归一化全部通过，退出码为 `0`。
- 运行：`npm run typecheck`
- 期望：泛型输入从 Schema 正确推导，无 `any` 或不安全断言导致的类型错误，退出码为 `0`。

## T2：建立工作区安全边界与受限 Glob

- 对应：F2–F4、F6–F9、F11，`plan.md` 的「工作区边界」「六个工具契约」「安全与权限边界」
- 文件：`src/tools/protected-paths.ts`、`src/tools/workspace.ts`、`src/tools/workspace.test.ts`、`src/tools/glob.ts`、`src/tools/glob.test.ts`
- 依赖：T1

步骤：

1. 建立集中敏感路径规则，精确处理 `.env.example` 例外，并为直接路径和遍历提供同一判定入口。
2. 构造真实授权根，拒绝绝对路径、NUL、`..`、过长路径、分隔符歧义、非普通文件/目录和所有符号链接；对新文件验证已有父目录。
3. 实现有大小限制和严格 UTF-8 解码的文本快照，记录设备号、inode、大小和修改时间；把 Node 文件错误映射为稳定工具错误。
4. 实现同目录独占临时文件、完整关闭、原子重命名和 `finally` 清理；覆盖/修改前重新核对目标身份，发现并发变化返回 `conflict`。
5. 实现协作取消的安全目录遍历，跳过约定目录与敏感路径，不跟随符号链接，并稳定输出相对路径。
6. 实现 `*`、`?`、`**` 的受限 Glob 解析与线性匹配，拒绝非法/超限模式，不执行模型提供的正则。

验证：

- 运行：`npm test -- src/tools/workspace.test.ts src/tools/glob.test.ts`
- 期望：路径穿越、绝对路径、敏感文件、符号链接、父目录、UTF-8、快照冲突、原子失败清理、取消和所有 Glob 语义通过，退出码为 `0`。
- 运行：`npm run typecheck`
- 期望：工作区公开接口与计划签名一致，退出码为 `0`。

## T3：实现五个文件与搜索工具

- 对应：F2–F4、F6–F9、F11、F16，`plan.md` 的「六个工具契约」「工作区与文件工具」
- 文件：`src/tools/read-file.ts`、`src/tools/write-file.ts`、`src/tools/edit-file.ts`、`src/tools/find-files.ts`、`src/tools/search-code.ts`、`src/tools/file-tools.test.ts`
- 依赖：T1、T2

步骤：

1. 为五个工具分别声明名称、说明、Schema、可变性和有界输出，不在工具内部重复路径校验逻辑。
2. 实现 `read_file` 的完整 UTF-8 读取与元数据，超出 512 KiB 时拒绝而不是返回误导性的部分文件。
3. 实现 `write_file` 的创建/覆盖和 `edit_file` 的原文唯一匹配；零次、多次、无变化、并发冲突和提交失败均保持原文件不被部分修改。
4. 实现 `find_files` 的稳定排序、空匹配和 1,000 路径截断；实现 `search_code` 的字面量行列搜索、大小写选项、文件 Glob、单文件/总结果限制和安全片段。
5. 覆盖成功、可恢复失败、超时、取消、敏感路径、忽略目录、二进制/非法 UTF-8、输出截断和副作用状态。

验证：

- 运行：`npm test -- src/tools/file-tools.test.ts`
- 期望：五个工具的正常、边界和失败路径全部通过，写入类工具的 `sideEffect` 与实际提交一致，退出码为 `0`。
- 运行：`npm run typecheck`
- 期望：五个工具完整满足统一 `Tool` 契约，退出码为 `0`。

## T4：实现严格命令沙箱、命令工具和生产注册中心

- 对应：F1、F5、F8、F10、F11、F16，`plan.md` 的「命令沙箱」「安全与权限边界」
- 文件：`src/tools/command-sandbox.ts`、`src/tools/macos-seatbelt-sandbox.ts`、`src/tools/macos-seatbelt-sandbox.test.ts`、`src/tools/run-command.ts`、`src/tools/run-command.test.ts`、`src/tools/default-registry.ts`
- 依赖：T1、T2；可与 T3、T5 并行

步骤：

1. 定义平台无关 `CommandSandbox`、能力探测和 `CommandExecution`，将后端不可用与命令执行失败分开建模。
2. 实现 macOS Seatbelt 候选检测和一次性真实能力探测：允许工作区操作，拒绝工作区外/敏感文件、秘密环境变量、网络和派生进程逃逸；探测失败后缓存为不可用。
3. 生成 deny-by-default profile，只开放工作区非敏感数据、必要系统运行资源、受控进程能力和本轮工作区内 HOME/TMPDIR；以固定最小环境启动 `/bin/sh -lc`。
4. 独立启动进程组，分别有界收集 stdout/stderr；超限继续排空管道。取消/超时执行 `SIGTERM` 后宽限，再以 `SIGKILL` 清理整个进程组。
5. 实现 `run_command` Schema、cwd 校验、100–120,000 ms 超时和结构化终态；非零退出保留输出并返回 `command-failed`，启动后副作用至少为 `possible`。
6. 建立 `createDefaultToolRegistry`，以固定顺序且恰好登记六个工具；Seatbelt 不可用时只让 `run_command` 安全失败，不影响其他五个工具。

验证：

- 运行：`npm test -- src/tools/macos-seatbelt-sandbox.test.ts src/tools/run-command.test.ts src/tools/registry.test.ts`
- 期望：当前 Darwin 环境真实运行 Seatbelt；工作区读写成功，外部/敏感/环境/网络/子进程逃逸失败，非零退出、截断、超时和取消字段准确，进程全部退出，退出码为 `0`。
- 运行：`npm run typecheck`
- 期望：沙箱后端仅通过抽象暴露，默认注册中心恰有六个工具，退出码为 `0`。

## T5：扩展 Provider 消息与流式 Tool Calling

- 对应：F12、F13、F15，`plan.md` 的「模型消息与 Provider」「Provider 与 OpenAI 解析」
- 文件：`src/models/provider.ts`、`src/models/openai-provider.ts`、`src/models/openai-provider.test.ts`、`src/core/conversation.ts`、`src/core/conversation.test.ts`、`tests/helpers/openai-mock.ts`
- 依赖：T1；可与 T2–T4 并行

步骤：

1. 扩展领域消息为普通用户/助手、助手工具调用和工具结果判别联合；扩展 Provider 选项为显式 `tools` 与 `toolChoice`，事件增加完整工具调用和完成原因。
2. 将领域消息严格转换为 OpenAI wire format；首次工具请求支持 `tools`、`tool_choice: auto`、`parallel_tool_calls: false`，禁用工具时不允许适配器静默接受工具响应。
3. 重构增量解析为单响应累加器，按索引、调用标识和事件顺序拼接名称/参数；严格区分纯文本与单工具模式，并校验 `finish_reason` 和最终 `[DONE]`。
4. 覆盖名称与 JSON 参数跨 SSE 事件、跨网络块、多 choice、多调用、混合文本、冲突标识、错误索引、非法结构、异常完成原因和取消。
5. 让现有纯文本 `InMemoryConversationSession` 明确使用 `toolChoice: none`，调整既有测试与 mock，但不改变 CLI 历史、错误和取消行为。

验证：

- 运行：`npm test -- src/models/openai-provider.test.ts src/core/conversation.test.ts`
- 期望：纯文本回归和所有 Tool Calling 分片/协议场景通过；多个或混合调用时零工具执行前置数据被产出，退出码为 `0`。
- 运行：`npm run typecheck`
- 期望：所有 Provider 调用方显式选择工具策略，消息联合无非法组合，退出码为 `0`。

## T6：实现单次工具 Agent 状态机

- 对应：F14–F16、F18、F19，`plan.md` 的「单次工具编排器」「状态与交互」
- 文件：`src/core/single-tool-agent.ts`、`src/core/single-tool-agent.test.ts`、`src/core/errors.ts`
- 依赖：T3、T4、T5

步骤：

1. 实现 `idle → initial model → direct text` 或 `tool → final model` 的单向状态机；拒绝空输入和并发轮次，所有终态回到 idle。
2. 第一次请求携带注册中心工具定义。直接文本按增量产出；工具调用只接受一个，产出 `tool-started` 后解析 JSON 并调用注册中心。
3. 将成功或可恢复失败的工具结果安全序列化为内部 `tool` 消息，构造协议顺序正确的第二次请求；第二次请求显式禁用工具并只接受正常最终文本。
4. 再次工具调用、无最终文本、模型协议/网络失败和流截断均终止且不提交历史；工具失败继续模型，用户取消不继续模型。
5. 仅在最终文本完整结束后提交普通用户/助手历史；跟踪并传播 `none/possible/applied`，确保副作用已经可能发生时错误提示不声称回滚。
6. 使用脚本 Provider 和假注册中心覆盖纯文本、工具成功、每类工具失败、未知工具、无效 JSON、超时、取消、二次调用、最终失败、历史、并发和事件顺序。

验证：

- 运行：`npm test -- src/core/single-tool-agent.test.ts`
- 期望：每轮模型请求不超过两次、工具执行不超过一次；历史、事件、副作用和取消不变量全部通过，退出码为 `0`。
- 运行：`npm run typecheck`
- 期望：核心模块仅依赖 Provider 与 ToolRegistry 抽象，不导入 React、Next.js 或具体工具，退出码为 `0`。

## T7：接入 Web 服务端协议与 Route Handler

- 对应：F14、F16–F19，`plan.md` 的「Web SSE 与 UI 状态」「Web 服务端与客户端」
- 文件：`src/web/chat-contract.ts`、`src/web/chat-contract.test.ts`、`src/web/chat-handler.ts`、`src/app/api/chat/route.ts`
- 依赖：T6

步骤：

1. 扩展 Web SSE 联合与严格解析器，增加 `tool-started`、`tool-completed` 和带 `sideEffect` 的失败事件；保持普通请求只允许用户/助手文本历史。
2. 在 `chat-handler.ts` 中封装可注入 Agent 工厂的服务端 ReadableStream 编排，将核心事件映射为安全 DTO，并统一处理请求取消、consumer close、未知异常与监听器清理。
3. Route Handler 从服务端加载 Provider 配置，以 `process.cwd()` 建立唯一 `WorkspaceBoundary`，组装 Seatbelt 后端、六工具注册中心和 `SingleToolAgent`；浏览器不能提供根目录或内部工具消息。
4. 对工具结果做严格安全序列化，确保绝对路径、原始 cause、Schema 执行器、环境和凭据字段无法进入 SSE。
5. 测试新增事件往返、未知/多余字段拒绝、取消传播、流正常关闭、失败副作用字段和纯文本兼容。

验证：

- 运行：`npm test -- src/web/chat-contract.test.ts src/core/single-tool-agent.test.ts`
- 期望：Web DTO 严格往返，服务端事件顺序、取消与安全字段边界通过，退出码为 `0`。
- 运行：`npm run typecheck`
- 期望：Route 仅在服务端导入 Node 工具模块，客户端契约保持可序列化，退出码为 `0`。

## T8：实现 Web 工具调用状态与结果展示

- 对应：F17–F19，`plan.md` 的「Web SSE 与 UI 状态」
- 文件：`src/components/chat-workspace.tsx`、`src/components/message-list.tsx`、`src/app/globals.css`
- 依赖：T7

步骤：

1. 扩展 `VisibleMessage`，在单个助手消息中按 `callId` 保存工具名称、运行中/成功/失败/超时/取消状态和结构化结果。
2. 消费 `tool-started` 与 `tool-completed`，严格按服务端生命周期更新；文本增量继续写入同一助手消息，只有 `completed` 才提交普通历史。
3. 让停止按钮在初始模型、工具和最终模型阶段均可用；浏览器主动取消时本地把仍运行的工具标为取消，失败时显示 `sideEffect` 风险提示。
4. 添加安全的工具卡与键值/预格式化纯文本结果视图，折叠长内容并显示截断、退出码和错误类别；不使用 HTML 注入。
5. 更新阶段文案、空状态和工作目录说明，保持桌面/窄屏、自适应滚动、键盘和减少动画偏好。

验证：

- 运行：`npm run lint && npm run typecheck`
- 期望：React 状态更新无不安全类型、Hook 或可访问性静态问题，退出码为 `0`。
- 可观察：开发服务器下工具事件依次呈现为“执行中 → 明确终态 → 最终回复”，纯文本轮不显示空工具卡，停止后界面恢复输入。

## T9：补齐跨层闭环、文档和完整回归

- 对应：F1–F19，`plan.md` 的「验证策略」及全部非功能需求
- 文件：`tests/helpers/openai-mock.ts`、`tests/web-tool-agent.e2e.test.ts`、`README.md`，以及前序任务中因集成缺陷需要修正的对应文件
- 依赖：T1–T8

步骤：

1. 扩展 OpenAI mock，使其可检查第一次工具定义、发送任意分片的单工具调用、检查第二次工具 transcript，并脚本化纯文本、工具失败、再次调用和流失败。
2. 通过可注入 `chat-handler.ts` 建立不含真实凭据的 Web 服务端闭环测试，覆盖纯文本一次请求、工具成功/失败两次请求、参数拒绝、历史过滤、二次调用终止、取消和副作用提示。
3. 添加跨层敏感信息哨兵，检查模型请求、Web SSE、错误、日志和测试输出均不含 API Key、完整环境、受保护文件内容或绝对工作区路径。
4. 更新 README：六个工具与参数语义、授权根、敏感路径、写入/输出上限、单工具终止规则、Web 状态、macOS Seatbelt、默认无网络、非 macOS 安全拒绝、CLI 仍为纯文本。
5. 运行完整自动化检查并修复既定范围内的回归；不得通过放宽路径、Schema、超时、隔离或凭据保护来使测试通过。
6. 启动开发服务器，用真实浏览器验证桌面和移动视口、工具卡、长输出、失败、停止、副作用提示、错误覆盖层和控制台；结束后关闭浏览器和服务器。
7. 在 tmux 中使用用户本地未入库模型配置完成真实纯文本与六工具闭环，并执行无效参数、唯一替换失败、命令非零退出、超时、取消、隔离逃逸拒绝和再次工具调用终止；结束后清理进程，不记录凭据或敏感文件内容。

验证：

- 运行：`npm run test`
- 期望：全部单元、集成、Seatbelt 和既有 CLI 端到端测试退出码为 `0`，无残留端口或进程。
- 运行：`npm run lint`
- 期望：退出码为 `0`。
- 运行：`npm run typecheck`
- 期望：TypeScript 严格检查退出码为 `0`。
- 运行：`npm run build`
- 期望：Next.js 生产构建退出码为 `0`，客户端产物不包含服务端工具或凭据模块。
- 可观察：真实浏览器与 tmux 场景符合已批准 Spec；若本地真实模型配置不可用，只能记录为未验证，不能用 mock 冒充真实验收。

## 执行顺序

```text
T1：类型 / Schema / 注册中心
 ├──→ T2：工作区 / Glob ──┬──→ T3：五个文件工具 ──┐
 │                         └──→ T4：命令沙箱 ──────┤
 └──→ T5：Provider Tool Calling ───────────────────┤
                                                   ↓
                                          T6：单次工具 Agent
                                                   ↓
                                          T7：Web 服务端接入
                                                   ↓
                                          T8：Web 状态展示
                                                   ↓
                                          T9：跨层闭环与完整回归
```

T3、T4、T5 在共同前置完成后可并行，但合并前必须分别通过各自验证。T6 只有在三条分支契约都稳定后开始，避免核心状态机依赖未定接口。
