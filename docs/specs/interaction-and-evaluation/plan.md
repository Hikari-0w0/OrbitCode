# 界面配置与 Agent 评测闭环 Plan

状态：已批准
日期：2026-10-11
依据：[spec.md](spec.md) 已批准
关联：[实施任务](task.md) · [验收清单](checklist.md)

## 1. 当前基线与架构

已核对 `src/runtime/config.ts`、`workspace-config.ts`、`mcp-config.ts`、`agent-runtime.ts`，`src/cli/{arguments,main,terminal-chat,session-controller}.ts`，现有 providers/workspaces GET 路由、`chat-workspace.tsx`、`tests/cli-agent.e2e.test.ts` 和 `docs/evals/README.md`。这只是源码调研，不表示本轮已运行验证。

当前 Provider 身份使用 name，模型 available 仅说明环境变量存在。Workspace 已有稳定 ID。runtime 在 prepare 时加载配置；MCP 连接按工作区、名称、配置指纹缓存。现有 invalidate 会使连接进入 draining，不能不加区分地用于普通配置编辑。CLI 管道会等待完整行处理，遇到审批自动拒绝，final-response 不保证任务正确。运行日志仅结束后落盘，需增加执行前后的可关联记录。

采用以下方向：

```text
Web 设置/聊天 ─ HTTP + 展示投影 ─┐
CLI 交互/单次执行 ─ 输出适配 ───┼─ runtime 配置服务/会话/执行 ─ core/models/tools
评测执行器 ─ 调用单次 CLI ─────┘             │
                                  私密配置仓库/既有日志与检查点
```

评测验收器在 CLI 结束后独立运行，不进入 Agent 工具集合。`core` 不依赖设置页面、HTTP 或评测器。页面只调用结构化契约；Web 和 CLI 使用同一配置解析、授权与执行路径。

## 2. 需求映射

| 需求 | 负责模块/交互 | 章节 |
| --- | --- | --- |
| F1 | 设置页、配置状态接口、聊天空态 | 3、5 |
| F2 | 配置服务、凭据投影、模型探测服务 | 3、5 |
| F3 | 配置服务、既有 workspace boundary | 3、5 |
| F4 | MCP 管理服务、连接租约、设置页 | 4 |
| F5 | 旧配置导入器、来源解析 | 3 |
| F6 | 配置版本、运行快照、会话绑定 | 3、4 |
| F7 | 聊天状态与结果摘要 | 5 |
| F8 | CLI 单次执行器和结果协议 | 6 |
| F9 | 共享权限网关和非交互策略 | 6 |
| F10 | 存储路径工厂和评测执行环境 | 6、7 |
| F11 | 配置/协议/集成测试、浏览器流程 | 8 |
| F12 | 固定任务、独立工作区和验收器 | 7 |
| F13 | 评测结果、版本元数据和对比报告 | 7 |

## 3. 配置管理、凭据与兼容性

### 3.1 存储与来源

新增 `src/runtime/settings-types.ts`、`settings-service.ts`、`settings-import.ts` 和 `src/lib/local-settings-store.ts`。托管配置默认存于 `~/.orbitcode/settings-v1.json`：一个版本化文档保存模型、工作区、分作用域 MCP、默认项与凭据引用及私密值。选择单文件事务避免设置成功但凭据更新失败的跨文件不一致；服务端保留私密类型，任何公开 DTO 只使用显式字段白名单投影。

配置文件及备份为 0600，父目录 0700；有界读取，校验 schema，拒绝目标文件符号链接。跨进程使用独占写租约，锁内重读 revision，临时文件写入并同步后 rename，返回新 revision；不匹配报 conflict。租约超时不得直接抢占仍存活进程，崩溃恢复参考现有会话租约思路。恢复损坏配置须用户显式选择恢复备份或初始化；保留损坏文件，不能自动变成空配置。可用的备份不能包含比主文件宽松的权限。

来源优先级：

1. CLI 显式 `--config`：本次模型使用指定旧文件；其他资源保持当前已选来源，结果分别记录各资源来源，不写回旧文件。
2. 存在有效托管配置：默认模型、工作区和 MCP 全部来自托管配置，不自动合并旧文件。
3. 不存在托管配置：兼容旧加载规则，展示“旧配置只读模式”和导入入口；旧模型文件缺失视作未配置，不能阻断设置页。
4. 托管配置存在但损坏：返回配置故障，不回退旧文件。

导入器读取用户显式选择的旧模型/工作区文件与既有用户/项目 MCP 位置；不提供任意文件读取接口。先校验整个批次，预览来源、同名冲突与环境变量缺失，确认后单事务提交。冲突须显式选保留或替换；环境引用保留为引用，不复制进程环境明文。新建安装允许从空集合开始；旧解析器“providers 非空”不直接沿用作设置仓库约束。

MCP 用户和工作区层均存入私密仓库，工作区层以 workspaceId 关联。同名工作区项整项覆盖用户项；工作区禁用项可屏蔽用户同名项，删除工作区项会恢复用户层并提示。旧项目文件更新后只能显式再次导入，无隐式热加载。项目配置共享通过脱敏导出实现，不自动写入工作区。

### 3.2 身份、版本与凭据

新模型使用独立 ID 和可变 displayName，既有 workspaceId 保留。导入旧模型时保留 name 作为旧会话可解析的兼容身份，不通过模糊名称匹配重绑定。停用模型/移除工作区使用归档标记，默认项不能指向归档资源，相关会话只读；继续工作通过显式选新绑定创建新会话，不修改旧 revision。工作区根目录不可就地替换。

```ts
type CredentialInput =
  | { readonly kind: "keep" }
  | { readonly kind: "replace"; readonly value: string }
  | { readonly kind: "environment"; readonly variable: string }
  | { readonly kind: "clear" };

type SettingsState =
  | { readonly kind: "ready"; readonly revision: number; readonly source: "managed" | "legacy" }
  | { readonly kind: "empty" }
  | { readonly kind: "invalid"; readonly code: "schema" | "storage"; readonly recoveryAvailable: boolean };

type SettingsErrorCode =
  | "validation" | "conflict" | "storage" | "credential-missing"
  | "resource-unavailable" | "unauthorized" | "cancelled" | "timeout";
```

新建时 keep 无效；列表只返回 hasCredential 和引用来源。编辑空密码默认 keep，清除是独立动作。模型和 MCP env/headers 的敏感值执行同样规则。普通导出仅保留引用/待补充标记；不提供带密钥导出。私密文件不是加密保险库，本轮依靠本地账号、文件权限和隔离，而非宣称加密存储。

每轮从同一 revision 解析 Provider、Workspace、MCP 与运行限制为不可变运行快照。先获取会话租约再固定快照，权限与目标仍按既有执行前复检；修改配置不改变当前轮。下一轮重新取快照，移除资源则拒绝继续。记录非秘密配置版本，不记录可用于猜测密钥的公开 hash。跨进程读取每轮访问磁盘，不能只清理 Web 内存缓存。

运行限制优先级为单次显式参数、显式环境覆盖、托管默认值、程序默认值；页面显示环境覆盖项及其生效来源。权限模式默认值只初始化新权限会话，不能覆盖当前用户选择或已有 deny 规则。

## 4. MCP 管理与探测

新增 `src/runtime/mcp-management.ts`，复用客户端、连接管理器、PermissionGateway 和审批事件，不从 HTTP 路由直接 spawn。管理操作需工作区上下文；用户级配置连接测试也必须选择工作区以确定 cwd 和授权边界。

状态区分 disabled、disconnected、awaiting-approval、connecting、ready、failed、draining；列表显示当前宿主状态及观测时间，不宣称 Web 连接等于其他 CLI 进程已连接。配置变更使旧连接停止接收新租约，已有轮次继续使用冻结配置直至释放；显式断开/停用同样先排空，并提示正在使用。需要立即停止时由用户取消相关运行，不静默中断其他会话。

实现时扩展现有连接状态，区分“拒绝新 acquire”与“允许既有 lease.call”；目前 call 要求 ready，不能简单把旧连接设 draining。失败重连需在授权后清理无引用故障项并重建；有引用时返回 busy。重连不重放任何工具调用。

连接测试仅 initialize + tools/list，默认总时限 20 秒，可取消；模型测试使用已有 provider 发送固定极短请求，不注入工作区/会话正文，不注册工具，默认总时限 30 秒。测试成功只证明该次探测；不证明全部模型工具能力或 MCP 工具调用成功。状态改变后探测结果失效。

管理操作使用 operationId：POST 发起后立即返回，GET SSE 订阅状态与审批、DELETE 取消；订阅断开或操作到期释放资源。审批必须来自现有权限决策接口并验证所属本地会话。不能先阻塞连接完成再建立审批事件流。Plan 模式的 Agent 仍不暴露或调用 MCP 工具；设置页的显式探测是独立管理动作。

## 5. Web 契约与交互

新增 `/settings`，分为模型、工作区、MCP、运行偏好四页签；高级参数折叠。首次引导复用这些表单，避免两套校验。工作区通过绝对路径输入/粘贴，不承诺浏览器原生目录选择可提供服务端路径。

拟新增接口：

| 接口 | 行为 |
| --- | --- |
| GET /api/settings | 公开配置投影、revision、来源和配置故障状态；永不含私密值 |
| PATCH /api/settings | 判别联合操作、expectedRevision；修改一个资源或默认项 |
| POST /api/settings/import | preview/commit 两阶段；commit 检查预览版本与原文件指纹 |
| POST /api/settings/recovery | 显式备份恢复或初始化，保留原损坏文件 |
| POST /api/settings/operations | 模型探测、工作区检查、MCP 连接/断开/重连 |
| GET/DELETE /api/settings/operations/[operationId] | 事件与取消，归属检查 |

公开写操作不接受任意持久化路径。模型 URL 中的凭据、MCP URL 的敏感 query 不原样进入诊断；推荐 Authorization/headers 凭据字段。路径真实解析、参数长度及 URL/headers 校验继续在服务端执行。

本地管理保护位于 `src/web/local-management-guard.ts`：校验 loopback Host、同源 Origin/Fetch Metadata，使用 HttpOnly/SameSite 本地管理会话与内存 CSRF token；所有设置读取也检查本地会话，写入/探测须 token。拒绝外部 Host、跨站写和不受信任 forwarded headers，不开放 CORS。此方案不提供远程身份认证；非本机场景关闭管理接口。端口按实际服务 Origin 匹配，不硬编码开发端口。

拆出 `src/components/settings/` 的设置壳、资源表单与诊断组件；`chat-workspace.tsx` 接入状态入口，不承载配置读写。新增运行摘要组件复用 RuntimeTurnEvent，展示 final-response、verification、persistence 三个维度。不得把“重试保存”变成重跑工具；取消后复用已有检查点恢复逻辑。

## 6. CLI 单次执行与隔离

新增 `src/cli/run-once.ts`、`run-result.ts`、`src/runtime/storage-paths.ts`，从 main 分发 `run` 子命令；复用 AgentRuntime，不复用终端文本解析来生成 JSON。旧交互路径保持原语义；新 run 中每次输入整体作为 prompt，首字符为 / 也不能执行交互命令。

拟议入口（实现前不可当作现有命令使用）：

```bash
npm run cli -- run --workspace eval-workspace --provider configured-model   --prompt-file task.txt --output-format json --data-dir tmp/agent-evals/session
```

`--prompt-file` 与 `--stdin` 二选一，支持多行 UTF-8；输入上限 1 MiB，空输入报参数错误。`--resume` 不允许同时覆写工作区/模型。支持 `--max-iterations`、`--timeout-ms`、`--policy-file`。JSON 为一次终态对象，JSONL 为带递增 sequence 的事件及一次终态；只输出允许字段，不原样序列化全量工具结果。stderr 承载诊断且脱敏。自动化直接启动本地 tsx 与入口，避免 npm 自身 banner 混入 stdout；人工示例可使用 `npm run --silent cli -- ...`。

```ts
type RunOutcome =
  | { readonly kind: "completed" }
  | { readonly kind: "blocked"; readonly reason: "approval-required" }
  | { readonly kind: "failed"; readonly code: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "timed-out" };

// 完整契约在实现时复用既有 CompletionAssessment、PersistenceState 和 usage 类型。
interface RunResult {
  readonly schemaVersion: 1;
  readonly executionId: string;
  readonly runId: string | null;
  readonly conversationId: string | null;
  readonly outcome: RunOutcome;
  readonly stopReason: string | null;
  readonly finalResponse: string;
  readonly settingsRevision: number | null;
}
```

实际结果还须包含 verification、persistence、cleanup、warnings、durationMs、usage、授权阻塞摘要和配置/策略来源。executionId 在启动时生成；进入 runtime 后关联 runId，启动失败不得伪造 runId。JSON 输出等待持久化及清理，保存失败/日志失败/清理失败均不能输出无告警成功。进程硬崩溃可能没有终态，评测器从执行清单和进程状态标记证据缺失，不假装任务没运行。

退出码固定：0 表示 final-response 且持久化/运行记录/清理成功，不表示独立验收通过；1 表示运行或保存/清理故障以及异常停止；2 参数/配置错误；3 审批阻塞；124 外层执行超时；130 用户中断。若主体已失败且清理又失败，保留主体原因并附清理错误。JSON 中保留原 Agent stopReason，不为审批阻塞修改核心枚举。

新 run 遇到 permission-requested 时记录阻塞、拒绝该动作、取消该轮并清理；不等待终端。policy-file 使用现有规则语法和校验器，作为明确的本轮授权输入，既有 deny 优先，不能打开沙箱或 Plan 禁止能力；不提供默认 permissive 快捷方式。

显式 data-dir 开启隔离：配置、会话、上下文、日志、用户权限都从该根解析，禁止回退 ~/.orbitcode；工作区项目规则只来自本次 fixture。凭据通过显式选择的 provider 环境引用传入，不自动加载开发仓库 .env.local；评测子进程环境白名单包含必要系统变量和选定凭据，MCP 子进程不继承模型密钥。路径工厂同时接入 Web fixture 与 CLI，不能只隔离日志。默认不指定 data-dir 时沿用生产目录。

外层 timeout 包括准备、MCP 初始化、模型、工具与保存；到期先 AbortSignal 清理，宽限 5 秒后由父执行器终止整个子进程组。失败结果记录哪些持久化/清理未完成。

## 7. 固定评测与改善工作流

新增 `src/evals/{types,runner,acceptance,report}.ts`、`scripts/run-agent-evals.ts` 和 `tests/fixtures/agent-evals/`。默认测试不调用真实服务；`npm run eval:agent -- ...` 是显式启用的未来命令。执行器每个 case 独立建立 data-dir/workspace，记录初态哈希、任务版本、源码 commit 与 dirty diff 哈希、Prompt 模板哈希、模型非秘密配置、策略版本、运行预算及 CLI 版本。

验收器与预期数据放在工作区外，通过受控 runner 执行，不能使用 Agent 可修改的脚本作唯一判断；需要测试目标程序时，以外部测试或只读校验对其输入输出验收。采用现有沙箱限制读写边界与网络，隔离输入中的符号链接，记录越界拒绝。明确允许变更路径，检查非预期文件变更。工作区副作用不因会话恢复而回滚。

第一批固定任务：

| case | 内容 | 独立验收 |
| --- | --- | --- |
| E1 | 阅读小型项目并解释调用路径 | 引用文件与关键事实核对；开放表述人工评分且单列 |
| E2 | 修复有稳定复现的逻辑缺陷 | 外部回归用例及允许变更范围 |
| E3 | 跨文件增加小功能 | 外部接口测试、类型检查和原行为回归 |
| E4 | 修复一次失败后重新验证 | 最终外部测试通过，运行证据存在失败→修改→复验 |
| E5 | 查询 MCP fixture 的固定资料 | 来源/答案断言与一次有效调用证据；无真实外部写入 |
| E6 | 请求受限资源并合理停止或解释 | 禁止副作用未发生、阻塞或合理回复及明确边界 |

模拟模型覆盖无效参数、工具失败、命令超时、循环上限；真实模型不一定主动触发每种异常，不靠无限重试制造覆盖。真实远程 MCP 仅补充 smoke test，网络波动与核心评分分开。

每次真实评测必须显式提供 provider、case/repeat、timeout/max-iterations；初始建议为 6 cases × 3 次、每轮 12 次迭代/180 秒上限，执行前输出总次数和时间上界并要求调用者显式参数选定，未选定不发请求。外层预算包含所有子进程；usage 只注明现有统计范围，价格未知不计算费用。

结果维度：执行 completed/failed/blocked 等与验收 passed/failed/blocked/indeterminate 分开；授权拒绝符合 E6 预期时，可执行 blocked 而安全验收 passed。验收器崩溃为 indeterminate，网络错误标外部服务故障但保留总次数和失败分母；不静默剔除失败。报告按 case 展示所有重复结果和总分母，不将人工评分与自动通过率混成一个分数。

对比采用相同 case、模型、预算、初态与验收版本，轮换执行基线和候选以减小时段影响。保存每次结果、耗时中位数/范围、工具失败、人工介入与 usage 缺失。先产出最多三个主要问题及证据；选一个主要因素修复后重跑目标 case 和相关回归。小样本仅用于方向判断，不声称统计显著或全面能力提升。没有证实缺陷时交付结果与假设，不为满足“改善”而盲改。

原始产物在已忽略 `tmp/agent-evals/`，含正文的导出仍是敏感数据；可提交任务 fixture 和脱敏总结，不能提交用户会话或凭据。扩展 `docs/evals/README.md`，保持既有诊断工作流，清楚区分只读诊断与显式复测。

## 8. 验证、依赖与风险

零新增运行时依赖：标准库处理存储/进程，现有 yaml 解析旧配置，tsx/node:test 测试。浏览器使用项目要求的 agent-browser；缺失工具则报告阻塞，不伪造浏览器通过。首先在当前 macOS 沙箱环境验收，其他系统不能无条件宣称支持命令执行。

配置与协议测试覆盖多进程冲突、损坏、凭据投影、旧身份、取消、JSON 终态唯一性；模拟端到端复用 openai-mock 与 MCP fixture。浏览器覆盖首次启动、设置管理和聊天恢复，tmux 覆盖真实终端链路与可控故障。完成实现后依次 lint、typecheck、build，再执行明确划定的真实模型预算。

主要风险是配置来源迁移、旧会话身份解析、MCP 租约语义和隔离不完整。各自须在进入 UI 与真实模型阶段前通过契约测试；不通过时修复边界，不能依靠放宽权限或跳过验证完成。


## 实施对应说明（2026-10-14）

保持上述需求与安全边界，具体文件合并见 [task.md 的实际映射](task.md#2026-10-14-实施映射与收尾证据)。设置页使用四个有标题的原生表单区域承载四类设置；参数与凭据由服务端校验。模型/MCP 探测采用 operationId + SSE + DELETE，先订阅后执行，管理会话隔离且断流取消。显式点击连接是该次管理连接的人工授权；Agent 中的连接和工具调用仍各自审批。工作区检查和断开使用直接有界请求；不为这些无后台等待的动作建立额外操作。结束摘要复用消息展示组件，路径注入与 CLI 协议也合并在既有入口，避免空壳模块和重复状态源。
