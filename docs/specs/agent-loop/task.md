# Agent Loop 与 Plan Mode Tasks

状态：已批准
依据：已批准的 `spec.md` 与 `plan.md`

## 文件清单

| 操作 | 文件 | 职责 | 对应需求 |
| --- | --- | --- | --- |
| 新建 | `src/core/agent-events.ts` | 统一模式、进度、Usage、工具生命周期和停止事件 | F7、F9、F13 |
| 新建 | `src/core/agent-loop.ts` | ReAct 循环、内部 transcript、历史提交和停止判定 | F1、F2、F6–F10、F14–F16 |
| 新建 | `src/core/agent-loop.test.ts` | 循环、恢复、历史、上限、未知工具、错误和取消测试 | F1、F2、F5–F10、F14–F16 |
| 新建 | `src/core/tool-scheduler.ts` | 多工具安全分批、只读并发、结果复序和取消 | F4、F5、F8 |
| 新建 | `src/core/tool-scheduler.test.ts` | 调度重叠、并发上限、顺序、错误和取消测试 | F4、F5、F8 |
| 删除 | `src/core/single-tool-agent.ts` | 完成入口迁移后移除旧单次状态机 | F1、N1 |
| 删除 | `src/core/single-tool-agent.test.ts` | 场景迁入 Agent Loop 测试后移除旧测试 | F1、N1 |
| 修改 | `src/core/conversation.ts` | 兼容新增模型 Usage 事件，保持 CLI 纯文本会话 | N1、N9 |
| 修改 | `src/core/conversation.test.ts` | 验证 Usage 不破坏 CLI 现有行为 | N9、N11 |
| 修改 | `src/core/errors.ts` | 提供 Agent 停止所需的安全错误映射 | F7、F15、N6 |
| 修改 | `src/models/provider.ts` | 多工具消息、system 消息和 Token Usage 契约 | F2、F3、F9、F10 |
| 修改 | `src/models/openai-provider.ts` | 解析多工具、Usage 与严格完成协议 | F2、F3、F15 |
| 修改 | `src/models/openai-provider.test.ts` | 多工具、Usage、请求体和异常协议验证 | F2、F3、F15 |
| 修改 | `tests/helpers/openai-mock.ts` | 构造多索引工具调用和 Usage 流 | F2、F3 |
| 修改 | `src/tools/types.ts` | 补充共享 mutability 与 unknown-tool 错误种类 | F4、F14 |
| 修改 | `src/tools/registry.ts` | 提供受控元数据查询和明确未知工具结果 | F4、F14 |
| 修改 | `src/tools/registry.test.ts` | 验证查询、未知分类和统一执行边界 | F4、F14 |
| 新建 | `src/tools/mode-policy.ts` | Plan/Do definitions 过滤和执行时权限复核 | F11、F12、F14 |
| 新建 | `src/tools/mode-policy.test.ts` | 验证只读集合、拒绝无副作用及 Do 恢复 | F11、F12、F14 |
| 修改 | `src/web/server-config.ts` | 解析服务端最大迭代配置 | F6、F16 |
| 新建 | `src/web/server-config.test.ts` | 默认、覆盖、非法与硬上限配置测试 | F6、F16 |
| 修改 | `src/web/chat-contract.ts` | mode 请求和完整 Agent SSE 事件运行时契约 | F7–F9、F11、F13、F16 |
| 修改 | `src/web/chat-contract.test.ts` | 请求与所有事件的 round-trip 和拒绝测试 | F7–F9、F11、F13、F16 |
| 修改 | `src/web/chat-handler.ts` | AgentEvent 到 Web SSE 的无损适配和请求取消 | F8、F9、F13、F15 |
| 修改 | `src/web/chat-handler.test.ts` | 全事件映射、唯一停止、异常与断开测试 | F7–F9、F13、F15 |
| 修改 | `src/app/api/chat/route.ts` | 组装 AgentLoop、模式策略、迭代配置和工作区 | F1、F6、F11、F12、F16 |
| 修改 | `tests/web-tool-agent.e2e.test.ts` | 升级为多迭代、多工具、模式和停止集成测试 | F1–F16 |
| 修改 | `src/components/chat-workspace.tsx` | 模式命令、事件归并、停止处理和历史提交 | F8、F10、F11、F13、F16 |
| 修改 | `src/components/message-list.tsx` | 多迭代进度、Usage、工具和停止原因展示 | F13 |
| 修改 | `src/components/chat-composer.tsx` | 当前模式提示和 `/plan`、`/do` 可发现性 | F11、F13 |
| 修改 | `src/app/globals.css` | 新过程视图的桌面、窄屏和可访问状态样式 | F13、N10 |
| 修改 | `.env.example` | 记录可选最大迭代环境变量且不含凭据 | F6、N6 |
| 修改 | `README.md` | 说明 Agent Loop、模式、限制、取消和配置 | F6、F7、F11、F12 |

## T1：扩展模型消息与 OpenAI 流协议

- 对应：F2、F3、F10、F15，`plan.md` 的「核心类型与接口」「多工具 Provider」
- 文件：`src/models/provider.ts`、`src/models/openai-provider.ts`、`src/models/openai-provider.test.ts`、`tests/helpers/openai-mock.ts`、`src/core/conversation.ts`、`src/core/conversation.test.ts`、`src/core/single-tool-agent.ts`
- 依赖：无

步骤：

1. 扩展模型消息联合，允许服务端 system 消息和任意非空工具调用数组，同时保持浏览器公开历史仍只有 user/assistant 文本。
2. 增加严格的 `ModelTokenUsage` 与 `usage` 流事件；纯文本会话忽略 Usage，但仍要求唯一合法完成事件。
3. 把 OpenAI 工具 accumulator 从单值改为按 index 管理的有界集合：校验非负连续索引、唯一 callId、完整名称与参数，并在 finish 时按 index 输出最多 16 个完整调用。
4. 请求启用 `parallel_tool_calls: true` 和流式 Usage；允许 finish reason 之后、`[DONE]` 之前出现一次合法 Usage，缺失 Usage 保持兼容，重复或非法 Usage 归为协议错误。
5. 扩展消息序列化，正确发送 system、带文本或 null content 的多 tool_calls assistant 消息及逐个 tool 结果。
6. 更新 mock 辅助和 Provider 测试，覆盖多调用跨 SSE/网络分块、混合文本、Usage 报告/缺失、稀疏或冲突索引、重复标识、超量调用、错误完成原因、截断和取消。
7. 对旧 `SingleToolAgent` 做仅为迁移期编译所需的 Usage 兼容，不扩展其公开能力；最终在 T6 删除。

验证：

- 运行：`npm run test -- src/models/openai-provider.test.ts src/core/conversation.test.ts`
- 期望：退出码 `0`；请求体、多工具拼接、Usage 和纯文本兼容场景全部通过。

## T2：建立模式化工具访问边界

- 对应：F4、F11、F12、F14，`plan.md` 的「工具模式策略」「安全与权限边界」
- 文件：`src/tools/types.ts`、`src/tools/registry.ts`、`src/tools/registry.test.ts`、`src/tools/mode-policy.ts`、`src/tools/mode-policy.test.ts`
- 依赖：T1 的共享模型工具类型

步骤：

1. 提取稳定的 `ToolMutability` 类型，并为真正未知名称增加独立 `unknown-tool` 错误种类。
2. 为注册中心增加只读元数据查询，调用方只能得到名称、定义和 mutability，不绕过统一参数校验、超时与异常收敛。
3. 实现 Plan/Do 模式策略：Plan definitions 只含三个指定只读工具，Do definitions 保持完整注册顺序。
4. 在策略执行入口重复分类。未知名称返回 `unknown-tool`；已注册但当前模式禁用返回 `permission-denied`；两者均为 `sideEffect: none` 且不调用底层工具。
5. 用会记录参数解析和执行次数的假工具证明禁用调用没有进入底层，并验证切回 Do 后同一工具可正常执行。

验证：

- 运行：`npm run test -- src/tools/registry.test.ts src/tools/mode-policy.test.ts`
- 期望：退出码 `0`；Plan/Do definitions、未知/禁用分类和执行时复核均通过，禁用测试的副作用计数为零。

## T3：实现多工具安全调度器

- 对应：F4、F5、F8，`plan.md` 的「工具调度器」「状态与交互」
- 文件：`src/core/tool-scheduler.ts`、`src/core/tool-scheduler.test.ts`
- 依赖：T2

步骤：

1. 按原调用顺序扫描并形成调度组：最大连续允许只读段切成最多 8 个的并发子批次，其余允许写入、命令、禁用和未知调用均形成单例边界。
2. 解析每个调用的 JSON 参数；非法 JSON 直接生成无副作用的 `invalid-arguments` 结果，不进入注册中心执行。
3. 通过异步事件流报告真实 started/result 生命周期；并发只读结果可按完成先后产生事件，但最终 `orderedResults` 按模型调用顺序返回。
4. 聚合所有执行 Promise 的成功或结构化失败，避免一个 Promise 拒绝使同批其他任务悬空或形成未处理异常。
5. 在每组和每个副作用调用启动前检查 AbortSignal；取消时向当前执行传播信号、等待其收敛，并阻止后续组启动。
6. 用受控延迟工具记录时间区间，验证同批只读重叠、并发不超过 8、写入/命令不与任何调用重叠、跨写入的读取不被提前，以及结果复序和取消边界。

验证：

- 运行：`npm run test -- src/core/tool-scheduler.test.ts`
- 期望：退出码 `0`；时间区间断言、原序结果、错误收敛和取消后不启动后续副作用工具均通过。

## T4：实现统一事件流与 Agent Loop

- 对应：F1、F2、F5–F10、F14–F16，`plan.md` 的「Agent 事件与错误模型」「Agent Loop」「状态与交互」
- 文件：`src/core/agent-events.ts`、`src/core/agent-loop.ts`、`src/core/agent-loop.test.ts`、`src/core/errors.ts`
- 依赖：T1、T2、T3

步骤：

1. 定义 `AgentMode`、进度、Token Usage、工具生命周期和唯一 `stopped` 事件判别联合，编码 `final-response`、`max-iterations`、`cancelled`、`repeated-unknown-tool`、`model-error`、`agent-error` 六类原因。
2. 实现构造参数校验：最大迭代为 1–32 的整数，缺省由入口传入默认 8；未知工具迭代阈值固定为 2；同一 session 保持 idle/running 互斥。
3. 每次模型迭代先加入服务端固定的 Plan 或 Do system 提示，立即转发文本并累计响应，收集完整调用、finish reason 和 Usage 后再作决策。
4. 无工具且有非空最终文本时提交普通历史并发出 `final-response`；空最终文本、Provider 异常和不变量错误分别安全映射停止原因。
5. 到达最后允许迭代且仍有工具时，发出调用确认后直接 `max-iterations`，不调用调度器。
6. 对全部未知的模型迭代维护连续计数：第一次把有序未知结果追加 transcript 并继续，第二次发出结果后停止；合法允许调用重置计数，模式拒绝不当作未知。
7. 调用 T3 调度器，转发 started/result/progress，按原顺序追加 assistant tool_calls 与 tool 消息，并聚合 sideEffect 后进入下一迭代。
8. 在模型和工具阶段统一处理取消，保证一次且仅一次 stopped；只有 final-response 更新公开历史。
9. 使用脚本 Provider 和假工具覆盖直接回复、三段工具链、混合文本、多调用、可恢复失败、Usage 累计/不可用、所有停止原因、末批不执行、未知重置、历史提交、并发轮次和分阶段取消。

验证：

- 运行：`npm run test -- src/core/agent-loop.test.ts src/core/tool-scheduler.test.ts`
- 期望：退出码 `0`；所有循环、事件顺序、停止唯一性、历史和副作用断言通过。

## T5：扩展 Web 请求、事件与服务端配置契约

- 对应：F6–F9、F11、F13、F16，`plan.md` 的「Web 契约与适配」「依赖决策」
- 文件：`src/web/server-config.ts`、`src/web/server-config.test.ts`、`src/web/chat-contract.ts`、`src/web/chat-contract.test.ts`、`.env.example`
- 依赖：T4

步骤：

1. 从现有本地环境加载结果读取 `ORBITCODE_MAX_AGENT_ITERATIONS`，缺失采用 8，严格拒绝空白、非十进制整数、零、负数和超过核心硬上限 32 的值。
2. 将解析后的 `maxIterations` 纳入 Web 服务端上下文，不改变 YAML Provider schema，也不把该值开放为客户端请求字段。
3. 给 `WebChatRequest` 增加必填 `mode: "plan" | "do"`，继续只接受交替的普通 user/assistant 历史并拒绝 system/tool/tool_calls 伪造。
4. 用精确字段校验定义与 `AgentEvent` 等价的 Web SSE 联合，包括安全未知工具名、iteration、sequence、Usage、progress 和 stopped。
5. 增加请求和事件 round-trip 测试，覆盖所有合法变体、额外字段、非法计数、非法停止组合、超长名称和恶意结构。
6. 在 `.env.example` 记录非敏感可选配置及范围，不填入真实值或凭据示例。

验证：

- 运行：`npm run test -- src/web/server-config.test.ts src/web/chat-contract.test.ts`
- 期望：退出码 `0`；默认/覆盖配置、非法值拒绝、mode 请求和全部 SSE 事件校验通过。

## T6：接入 Web 服务端并移除单次 Agent

- 对应：F1、F6、F8–F12、F14–F16，`plan.md` 的「架构概览」「Web 契约与适配」
- 文件：`src/app/api/chat/route.ts`、`src/web/chat-handler.ts`、`src/web/chat-handler.test.ts`、`tests/web-tool-agent.e2e.test.ts`、`src/core/single-tool-agent.ts`、`src/core/single-tool-agent.test.ts`
- 依赖：T4、T5

步骤：

1. Route 从已校验请求读取 mode，从服务端上下文读取 maxIterations，构造默认 Registry、对应 `ModeToolPolicy` 工厂、工作区、Provider 和 `AgentLoop`；Route 内不得出现循环或工具批次状态机。
2. Web handler 将每种 `AgentEvent` 无损转换为 `WebChatEvent`，保留未知安全工具名、iteration、sequence、Usage、progress、sideEffect 和停止原因。
3. 让请求 signal、ReadableStream cancel 和 Agent signal 共用同一取消控制器；流开始后的意外异常只产生一次安全 `stopped(agent-error)`，连接已关闭时不再 enqueue。
4. 升级 handler 测试，覆盖全部事件映射、浏览器断开、Agent 取消、异常脱敏、唯一 stopped 和 stream 关闭。
5. 升级 Web 集成测试：可控模型完成至少三个模型迭代和混合多工具批次，检查请求 transcript、definitions、事件顺序、Usage、历史结果及各停止路径。
6. 将所有生产引用和测试场景迁移后删除 `SingleToolAgent` 及其测试，使用 `rg` 确认仓库无残留引用。

验证：

- 运行：`npm run test -- src/web/chat-handler.test.ts tests/web-tool-agent.e2e.test.ts`
- 运行：`rg -n "SingleToolAgent|single-tool-agent" src tests`
- 期望：测试退出码 `0`；第二条命令无输出且退出码 `1`，表示旧状态机已完全移除。

## T7：实现 Web Plan/Do 与多迭代过程视图

- 对应：F8、F10、F11、F13、F16，`plan.md` 的「Web 页面状态」
- 文件：`src/components/chat-workspace.tsx`、`src/components/message-list.tsx`、`src/components/chat-composer.tsx`、`src/app/globals.css`
- 依赖：T6

步骤：

1. 增加当前 mode 状态，默认 Do；输入严格等于 `/plan` 或 `/do` 时只更新模式和安全通知，不创建消息、不调用 fetch。生成期间输入已禁用，因此不能并发切换。
2. Provider 切换、清空和页面重新加载恢复 Do；每个普通请求显式携带 mode，并在侧栏、输入提示和对话区域清楚显示当前模式及工具范围。
3. 扩展助手可视状态，以 iteration + callId + sequence 归并工具调用；支持 queued、running、succeeded、failed、timed-out、cancelled、skipped，并在停止时收敛尚未开始或运行中的卡片。
4. 处理 progress 和 token-usage，展示当前/最大迭代、模型或工具阶段、工具完成数，以及本轮/累计 reported 或 unavailable 用量。
5. 只在 `stopped(final-response)` 时把用户消息与 finalMessage 加入普通历史；其余原因保留过程卡和安全详情但不提交历史，sideEffect 非 none 时追加本地变化提示。
6. 保留用户主动滚动、回到底部、停止、失败恢复和防重复提交行为；工具参数、结果和模型文本仍以纯文本安全呈现。
7. 添加响应式与可访问样式，确保窄屏下模式、进度、Usage、长工具名和结果不造成横向溢出，状态不只依赖颜色表达。

验证：

- 运行：`npm run lint`
- 运行：`npm run typecheck`
- 期望：两条命令均退出码 `0`；客户端事件处理穷尽、无 React/TypeScript/ESLint 错误。
- 观察：开发服务器中切换 `/plan`、`/do` 时 Network 面板无 `/api/chat` 请求；普通请求携带正确 mode，多个迭代和工具卡归属正确。

## T8：完成文档、回归与端到端验证准备

- 对应：全部需求，`plan.md` 的「验证策略」
- 文件：`README.md`、所有本轮已修改测试文件
- 依赖：T1–T7

步骤：

1. 更新 README 当前能力、Agent Loop 生命周期、六类停止原因、Plan/Do 用法、最大迭代配置、Token Usage 兼容语义、取消行为和 CLI 仍为纯文本的边界。
2. 运行完整测试并修复本轮引入的回归；不得通过放宽路径、命令、参数、超时、迭代、并发或权限限制来通过测试。
3. 依次运行 lint、typecheck、build，记录实际退出码。
4. 启动开发服务器，用 `agent-browser` 验证桌面与移动页面、过程流、模式切换、错误覆盖层和控制台，完成后关闭浏览器并停止服务器。
5. 在 tmux 中启动 Web 服务与安全的本地模拟模型，执行多迭代、混合工具、失败、无效参数、超时、最大迭代、未知工具、流错误和取消场景，确认无残留进程。
6. 若用户本地未入库模型配置可用，再执行真实模型闭环；若不可用，明确保留为 checklist 未验证项，不读取、输出或复制凭据。
7. 按 `checklist.md` 逐项记录证据；未执行或失败项保持未勾选，不以推测代替结果。

验证：

- 运行：`npm run test`
- 运行：`npm run lint`
- 运行：`npm run typecheck`
- 运行：`npm run build`
- 期望：四条命令依次退出码 `0`；浏览器与 tmux 场景达到 `checklist.md` 的可观察结果且资源全部清理。

## 执行顺序

```text
T1（模型协议）
  └──→ T2（模式策略）
        └──→ T3（安全调度）
              └──→ T4（Agent Loop）
                    └──→ T5（Web 契约/配置）
                          └──→ T6（服务端接入/移除旧 Agent）
                                └──→ T7（页面过程视图）
                                      └──→ T8（文档与完整回归）
```

这是按依赖排列的默认实施顺序。每个任务完成后先执行该任务列出的验证；只有通过后才进入下一个任务。任务中不包含提交、推送、PR 或部署操作。
