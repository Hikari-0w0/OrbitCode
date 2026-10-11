# MCP 客户端 Tasks

状态：已批准
依据：[已批准的 spec.md](spec.md)、[已批准的 plan.md](plan.md)。用户已批准开始开发，按下列任务执行并记录验证。

## 文件清单

下表按聚焦成果列出文件。现有文件保持原职责，测试文件随任务创建或扩充，不提前生成空实现。

| 任务 | 新建 | 修改 | 对应需求 |
| --- | --- | --- | --- |
| T1 | `src/mcp/types.ts`、`src/mcp/messages.ts`、`src/mcp/messages.test.ts` | 无 | F6、F7、F10 |
| T2 | `src/runtime/mcp-config.ts`、`src/runtime/mcp-config.test.ts`、`src/lib/mcp-redaction.ts`、`src/lib/mcp-redaction.test.ts`、`.orbitcode/mcp.example.yaml` | `src/tools/protected-paths.ts`、`src/tools/workspace.test.ts`、`.gitignore` | F1—F3、F15 |
| T3 | `src/mcp/rpc-peer.ts`、`src/mcp/rpc-peer.test.ts`、`src/mcp/stdio-transport.ts`、`src/mcp/stdio-transport.test.ts`、`tests/fixtures/mcp/stdio-server.mjs` | 无 | F4、F6、F15 |
| T4 | `src/mcp/http-transport.ts`、`src/mcp/http-transport.test.ts`、`src/mcp/sse.ts`、`src/mcp/sse.test.ts`、`tests/helpers/mcp-fixture.ts` | 无 | F5、F6、F15 |
| T5 | `src/mcp/client.ts`、`src/mcp/client.test.ts` | 双传输测试替身 | F7 |
| T6 | `src/tools/mcp-json-schema.ts`、`src/tools/mcp-json-schema.test.ts`、`src/tools/mcp-tool.ts`、`src/tools/mcp-tool.test.ts`、`src/tools/mcp-result.ts`、`src/tools/mcp-result.test.ts` | `src/tools/{types,registry,default-registry,mode-policy}.ts`、`src/core/tool-scheduler.ts` 及相应测试 | F8—F10、F12、F13 |
| T7 | `src/tools/mcp-permission.test.ts` | `src/core/permissions/{types,rules,evaluator,approval}.ts`、`src/tools/{permission-target,permission-gateway,permission-config}.ts`、`src/runtime/permission-session-manager.ts` 及相应测试 | F3、F11、F12 |
| T8 | `src/runtime/mcp-connections.ts`、`src/runtime/mcp-connections.test.ts`、`src/runtime/mcp-host.ts`、`src/runtime/mcp-host.test.ts` | 无 | F14、F15 |
| T9 | `src/runtime/mcp-initialization.ts`、`src/runtime/mcp-initialization.test.ts` | `src/runtime/{agent-runtime,run-agent-turn,types,agent-run-tracker}.ts`、`src/core/agent-loop.ts`、`src/core/conversations/{types,validation,display-timeline}.ts`、`src/lib/{local-agent-run-log,local-conversation-exporter,local-agent-run-exporter}.ts` 及相应测试 | F3、F12—F15 |
| T10 | `tests/mcp-e2e.test.ts`、`src/cli/mcp-session.test.ts` | `src/web/{agent-runtime,chat-handler,chat-contract}.ts`、`src/app/api/chat/route.ts`、`src/components/{chat-workspace,permission-request-card,message-list}.tsx`、`src/components/chat-session-state.ts`、`src/cli/{main,renderer,session-controller}.ts` 及相应测试 | F3、F11—F15 |
| T11 | `tests/mcp-e2e.test.ts`、`tests/helpers/openai-mock.ts`（复用）、`tests/fixtures/mcp/README.md` | `README.md`、本目录 `checklist.md` | F1—F15、N1—N6 |

实施时将 HTTP 替身集中在既有 HTTP 测试辅助模块，Web MCP 闭环集中在 `tests/mcp-e2e.test.ts`；不重复创建功能相同的 fixture。新增安全边界场景进入测试，文案等低影响变更不单独堆测试。

## T1：协议领域类型与消息边界

- 对应：F6、F7、F10；plan「核心类型与接口」「协议与双传输」。
- 文件：文件清单 T1。
- 依赖：无。

步骤：

1. 定义协议自有 JSON、JSON-RPC 消息联合、工具描述与结果、transport handlers、结构化错误和限额，不导入 tools/runtime/UI。
2. 实现外壳和方法结果校验，明确数字／字符串 id、notification 与 request 区别、result/error 互斥、batch 拒绝。
3. 消息错误不携带原始载荷，支持有限安全错误码；控制消息大小及 JSON 深度。

验证：`npm test -- src/mcp/messages.test.ts`。正常请求、通知、响应正确分类；畸形对象、混合响应字段、非法 id、超限消息被拒绝，错误输出无原始秘密。

## T2：配置、合并与秘密处理

- 对应：F1—F3、F15、N2—N4；plan「配置契约」「资源限制与错误分类」。
- 文件：文件清单 T2。
- 依赖：T1。

步骤：

1. 加载用户／工作区配置，按原始 Server 名整项覆盖后再展开 env／headers；为可定位项保留错误，根结构损坏按计划隔离。
2. 校验传输配置及容量，生成有效配置身份；在最终子进程环境确定后纳入摘要，加载过程不得 spawn 或 fetch。
3. 将摘要／已知秘密过滤从协议层分离；覆盖 URL query、嵌入式秘密、大小写重复 headers、保留 headers、无效变量。
4. 新增无真实凭据的示例及忽略项，把真实 mcp.yaml 纳入受保护路径，保持本地文件边界回归。

验证：`npm test -- src/runtime/mcp-config.test.ts src/lib/mcp-redaction.test.ts src/tools/workspace.test.ts`。同名项目整项替换，未定义变量逐项失败，无效覆盖不回落；只读加载的进程／网络计数为零，秘密不出现在诊断、示例与错误中。

## T3：JSON-RPC 请求调度与 stdio

- 对应：F4、F6、F15；plan「协议与双传输」。
- 文件：文件清单 T3。
- 依赖：T1。

步骤：

1. 实现 pending map、非复用 id、deadline、signal、发送状态和一次性收敛；notification 无 pending。
2. 编写可控 stdio Server 替身：启动标记、请求计数、乱序、延迟、畸形输出、stderr、忽略 SIGTERM 等模式。
3. 实现按行 UTF-8 分帧、有限缓冲、背压、显式 cwd／env、shell:false 和退出检测；不把 stderr 当错误或转发原文。
4. 覆盖被动 ping、未知方法 -32601；取消普通请求发 best-effort 通知，initialize 取消只关闭传输。
5. 实现关闭输入、TERM、KILL 的有界退出及拥有的进程组清理。

验证：`npm test -- src/mcp/rpc-peer.test.ts src/mcp/stdio-transport.test.ts`。多请求乱序正确配对，超时／取消后 pending 与监听器归零，迟到响应无交叉完成；启动失败、关闭与强制终止有退出证据，命令参数未被额外 shell 展开。

## T4：Streamable HTTP 与 SSE

- 对应：F5、F6、F15；plan「协议与双传输」。
- 文件：文件清单 T4。
- 依赖：T1、T3。

步骤：

1. 编写仅监听回环地址的 HTTP 替身，支持 JSON、SSE、202、405、404、重定向、延迟和断流。
2. 实现独立 POST、增量有界 SSE、会话及版本头、GET 通知流与 DELETE；连接和 reader 由 transport 明确持有。
3. 禁止自动重定向、旧传输回落、自动重连和调用重放；断流、超时与取消不得误取消其他独立请求。
4. 限制 GET 建立等待和单事件内存，忽略空 data／注释，不把独立 GET 流的伪响应配对给 POST。

验证：`npm test -- src/mcp/sse.test.ts src/mcp/http-transport.test.ts`。两种响应可用，通知收到 202，GET 405 不导致正常 POST 失败；Session／Version 正确，错误与关闭收敛，重定向目标请求数为零，原调用没有自动重放。

## T5：握手、分页和不可变工具目录

- 对应：F7；plan「初始化与工具目录」。
- 文件：文件清单 T5。
- 依赖：T3、T4。

步骤：

1. 实现初始化协商及 initialized 顺序，限制客户端能力，仅接受协议基线及工具能力。
2. 实现共享发现 deadline、cursor 去重、页数／工具数上限，临时列表完整验证后发布。
3. 目录附版本；list_changed 只标记 dirty，暴露由 runtime 在下次 Do 回合触发的刷新能力。
4. 忽略 Server instructions，拒绝只能以 tasks 调用的工具；处理发现返回重复原名和错误结构。

验证：`npm test -- src/mcp/client.test.ts`。记录消息顺序及分页参数；握手失败无 tools/list，分页中断无部分注册，无通知风暴下无限刷新；旧快照不可变。

## T6：Tool 适配、Schema 和结果

- 对应：F8—F10、F12、F13；plan「命名与参数校验」「运行事件、结果与持久化」。
- 文件：文件清单 T6。
- 依赖：T2、T5。

步骤：

1. 拆出 LocalToolName，新增受限 MCP 名与 external mutability；命名稳定、冲突拒绝，保留原始身份映射。
2. 按 plan 支持表实现 Schema 自身校验与有界解释，所有不支持关键字明确拒绝；覆盖组合、Unicode、结构相等、局部引用及引用兄弟约束。
3. 复制、深冻结参数／定义，计算 schemaId、argumentsId；执行只使用已验证快照，不读取可变输入。
4. 工具适配器只持有授权租约，沿 existing ToolRegistry prepare → PermissionGateway → scheduler → execute 调用；Plan 双重拒绝 external。
5. 转换文本／结构化内容、isError、协议错误和媒体占位，副作用区分发送前后，统一脱敏；不自动获取资源。
6. default registry 接受追加的 RegisteredTool，保持本地工具不变；调度器让 external 使用 60 秒和串行通道。

验证：`npm test -- src/tools/mcp-json-schema.test.ts src/tools/mcp-tool.test.ts src/tools/mcp-result.test.ts src/tools/registry.test.ts src/tools/mode-policy.test.ts src/core/tool-scheduler.test.ts`。

期望：两 Server 同名正确路由；所有无效参数／不支持 Schema 的调用发送数为零；原对象修改不影响 PreparedToolCall；文本和结构化内容可辨识，超限不假称完整保存；Plan 中没有外部定义且手工调用被拒绝。

## T7：连接与调用授权

- 对应：F3、F11、F12；plan「权限与 Plan Mode」。
- 文件：文件清单 T7。
- 依赖：T2、T6。

步骤：

1. 新增 MCP permission subject／target，区分 connect 与 call；运行时操作复用网关评估、broker、persistAllow 与 revalidate，不能加入模型定义。
2. 规则增加固定 mcp_connect／mcp_call 入口，与动态模型名分离；精确目标含 configurationId，调用再含 schemaId／argumentsId。
3. 更新 subjectKey、sameSubject、永久规则格式及目标编码；一次授权绑定参数，会话／永久授权默认也不跨配置和参数。
4. 明确无匹配 MCP 在 strict/default 模式下 ask、permissive 模式下 allow，保持 deny > ask > allow，现有文件／命令规则不匹配外部操作。
5. 发送前重新读取配置与权限；拒绝审批后变化、过期、跨会话和 Plan 操作；摘要展示安全的 Server、原工具与参数。
6. 失败／未注册 Server 的已有 MCP 规则仍可解析，不污染本地权限评估。

验证：`npm test -- src/tools/mcp-permission.test.ts src/core/permissions/rules.test.ts src/core/permissions/evaluator.test.ts src/tools/permission-gateway.test.ts src/tools/permission-config.test.ts src/web/permission-session-manager.test.ts`。

期望：连接授权与调用授权独立；逐个拒绝路径 Server 请求数为零；同名不同配置、工具定义／参数改变不复用旧批准；离线 Server 规则存在时 read_file 等本地工具仍可评估并运行。

## T8：连接缓存、故障隔离与关闭

- 对应：F14、F15；plan「连接缓存与宿主生命周期」。
- 文件：文件清单 T8。
- 依赖：T2、T5、T7。

步骤：

1. 实现 workspace／Server／configurationId key、状态联合、并发 initialize promise 和回合租约；每个 acquire 先验证自己的授权能力对象。
2. 初始化独立 controller 不由第一个请求独占；单等待者取消不影响其他等待者，零等待者取消在途初始化。
3. ready 跨回合缓存，故障 key 不重复尝试；配置变更让旧条目 draining，阻止新调用并等待已发调用结束。
4. 容量满时只淘汰空闲 ready，不借淘汰 failed 引入自动重试；dirty 目录在授权后合并刷新。
5. 实现幂等 close 与宿主注册辅助器；信号 listener 不重复注册，不创建 Server，不吞退出，不使用异步 exit 清理。

验证：`npm test -- src/runtime/mcp-connections.test.ts src/runtime/mcp-host.test.ts`。连续多轮和并发只有一次启动；跨工作区不共享；会话拒绝不影响其他会话；一个请求取消不关闭共享连接；失败 key 无再启动，旧配置最终关闭，资源上限可观察。

## T9：共用运行编排、上下文和记录

- 对应：F3、F12—F15；plan「运行事件、结果与持久化」。
- 文件：文件清单 T9。
- 依赖：T6、T7、T8。

步骤：

1. PreparedAgentTurn 支持惰性初始化生成器，在 runAgentTurn 建立 tracker 后执行；保留直接 agent 输入，prepare 不等待人类批准。
2. beginTurn 和会话标记先建立，初始化按 Server 稳定顺序提出审批；拒绝单 Server 后继续，Plan 跳过外部初始化。
3. RuntimeInitializationEvent 经独立通道输出；初始化完成建立 registry 和 AgentLoop，传剩余总时间预算。
4. finally 统一释放租约、审批和会话操作；取消初始化也返回持久化 stopped，合并启动副作用，不虚构模型轮次。
5. 增加初始化摘要及外部身份元数据，扩展记录、会话和导出校验，保留旧数据读取；原始配置和底层异常不落盘。
6. 验证 MCP 定义计入工具预算、长结果进入已有上下文压缩／引用链、Server 文本不进入 system instructions、成功不自动满足 CompletionTracker。

验证：`npm test -- src/runtime/mcp-initialization.test.ts src/runtime/agent-runtime.test.ts src/core/agent-loop.test.ts src/core/context/context-manager.test.ts src/core/conversations/validation.test.ts src/core/conversations/display-timeline.test.ts src/lib/local-agent-run-log.test.ts`，补充执行实际改动的 exporter 同名测试。

期望：首次审批发生在模型调用前且可消费；部分 Server 故障后本地 Agent 可运行；初始化取消仍结束并释放租约；已有会话和运行记录可读；已知假秘密在模型请求、事件、持久化和日志中均不可检出。

## T10：Web 与 CLI 接入及退出

- 对应：F3、F11—F15；plan「架构概览」「权限与 Plan Mode」「连接缓存与宿主生命周期」。
- 文件：文件清单 T10。
- 依赖：T9。

步骤：

1. Web 宿主注入进程级 manager，prepare 完成后立即建立 SSE，由惰性初始化产生审批；保留原请求安全／错误状态码。
2. Web contract 严格解析新初始化事件、错误类型和可选元数据；reducer、message list 与 card 呈现状态并复用 decisions API，不显示 secrets。
3. CLI renderer 消费同样初始化事件，session controller 将批准／拒绝发送到原 broker；非交互输入遇到审批自动拒绝，不挂起。
4. CLI finally await runtime.close；Web SIGINT／SIGTERM 调用幂等关闭，开发热重载不叠加 listeners。
5. 覆盖刷新历史、审批过期、停止按钮、终端中断和重复提交；保持本地工具 UI 行为。

验证：`npm test -- src/web/mcp-chat.test.ts src/cli/mcp-session.test.ts src/components/chat-session-state.test.ts src/components/chat-workspace.test.tsx src/cli/renderer.test.ts src/cli/terminal-chat.test.ts`。

期望：Web 首次启动审批在流上出现，不等待初始化完成；CLI 同样可响应；拒绝启动无标记文件，取消无挂起，旧会话可展示，新字段不能绕过严格事件校验。真实浏览器与宿主信号检查在 T11 完成。

## T11：端到端验收与使用说明

- 对应：F1—F15、N1—N6；plan「验证策略」及全部 AC。
- 文件：文件清单 T11。
- 依赖：T1—T10 完成并通过各自验证。

步骤：

1. 将 stdio／HTTP 替身与脚本 Provider 组合成临时工作区测试。Provider 按确定序列返回外部工具调用，错误场景由开关选择；只使用假凭据，所有输出和进程在 finally 清理。
2. 执行 `npm test -- tests/mcp-e2e.test.ts`，覆盖初始化→审批→发现→调用审批→真实本地传输→结果→最终回复，并覆盖无效参数、失败、超时、取消、最大循环上限及单 Server 故障。
3. README 写配置路径、整项覆盖、env 展开、两层授权、受限 Schema、Plan 边界、无重连与退出语义；示例不含真实 Server 地址／凭据。
4. 启动开发服务器，以 agent-browser 检查两个传输的成功、拒绝和取消。记录页面实际内容、错误覆盖层、控制台错误与启动／请求次数，结束后关闭浏览器和服务器。
5. 在 tmux 运行 `npm run cli -- --config <临时配置>`，执行真实终端审批与对话；验证 `/exit` 和信号退出后的进程清理。运行脚本 Provider 时报告为“替身模型端到端”，不得称为真实模型通过。
6. 依次执行 `npm run lint`、`npm run typecheck`、`npm run build`。构建成功后以 `npm run start` 启动生产进程，初始化一个子进程 Server，再发送 SIGTERM，检查本轮拥有的 Server pid 与连接释放；相同方法检查 SIGINT。
7. 对照 checklist 逐项填写命令、退出码、请求计数／PID／可观察结果。检查文档差异与已知假秘密是否泄漏；所有未执行项保留未勾选。若真实模型不可用，明确限制，不能用替身结果代替。

验收证据：通过的测试记录、双端交互结果、进程及请求次数、构建退出状态和已填写 checklist。浏览器／tmux 不可用等环境限制列为未验证，不将启动端口或最终回复当作成功证据。

## 执行顺序

```text
T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11
```

按顺序实施以控制跨模块类型变更；本计划不要求多 Agent 并行，不包含提交、推送或 PR。本轮已获用户授权，按任务实施并验证。

## 实施记录（2026-09-19）

T1—T11 已实现。协议、配置、适配、权限、缓存、初始化、双端展示与记录均有测试入口；逐项验收见 [checklist.md](checklist.md)。

机械性文件调整：新增 `src/core/mcp-events.ts` 承载安全初始化事件；不需要修改 AgentLoop、模式白名单、PermissionSessionManager、API 路由和导出算法，这些既有抽象已经可复用。新增运行记录元数据与 schemaVersion 5，保留旧日志读取兼容。测试复用 `tests/helpers/runtime-fixture.ts` 和既有模型替身，实际涉及文件以工作区差异为准。

实现中修复了浏览器实测发现的审批 HTTP 响应覆盖 SSE 终态竞态；配置删除与切换时清理旧连接；Next 宿主直接退出时同步回收所拥有的 stdio 进程组。这些均在原定授权、生命周期和验收范围内。
