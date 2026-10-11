# MCP 客户端 Checklist

状态：已批准
依据：[已批准的 spec.md](spec.md)、[已批准的 plan.md](plan.md)、[已批准的 task.md](task.md)。

> 已按原验收清单完成实现和验证。以下勾选对应本机 macOS／Node 24 的自动测试、源码边界检查及明确记录的双端实测；不代表跨平台或任意第三方 Server 的兼容性保证。

## 需求验收

| 检查编号 | 对应验收标准 | 实施任务 | 主要证据入口 |
| --- | --- | --- | --- |
| C01—C04 | AC1 | T2 | 配置与脱敏测试 |
| C05—C07 | AC2 | T7、T9、T10 | 启动标记与双端审批事件 |
| C08—C11 | AC3 | T1、T3 | RPC／stdio 测试和 pending 数 |
| C12—C15 | AC4 | T4 | HTTP 服务请求计数与 SSE 测试 |
| C16—C18 | AC5 | T5、T8 | 消息顺序、分页和目录版本 |
| C19—C22 | AC6 | T6 | 路由与 Schema 校验测试 |
| C23—C26 | AC7 | T6、T9 | 结果、上下文、记录与完成证据 |
| C27—C30 | AC8 | T7、T10 | 权限矩阵与无请求证据 |
| C31—C33 | AC9 | T8、T9 | 启动计数、配置 key 与租约 |
| C34—C36 | AC10 | T8、T10、T11 | 故障隔离、PID、连接关闭 |
| C37—C46 | AC11、N1—N6 | T9—T11 | 架构、双端端到端、构建及交付记录 |

- [x] C01 / AC1 / F1、F2：用户层与项目层独有项合并，同名整项覆盖，args／env／headers 无残留。（验证：`npm test -- src/runtime/mcp-config.test.ts`；比对有效配置，禁止输出秘密值。）
- [x] C02 / AC1 / F1、F2：缺失文件为空配置；错误类型、重复键、alias、错误根结构、无效传输组合及 URL 按规定隔离；项目错误不回落同名用户项。（验证：配置负向用例及正常本地工具调用。）
- [x] C03 / AC1 / F2：env／headers 展开成功，缺失变量只禁用对应 Server，已定义空串保留；其他字段不展开，变量内容不递归展开。（验证：配置测试与诊断快照。）
- [x] C04 / AC1 / N3：配置凭据、headers、会话 id、stderr 与底层异常不进入浏览器事件、模型请求、运行日志、导出或示例；真实配置受保护且被 Git 忽略。（验证：脱敏测试注入可识别假秘密并断言所有输出无该值，`git check-ignore .orbitcode/mcp.yaml`。）
- [x] C05 / AC2 / F3：仅加载 stdio／HTTP 配置时启动标记不存在、HTTP 请求数为零；批准后才发生连接。（验证：初始化测试的进程／网络计数。）
- [x] C06 / AC2 / F3、F12：Web 的首次 Server 审批先于模型请求可见，CLI 同样可交互；拒绝／取消不启动，其他工具仍可用。（验证：`npm test -- tests/mcp-e2e.test.ts src/cli/mcp-session.test.ts` 及双端实际交互。）
- [x] C07 / AC2 / F3、F12：修改 command、args、env、url、headers 或继承环境后配置身份变化，旧连接批准不能复用。（验证：权限及连接测试，未批准的新目标请求数为零。）
- [x] C08 / AC3 / F4、F6：stdio 分块、多行及多字节字符边界正确；stderr 排空但不进入协议或日志，shell:false 不展开参数。（验证：`npm test -- src/mcp/stdio-transport.test.ts`。）
- [x] C09 / AC3 / F6：并发乱序响应正确配对，数字与字符串 id 不混淆，重复／未知／迟到响应不会完成另一请求。（验证：`npm test -- src/mcp/rpc-peer.test.ts`。）
- [x] C10 / AC3 / F6：超时与取消后 pending、计时器和 listener 清理；普通请求尽力发取消通知，initialize 取消只关连接；单请求取消不关闭共享连接。（验证：RPC、client 与连接测试。）
- [x] C11 / AC3 / F6、F15：非法消息、超大帧、启动失败和进程退出使等待项有界收敛；未知服务端方法返回 -32601，被动 ping 不开启健康检查。（验证：messages、RPC 与 stdio 负向用例。）
- [x] C12 / AC4 / F5：POST 的 JSON／SSE 响应可用，通知 202 无需 RPC 响应；Session 与协议版本头正确。（验证：`npm test -- src/mcp/http-transport.test.ts`，服务端记录请求头但不输出秘密。）
- [x] C13 / AC4 / F5：GET 通知流可接收通知，405 不阻断 POST；独立 GET 上伪响应不能完成 POST 请求。（验证：HTTP 集成用例及 pending 结果。）
- [x] C14 / AC4 / F5、F6：SSE 分块、CRLF、多行 data、空 data、注释和大小上限正确；断流、404、错误状态与取消产生明确结果，不自动重连、轮询或重放。（验证：`npm test -- src/mcp/sse.test.ts src/mcp/http-transport.test.ts`，请求计数保持预期。）
- [x] C15 / AC4 / F5、N3：重定向目标收不到请求或凭据；关闭释放 reader、GET 流与 HTTP 会话，DELETE 405 可接受。（验证：两个本地 HTTP 目标的计数与连接关闭事件。）
- [x] C16 / AC5 / F7：initialize → initialized → tools/list 顺序成立，不支持的版本或缺失工具能力明确不可用。（验证：`npm test -- src/mcp/client.test.ts`，握手失败后工具请求数为零。）
- [x] C17 / AC5 / F7：完整分页后才发布目录；重复 cursor、重复原名、页数／工具数超限和中途失败没有部分目录。（验证：client 与连接测试，注册工具集合精确比对。）
- [x] C18 / AC5 / F7：list_changed 合并为 dirty 标记，下个授权 Do 回合刷新；旧审批绑定原快照，不被新 Schema 替换；刷新失败不对新回合沿用旧列表或反复自动重试。（验证：client、connections 与 initialization 测试。）
- [x] C19 / AC6 / F8：不同 Server 同名工具可分别调用，规范化／长名满足模型限制；检测到命名冲突时不覆盖本地或另一外部工具。（验证：`npm test -- src/tools/mcp-tool.test.ts src/tools/registry.test.ts`。）
- [x] C20 / AC6 / F9：支持表的类型、对象、数组、字符串、数值、组合及局部引用有正反例；Schema 自身错误也被拒绝。（验证：`npm test -- src/tools/mcp-json-schema.test.ts`。）
- [x] C21 / AC6 / F9、N4：远程／循环引用、pattern、format、未知关键字和其他未支持约束不注册；复杂度／访问预算超限有明确原因。（验证：Schema 负向用例，远程引用目标请求数为零。）
- [x] C22 / AC6 / F9、F12：有效参数发送一次，无效参数零次；原参数对象修改不改变冻结的 PreparedToolCall，不填默认值、不删属性、不转类型。（验证：mcp-tool、registry 与权限测试。）
- [x] C23 / AC7 / F10：文本、structuredContent、isError、JSON-RPC 错误、媒体占位分类正确；不自动读取返回的资源链接。（验证：`npm test -- src/tools/mcp-result.test.ts`。）
- [x] C24 / AC7 / F10、F13：超长但未超硬上限的脱敏文本可经现有上下文引用取回；超硬上限明确失败，不标记完整保存；支持的 outputSchema 校验，未支持的明确未验证。（验证：结果与 ContextManager 集成用例。）
- [x] C25 / AC7 / F10、F13：发请求前拒绝为 none，已发送超时／取消为 possible；启动过 Server 后即使没有工具调用，本轮也不错误报告 none。（验证：工具结果与 runAgentTurn 初始化取消用例。）
- [x] C26 / AC7 / F13：记录含 Server、原工具、状态、耗时与审批结果；历史会话／日志可读，导出保留新元数据；Server instructions 未提升为系统指令，工具成功未自动满足 CompletionTracker。（验证：日志、会话、导出及 Agent 集成测试。）
- [x] C27 / AC8 / F11：deny > ask > allow 保持；严格／默认模式下未知 MCP 询问，放行模式默认允许，显式 ask／deny 仍优先；普通文件／命令规则不授权 MCP，外部 annotations 不降低风险。（验证：`npm test -- src/tools/mcp-permission.test.ts src/core/permissions/evaluator.test.ts`。）
- [x] C28 / AC8 / F3、F11：连接允许不等于调用允许，工具永久规则不绕过连接授权；本会话／永久允许默认绑定配置、定义与参数。（验证：权限规则与发送计数矩阵。）
- [x] C29 / AC8 / F12：跨会话、过期、重复提交、审批后参数／配置变更和新增 deny 均不能复用旧批准；Web 与 CLI 结果一致。（验证：权限 session、mcp-chat、mcp-session 测试。）
- [x] C30 / AC8 / F12：Plan 不启动或刷新 Server，不暴露外部定义，手工调用与已批准操作也在模式策略／网关被拒绝。（验证：mode-policy、gateway、initialization 测试。）
- [x] C31 / AC9 / F14：同 workspace／有效配置跨轮及并发只初始化一次；不同 workspace 不共享连接；新回合仍检查自身授权。（验证：`npm test -- src/runtime/mcp-connections.test.ts`，启动计数及租约身份。）
- [x] C32 / AC9 / F14：配置改变后旧条目 draining，不接新调用，已有发送完成后释放；新配置先审批再连接。（验证：延迟 Server 与配置切换测试。）
- [x] C33 / AC9 / F14：一个等待者取消不终止另一会话的初始化／请求；最后等待者取消可释放在途连接；容量满拒绝新连接不挤掉活动调用。（验证：连接并发与容量测试。）
- [x] C34 / AC10 / F15：正常、拒绝与故障 Server 同时配置时正常工具可用，本地工具仍可执行；离线 Server 的历史权限规则不破坏全局解析。（验证：初始化、权限与端到端组合场景。）
- [x] C35 / AC10 / F15：同配置的 failed 连接后续轮次不重复启动，配置变更／应用新初始化后才可重建；连接拒绝只影响当前权限会话。（验证：连接测试的多轮启动计数。）
- [x] C36 / AC10 / F15：CLI 正常退出及 Web／CLI SIGINT、SIGTERM 后，所拥有子进程、流和等待请求清理；忽略 TERM 的测试 Server 被有界终止，热重载不重复挂监听器。（验证：mcp-host 测试与生产宿主 PID／连接实测。）

## 集成与架构

- [x] C37 / AC11 / N1、N2：协议层仅依赖 Node／自身类型；Web 与 CLI 共用 runtime 和工具适配，没有 React／Next／CLI 反向依赖、Agent 框架或新增运行时依赖。（验证：检查 `src/mcp/` import、`git diff -- package.json package-lock.json` 与 typecheck。）
- [x] C38 / AC11 / N4：配置、消息、SSE、Schema、工具目录、pending、缓存及回合总耗时上限均有触发证据；多 Server 审批不能绕过总 deadline。（验证：相关限额用例，断言请求／进程数及有界结束。）
- [x] C39 / AC11 / N3、N6：README 与示例准确说明两层配置、授权、Schema 子集、Plan 和无重连；不存在真实凭据、日志或测试产物入库。（验证：文档检查、已知假秘密扫描、`git status --short`、`git diff --check`。）

## 端到端

- [x] C40 / AC11 / F1—F15：自动集成覆盖工作区初始化→连接审批→发现→调用审批→真实 stdio／HTTP 请求→结构化结果→最终回复，故障 Server 不阻断其他工具。（验证：`npm test -- tests/mcp-e2e.test.ts`，记录实际请求计数与结果断言。）
- [x] C41 / AC11 / F6、F10—F12：双传输覆盖无效参数、工具失败、超时、取消、审批拒绝和最大循环次数，错误收敛且没有未授权请求。（验证：端到端错误场景，每个 case 保存预期／实际 stop reason 与计数。）
- [x] C42 / AC11 / F12、N6：开发服务器下用 agent-browser 实际检查 Web 的两种传输、启动审批、调用审批、拒绝、停止和历史展示；无错误覆盖层或未处理控制台错误，结束后关闭浏览器及服务。（验证：记录实际交互与观察；截图仅作临时证据，不入库。）
- [x] C43 / AC11 / F12、N6：tmux 内运行 CLI，完成真实对话输入、审批、工具执行、最终回复和退出；无终端审批输入能力时明确拒绝而非挂起。（验证：tmux 交互记录、Server 启动／调用／退出计数；注明使用脚本 Provider 还是真实模型。）

## 项目检查

- [x] C44 / AC11 / N6：ESLint 通过。（验证：`npm run lint`，退出码 0。）
- [x] C45 / AC11 / N6：TypeScript 严格类型检查通过。（验证：`npm run typecheck`，退出码 0。）
- [x] C46 / AC11 / N6：生产构建通过。（验证：`npm run build`，退出码 0；之后执行 C36 的生产宿主退出验证。）

## 实际结果（2026-09-19）

实现完成；验收通过 **46 / 46**。测试环境为本机 macOS、Node.js 24.15.0。四份文档已批准后实施，没有新增运行时依赖、提交或推送。

最终命令：

- `npm test`：退出 0，404 项通过，0 失败／跳过。
- `npm run check`：依次执行 lint、typecheck、build，均退出 0；生产构建成功。
- `git diff --check`：退出 0。
- `git check-ignore .orbitcode/mcp.yaml`：命中忽略规则；测试用真实配置随后已删除。
- `git diff -- package.json package-lock.json`：无变更；协议生产模块只依赖 Node API 和自身类型。

下表的自动测试都包含在最终 `npm test` 中，退出状态均为 0。源码检查与实际 UI／宿主交互单独注明，避免把单元测试当成真实模型或浏览器证据。

| 编号 | 实际证据与结果 |
| --- | --- |
| C01 | `mcp-config.test.ts`：独有项合并、stdio→HTTP 整项覆盖，无旧 env 残留。 |
| C02 | 同上：缺失为空；重复键、alias、非法类型／URL 和无效覆盖拒绝；故障隔离端到端保留正常工具。 |
| C03 | 同上：空值保留、只展开一次、command／args 保留字面量，未定义变量禁用对应项。 |
| C04 | `mcp-e2e.test.ts` 假凭据在模型请求、可见事件、完整上下文、日志与导出均不存在；工具测试覆盖 JSON 转义秘密；stdio 测试覆盖 stderr，HTTP 会话头不进入事件的源码检查通过。 |
| C05 | 双传输 e2e 在 `prepare` 后断言启动标记不存在／请求数为零，审批后才连接。 |
| C06 | Web e2e 断言首个连接审批早于模型请求；CLI 测试与 tmux 实测正常；拒绝／取消场景完成。 |
| C07 | 配置测试检查 command／args／env／继承 PATH 身份变化；HTTP 配置也整体参与摘要；网关测试在复检时拒绝配置变化。 |
| C08 | stdio 测试通过 UTF-8 按字节输出、stderr 排空、字面 Shell 参数以及真实进程调用。 |
| C09 | RPC 测试通过乱序、字符串／数字 id 区分、未知和迟到响应隔离。 |
| C10 | RPC、HTTP、连接测试检查 pending 清零、超时／取消、initialize 无取消通知、单等待者隔离。 |
| C11 | messages／stdio／RPC 测试覆盖超大和畸形帧、不可执行路径、进程中途退出及未知方法；被动 ping 分支源码检查通过。 |
| C12 | HTTP 测试实收 JSON、SSE、202，验证 Session／协议版本头及 DELETE。 |
| C13 | HTTP 测试 GET 收到 list_changed；405 兼容；独立流伪响应使连接失败而不配对 POST。 |
| C14 | SSE 测试覆盖分块、CRLF、多行／空 data 和超限；HTTP 404、超时／取消无重放；断流分支源码检查通过。 |
| C15 | 两个 HTTP 目标测试断言重定向目标零请求；关闭取消 reader／GET，DELETE 405 可接受。 |
| C16 | client 测试断言握手顺序；错误版本／缺失 tools 能力时 tools/list 请求为零。 |
| C17 | client 测试覆盖重复 cursor、重名、129 工具和第 32 页；初始化容量测试确认无部分目录发布。 |
| C18 | connections 测试合并通知、下一次 acquire 刷新、旧租约保留旧工具、刷新失败后不重试；并发刷新复用同一 Promise。 |
| C19 | tool 测试验证 Server 命名隔离、长名长度；目录重名测试与注册冲突检查保留本地工具。 |
| C20 | Schema 测试覆盖类型、属性、数组、Unicode、范围、组合及本地引用的正反例。 |
| C21 | Schema 测试拒绝远程／循环引用、未知约束、深度／节点／访问预算超限；实现无引用 fetch。 |
| C22 | 双传输 e2e 有效调用恰好一次、无效参数零次；Schema 测试验证原对象修改不改变冻结副本、不填默认值。 |
| C23 | result／RPC 测试区分工具错误和协议错误，保留结构化结果，媒体和链接只占位。 |
| C24 | MCP 大结果 e2e 实际卸载并读取完整安全文本，导出含完整上下文；结果测试区分 validated、协议错误与 unsupported-schema。 |
| C25 | 双传输 e2e 断言无效／拒绝为 none，发送后取消／总超时为 possible；成功启动后的停止记录保留 possible。 |
| C26 | e2e 检查 schemaVersion 5、原 Server／工具身份及导出；原会话／日志兼容测试全通过。client 不提升 Server instructions；真实模型的 MCP 完成证据被 CompletionTracker 拒绝。 |
| C27 | MCP 权限测试覆盖严格／默认模式 ask、放行模式 allow；固定规则离线解析且 deny 优先，外部 mutability 固定为 external。 |
| C28 | 双传输 e2e 实际经过两级审批；权限测试验证 mcp_connect 不授权 mcp_call、会话／永久目标精确绑定。 |
| C29 | MCP 权限测试验证跨会话、重复决定、参数／定义／配置变更和新增 deny；既有 session 测试覆盖过期；共享 Web／CLI 审批测试通过。 |
| C30 | 初始化测试 Plan 不读配置／连接；e2e 无启动标记；模式策略／网关硬拒绝外部工具。 |
| C31 | connections 测试断言同配置启动一次、不同工作区隔离；e2e 每回合仍经过独立权限会话。 |
| C32 | connections 测试验证 draining 拒绝后续调用、已发送请求收尾、释放旧连接；另覆盖删除配置的空闲与活动租约。 |
| C33 | connections 测试覆盖单等待者／最后等待者取消及 128 个活动缓存，满载不驱逐活动租约。 |
| C34 | e2e 同时配置故障、拒绝和正常 Server，read_file 与外部 echo 都成功；MCP 规则独立解析。 |
| C35 | connections 测试失败缓存只启动一次，拒绝授权零次创建，配置变化建立新连接。 |
| C36 | host 测试覆盖 SIGINT、SIGTERM、宿主立即退出；忽略 TERM 进程约 2 秒内回收。tmux 正常退出及生产 Next 两种信号实测 PID 消失；globalThis 保持单宿主／监听器。 |
| C37 | import 检查通过，Web／CLI 共用 AgentRuntime；package 与 lock 无改动。 |
| C38 | config／messages／SSE／Schema／client／RPC／connections／initialization 测试触发各类限额；双传输总 deadline 场景按 max-runtime 收敛。 |
| C39 | README 和示例说明配置、Schema 子集、授权、Plan 与无重连；Git 检查无测试产物或真实配置入库。 |
| C40 | `tests/mcp-e2e.test.ts`：两种传输都完成发现、两级审批、实际调用、结果、最终回复和落盘；故障隔离组合场景通过。 |
| C41 | 同一文件两种传输分别覆盖 invalid、fail、deny、cancel、deadline、max；协议测试另验证请求 timeout。 |
| C42 | agent-browser 实测见下文：双传输、两级审批、拒绝、停止与历史恢复；无覆盖层或控制台错误；浏览器和服务已关闭。 |
| C43 | tmux 内 tertiary 完成 CLI_MCP_OK，保存 revision 1，/exit 后进程消失；非 TTY 自动拒绝由 CLI 测试覆盖。 |
| C44 | 最终 `npm run check` 中 ESLint 退出 0。 |
| C45 | 同上，TypeScript 严格检查退出 0。 |
| C46 | 同上，Next 生产构建退出 0；构建后生产宿主 SIGTERM／SIGINT 再验证通过。 |

### 实际交互证据

- Web 使用 `tertiary`，会话 `70a7e3b3-d975-497d-aa10-7e2bdc0d93da`。agent-browser 操作连接审批和独立调用审批，stdio 返回 `WEB_STDIO_OK`，HTTP 返回 `WEB_HTTP_OK`；最终回复形成闭环，刷新后初始化摘要和工具结果仍存在。
- 同一 Web 会话拒绝 HTTP 连接，再于 stdio 连接审批点击停止，持久化停止原因为 `cancelled`。实测发现并修复审批 HTTP 响应覆盖 SSE 终态的竞态，新增 reducer 回归；取消时的详情也改为明确的取消说明。
- 浏览器 `[data-nextjs-dialog]` 数量为 0；`agent-browser errors` 为空；console 仅含 React DevTools 提示和 HMR 日志。截图位于 `/tmp`，没有入库。
- CLI 使用 tmux 和真实 `tertiary`，会话 `0df63fb3-fe2f-4894-ab5b-ade589f897ea`。拒绝 HTTP 后批准 stdio 连接和 echo 调用，返回 `CLI_MCP_OK`，`final-response`、2 轮、保存 revision 1；随后 `/exit`，其 stdio PID 已不存在。
- 最终生产构建使用 `next start --port 3099`，真实 API 连接审批后取消回合，分别发送 SIGTERM／SIGINT。验收会话为 `6d18aaa1-d2f0-4056-93a2-452845d66cbd`、`598a93d5-ae29-4e61-a928-2a5213f10850`；两次均检查子进程 PID 消失，宿主退出。
- 开始验收时原 Workspace 配置含不可访问目录，临时备份后只保留当前仓库。结束已逐字节恢复原文件，并删除自建 `.orbitcode/mcp.yaml`；未改动原权限规则。浏览器、开发／生产服务器、HTTP 替身、tmux 均已关闭，未遗留 stdio 测试进程。

### 适用范围

已验证本机 macOS 的 stdio 进程组回收及回环 HTTP 服务；未验证 Windows、远程部署或任意第三方 Server。外部 Server 不是文件沙箱内的进程，不保证阻止其自行脱离进程组或访问主机数据；连接与调用授权是本轮的控制边界。真实模型一次成功不代表工具选择稳定性保证。协议仅支持工具能力及文档列明的 Schema 子集，没有自动重连、健康检查或非工具能力。

## 复核与修正（2026-10-11）

- 同步后续放行模式调整：strict／default 的未知 MCP 操作询问，permissive 默认允许；显式 ask／deny 仍优先。已更新 spec F11、task T7 与 C27，README 与实现保持一致。
- 外部调用后通过 `read_context` 读取卸载结果时，未提交模型完成报告的状态仍为 `observed`；只列出外部调用证据，不把答复内容或外部副作用标为已验证，也不因此开放本地完成报告工具。自动端到端覆盖了实际三轮调用。
- 模型视图仅在文本可证明是结构化结果的完整重复表示时移除该文本；额外文本保留，持久化展示仍保留脱敏后的两种表示。回放此前保存的 Cloudflare 搜索结果：模型结果序列化长度由 35093 降至 17996 字符，十条结构化结果仍在；这是本地回放，不是新的远程调用。
- 中文用户输入时的系统提示现明确覆盖工具调用前说明；已检查提示实际进入模型请求。模型是否始终遵从仍需真实模型复测，不能仅凭提示测试宣称彻底消除英文开场。
- 当前 `npm test`：415 项通过，0 失败／跳过；`npm run check`：lint、typecheck、build 全部通过；`git diff --check` 通过。上述命令均在本次修正后执行，原“实际结果（2026-09-19）”保留为当时的历史记录。
