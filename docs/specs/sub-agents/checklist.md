# 子 Agent 委派与后台任务 Checklist

状态：已批准

2026-10-20至2026-10-21追加实施决策：任务接纳、准备及投递语义以本文件末尾 F19/P19/T19、F23/P20/T20、F27/P21/T21、F31/P22/T22、F35/P23/T23、F40/P24/T24、F44/P25/T25 及 F47/P26/T26 对应章节为准；其余既有约束继续适用。
依据：已批准的 `spec.md`、`plan.md`、`task.md`；以下验收项须实际执行后才可勾选。
当前决策：2026-10-20用户授权撤下report_completion；以文末T15/P15及对应决策为准，早期报告方案仅保留历史记录。

## 使用与证据规则

每条通过后才标 `[x]`，记录实际命令、退出码、关键观察及证据路径。未执行、受环境阻挡和失败均保持 `[ ]`，分别说明原因；不能把模型最终回复、历史测试数量或文档自检当作功能通过。

新测试和替身脚本已由 task.md 的任务创建，执行证据见文末记录。使用临时 Workspace、隔离配置/会话目录、本地 OpenAI 兼容和 MCP 替身；不访问日常模型、不使用真实密钥。需要命令沙箱的路径若环境不支持，记录未验证，不关闭安全限制。

证据建议保存在未入库的 `tmp/agent-evals/sub-agents-<执行日期>/`，报告只引用相对位置和脱敏摘要。不提交日志、截图、视频或本地配置。每次故障场景检查模型请求次数、工具实际执行次数和文件最终状态，不能只看返回文本。

## 需求验收

- [x] **C1 / AC1 / F1：统一入口与参数拒绝。** 用同一个 agent 工具启动 defined 和 fork，接纳后先获得唯一 ID；未知类型/角色/模型、非法参数、前台 Fork 在子模型调用前拒绝。相同创建调用 ID 重试只返回原任务。（验证：`npm test -- src/tools/agent.test.ts`；证据：返回结构、模型调用计数、任务 ID。）
- [x] **C2 / AC2 / F2：角色解析与优先级。** 三层同名覆盖正确，同层重名、坏 YAML、未知字段、锚点/别名、大小超限及链接逃逸都有诊断，高优先级错误不回退。目录扫描不会发模型或 MCP 请求。（验证：`npm test -- src/runtime/agents/definition.test.ts src/runtime/agents/catalog.test.ts`。）
- [x] **C3 / AC2 / F2：持续角色快照。** 任务启动后修改角色文件并触发多轮及压缩，当前任务仍遵循旧正文，下一任务使用新正文；角色不能覆盖系统约束。（验证：`npm test -- src/runtime/child-execution/session-factory.test.ts src/core/agent-loop.test.ts`；证据：脱敏的出站请求断言。）
- [x] **C4 / AC3 / F3、F7：定义式与状态隔离。** 父历史植入标记，定义式请求不出现该标记；两个子任务的消息、完成状态、权限追踪、取消及用量互不污染父和兄弟。（验证：`npm test -- src/runtime/child-execution/session-factory.test.ts tests/sub-agents-runtime.e2e.test.ts`。）
- [x] **C5 / AC4 / F4：实时 Fork 边界。** 父当轮已完成一次工具交换后，再在多工具批内 Fork；子含当前用户输入和此前完整交换，整个当前批均排除；校验工具调用/结果配对，父追加消息不改变子快照，已有摘要保留。（验证：`npm test -- src/core/agent-loop.test.ts src/tools/agent.test.ts`。）
- [x] **C6 / AC5 / F5：引用迁移。** 子专属引用可读，父引用不可读；纯文本旧引用有明确不可用说明。缺失内容、1 MiB 超限、损坏配对及迁移取消不请求子模型，临时目录和容量预留已释放。（验证：`npm test -- src/runtime/child-execution/history.test.ts`。）
- [x] **C7 / AC6 / F6、F19：前缀与缓存证据。** 同配置 Fork 保持稳定系统段和历史顺序，允许因安全过滤及引用迁移产生必要差异；分别输入 tokens/status/unavailable 和缺失 usage 样本，缓存显示正确，任务正确性不依赖命中。（验证：`npm test -- src/core/agent-loop.test.ts src/models/usage-tracker.test.ts src/runtime/sub-agent-usage.test.ts`。）
- [x] **C8 / AC7 / F7：独立 Skill 兼容。** none/recent/all、16 轮/5 分钟且不超过父预算、前台审批、取消、结构化摘要及引用限制保持原行为，不因共享 runner 自动后台化。（验证：`npm test -- src/runtime/skills/history.test.ts src/runtime/skills/isolated-runner.test.ts src/runtime/skills/execution-summary.test.ts tests/skills-run-once.e2e.test.ts`。）
- [x] **C9 / AC8 / F8：权限交集。** 分别验证父工具禁用、角色白名单/黑名单冲突、Plan 禁写、角色更宽模式、多个共享 Skill、父权限扩大和收紧；结果始终不超过父上限，撤销作用于后续操作。（验证：`npm test -- src/runtime/child-permissions.test.ts src/tools/child-tool-policy.test.ts`。）
- [x] **C10 / AC8、AC11 / F8、F11：审批隔离。** 前台审批携带子身份，仅授权该子一次；后台及非交互 ask 立即拒绝；审批中 detach 后迟到批准无效，父/兄弟均未获得权限。（验证：`npm test -- src/runtime/child-permissions.test.ts src/web/permission-routes.test.ts`。）
- [x] **C11 / AC9 / F9：递归与豁免拦截。** 子直接调用或伪造 agent、通过 isolated Skill 再建子执行均被拒绝；shared Skill 可加载且受交集限制，load_skill 豁免不能越过子黑名单。（验证：`npm test -- src/tools/child-tool-policy.test.ts src/tools/skill-policy.test.ts tests/sub-agents-runtime.e2e.test.ts`。）
- [x] **C12 / AC10 / F10：资源独立寿命。** 父完成清理后子仍可读迁移上下文并调用持有租约的 MCP；父释放不关闭子连接。子结束关闭自身资源；初始化中途失败没有未释放租约或进程。（验证：`npm test -- src/runtime/background-task-manager.test.ts src/runtime/mcp-connections.test.ts tests/sub-agents-runtime.e2e.test.ts`。）
- [x] **C13 / AC11 / F11：三条后台路径。** 显式后台、前台等待超时、手动转后台均保持一个任务 ID、一个执行实例、一个原始截止时间和一次受控写入。再次等待不恢复审批或延长寿命，已终止任务立即返回。（验证：`npm test -- src/runtime/background-task-manager.test.ts src/tools/agent.test.ts`。）
- [x] **C14 / AC12 / F12：等待取消与任务取消。** 父停止生成、HTTP 断开、结束 wait 均不取消已接纳子任务；取消排队任务不启动模型，取消运行任务停止子执行。完成与重复取消竞争只产生单一终态并保留副作用。（验证：`npm test -- src/runtime/background-task-manager.test.ts src/web/agent-task-http.test.ts`。）
- [x] **C15 / AC12 / F12：关闭与世代失效。** runtime close 拒绝新任务并关闭全部任务资源；重启无任务恢复。清空/删除必须先取得操作资格，失败的忙碌请求不提前取消任务，成功失效后旧结果不进入新世代。（验证：`npm test -- src/runtime/agent-runtime.test.ts src/runtime/conversation-service.test.ts src/runtime/conversation-cleanup.test.ts src/runtime/conversation-recovery.test.ts`。）
- [x] **C16 / AC13 / F13：安全消费。** 子在父流式输出中及工具批未配对时完成只入队；安全边界才追加 child-result。父已结束时不额外发模型请求，下一轮消费；创建工具只有一份配对结果。（验证：`npm test -- src/runtime/child-result-delivery.test.ts src/core/agent-loop.test.ts`。）
- [x] **C17 / AC14 / F14：持久化故障与去重。** 注入租约竞争、revision 冲突、第一次保存失败、保存成功但 ack 失败、重复通知；retry-save 后只投递一次且不重跑工具。查看/wait 不额外投递，已压缩正文仍能凭回执去重。（验证：`npm test -- src/runtime/child-result-delivery.test.ts src/lib/local-conversation-store.test.ts src/runtime/run-agent-turn.test.ts`。）
- [x] **C18 / AC14 / F14：归属与关闭队列。** 多会话同时有待投递任务，切换后结果只到所属世代；关闭前展示未保存结果可能丢失边界。旧运行时回执可读但不能恢复执行，回执清理不导致重复交付。（验证：`npm test -- src/runtime/child-result-delivery.test.ts src/core/conversations/validation.test.ts tests/sub-agents-runtime.e2e.test.ts`。）
- [x] **C19 / AC15 / F15：终态事实。** 覆盖正常最终文本但未验证、失败后恢复、拒绝、最大轮次、总时限、取消、Provider 错误和清理失败，停止原因/失败/副作用/验证状态完整；模型声称成功与证据冲突时仍按证据展示。（验证：`npm test -- src/runtime/skills/execution-summary.test.ts src/runtime/child-execution/runner.test.ts tests/sub-agents-runtime.e2e.test.ts`。）
- [x] **C20 / AC15 / F15：有界结果。** 超长工具输出、失败列表和最终文本被有界汇总，截断可见，关键停止/验证/副作用及证据 run ID 保留；父历史不复制全量子日志。（验证：`npm test -- src/runtime/skills/execution-summary.test.ts`。）
- [x] **C21 / AC16 / F16：双端控制与归属。** Web/CLI 均可列角色、查看、等待、转后台、取消并读取结果；未知/无权限任务不泄露内容；查询本身不启动模型，wait 期间控制仍可用。（验证：`npm test -- src/web/agent-task-http.test.ts src/cli/agent-commands.test.ts tests/sub-agents-web.e2e.test.ts tests/sub-agents-cli.e2e.test.ts`，并执行 B1—B3、E1。）
- [x] **C22 / AC16 / F12、F16：单次 CLI 关闭。** run-once 正常输出前关闭运行时，未完成任务报告取消，JSONL 只有一个最终事件，无存活子进程，不宣称退出后继续运行。（验证：`npm test -- tests/cli-run-once-process.e2e.test.ts tests/sub-agents-cli.e2e.test.ts`。）
- [x] **C23 / AC17 / F17：预算与排队。** 达到每轮创建、记录容量和并发上限时按约定拒绝或排队；排队到期不启动；独立 Skill 共用并发槽。反复 wait 不续期，取消释放槽位，未投递项不被驱逐，已投递项按策略退休。（验证：`npm test -- src/runtime/background-task-manager.test.ts src/runtime/settings-service.test.ts`。）
- [x] **C24 / AC18 / F18：共享写入。** 父、两个子、独立 Skill 对同一 canonical root 的潜在写入无重叠；命令/MCP 同样受控。锁等待可取消/超时，编排不持写锁，读可并发。（验证：`npm test -- src/runtime/workspace-execution-coordinator.test.ts src/core/tool-scheduler.test.ts tests/sub-agents-runtime.e2e.test.ts`。）
- [x] **C25 / AC18 / F18：长进程与外部边界。** 长进程持有写许可到退出，status/stop 不死锁，终止失败保留清理错误；不同工作区 ID 同真实根仍互斥。说明未提供跨进程、外部编辑或文件回滚保证。（验证：`npm test -- src/tools/managed-process.test.ts src/runtime/workspace-execution-coordinator.test.ts`；核对 README 和双端结果文案。）
- [x] **C26 / AC19 / F19：统计与证据关联。** 固定父及两个子请求序列，分别有 agent/summary 请求、失败和缺失 usage；父 self 不含子，总量无重复，缓存未知不补零。运行记录能追踪创建、转后台、停止、投递和清理。（验证：`npm test -- src/models/usage-tracker.test.ts src/runtime/sub-agent-usage.test.ts`。）
- [x] **C27 / AC20 / N2、N4、N5：异常与兼容。** 本地替身覆盖工具失败、无效参数、命令超时及最大循环次数；旧会话、权限、共享/独立 Skill 和主循环回归通过。环境限制单列，不通过修改安全策略消除失败。（验证：六个 `tests/sub-agents-*.e2e.test.ts` 定向测试及全量 `npm test`。）

## 集成、安全与资源

- [x] **I1 / N1：依赖方向。** 核心不导入 UI/运行时实现，Web/CLI 共用 runtime 和 AgentLoop；package.json 无新增运行时依赖或被禁止框架。（验证：检查实际 diff，运行 `npm run typecheck`；必要的接口注入不作为重复循环。）
- [x] **I2 / N2：路径与凭据。** 父/子文件越界、链接逃逸和受保护路径被拒绝；在替身中放置非真实秘密标记，验证日志、任务结果、审批及 Web 输出均不泄露。（验证：`npm test -- tests/sub-agents-runtime.e2e.test.ts tests/sub-agents-web.e2e.test.ts`；保留脱敏断言结果。）
- [x] **I3 / N3：资源异常。** 分别在目录创建、引用复制、会话创建、MCP 初始化、执行、日志写入和清理阶段故障注入；已取得资源有释放/失败记录，无“未启动即成功”的结果。（验证：child-execution runner、background-task-manager 及 MCP 定向测试。）
- [x] **I4 / N3、N5：内存与持久化界限。** 队列、记录、定义、摘要和回执容量有界；旧检查点/usage 缺字段可读，非法新字段拒绝；关闭后没有任务自动恢复。（验证：catalog、result、delivery、conversation validation、usage 定向测试。）
- [x] **I5 / N4：验收依据。** 每项报告有退出码或真实观察；替身端到端与真实模型结果明确区分，未授权真实模型不调用，缓存命中不作为必过门槛。（验证：检查最终报告和测试配置。）

## 项目检查

- [x] **Q1：完整测试。** `npm test` 退出码 0，记录实际通过/失败/跳过数量，不沿用旧报告数字。
- [x] **Q2：ESLint。** Q1 后运行 `npm run lint`，退出码 0。
- [x] **Q3：类型检查。** Q2 后运行 `npm run typecheck`，退出码 0。
- [x] **Q4：生产构建。** Q3 后运行 `npm run build`，退出码 0。
- [x] **Q5：交付差异。** `git diff --check` 退出码 0；同时检查 `git status --short` 中新文件，确认无凭据、日志、截图、视频、临时配置入库候选，无无关修改。

## 真实浏览器与 tmux 操作

这些是实际 UI/终端流程检查，模型由本地替身提供。T14 的 `scripts/run-sub-agent-fixture.ts` 约定支持 `--root <临时目录>`，创建隔离工作区及配置，输出本地 URL、配置文件路径和可复制的 Web/CLI 启动命令；文档中不预填真实凭据。测试时按脚本实际输出执行，保留命令原文。脚本由 T14 实现，必须使用新的隔离目录。

- [x] **B1 / AC16：Web 完整路径。** 启动替身和 `npm run dev`，仅将隔离本地 Provider/Workspace 配置到测试实例；使用 agent-browser 打开页面，列角色，通过主对话创建定义式任务，查看 ID/状态，等待并读取最终结构化结果。保存浏览器操作和测试 run ID。
- [x] **B2 / AC8、AC11、AC12：Web 等待控制。** 创建慢任务并在等待时点击转后台；父停止后子继续。分别对另一个任务执行取消、在待审批时转后台并尝试迟到批准；观察一个终态、审批失效、未重复写入。Fork 从开始即后台。
- [x] **B3 / AC14、AC16：Web 边界与 UI。** 切换会话后查看正确归属；完成结果在下一主轮次只出现一次。设置区拒绝非法预算。检查错误覆盖层和浏览器控制台，没有相关错误；模型最终文本未被显示为验收通过。
- [x] **E1 / AC16：tmux 交互 CLI。** 在 tmux 用替身输出的隔离配置启动 OrbitCode，输入真实自然语言委派请求，观察主模型调用、agent 创建、子工具本地执行和父最终回复闭环；运行 `/agents`、`/tasks`、show/wait/background/cancel 命令。等待时控制输入可用，Ctrl+C 仅结束等待。
- [x] **E2 / AC15、AC20：tmux 异常。** 分别输入替身支持的工具失败、无效参数、命令超时、最大轮次场景，记录实际停止原因、原始退出码、副作用和未验证状态；不能只检查有最终回复。
- [x] **E3 / AC12、AC16：退出与单次运行。** 创建仍运行的任务后退出交互 CLI，再执行一次非交互 run-once；观察 runtime 关闭、子取消报告、唯一最终 JSON/JSONL 结果和相关子进程退出。重启同数据目录不会恢复后台任务。
- [x] **E4：清理。** 关闭 agent-browser、tmux 中本次启动的 OrbitCode、开发服务器和替身；核对本次进程/端口已释放，仅清理本次临时资源，保留脱敏报告，不影响用户其他进程。

## 实际结果（2026-10-19）

**44 / 44 项通过。** 下表记录实际测试、操作与证据范围；通过的是所列有限场景，不代表真实模型质量、跨进程隔离或全部服务兼容矩阵。

本地证据根为未入库的 `tmp/agent-evals/sub-agents-20261019/`。完整命令 `npm test` 退出 0（687 通过、0 失败、0 跳过）；其后依次 lint、typecheck、build，均退出 0。测试输出包含以下每项的已执行单元/集成场景。人工操作的补充证据和复现方式见 [验收报告](../../evals/sub-agents.md)。

| 检查项 | 实际证据与边界 |
| --- | --- |
| C1 | agent 参数单测与 boundaries e2e：未知角色/模型零子请求、零任务；manager 创建幂等/退休拒绝重放，delegation 故障测试确认同调用先复用原任务，即使后来的角色校验已不可用也不重跑。 |
| C2 | definition/catalog：三层覆盖、同层重名、坏 YAML/未知键、锚点/标签/引用、文件/说明大小、越界链接和候选容量诊断；目录超限只发布错误摘要，已有角色快照不变。 |
| C3 | session-factory 在重量压缩和两轮工具交换期间改角色文件，出站请求持续含旧正文；boundaries e2e 同一父轮后续创建重新加载新正文，已接纳任务保持旧快照。 |
| C4 | runtime e2e 中 defined 不含父历史标记、Fork 含标记；独立 session、权限兄弟隔离、取消和 self 用量测试通过。 |
| C5 | boundaries e2e 同批创建两个 Fork，二者完整请求相同；含当轮此前 read_file 交换，排除整个当前双工具批。runtime e2e 校验调用/结果配对，旧摘要由共享 history 测试保留。 |
| C6 | history 原有引用迁移、父引用拒绝、纯文本清洗、1 MiB 和坏配对测试通过；delegation 注入缺失引用/迁移取消，零子请求、无任务记录、临时目录清理；排队后删除父上下文仍可读取子专属引用。 |
| C7 | boundaries e2e 同配置、同快照两个 Fork 的完整出站请求 deepEqual；sub-agent-usage 覆盖 tokens/status hit/miss/unavailable/缺失 usage。任务不依赖命中，真实缓存收益未测。 |
| C8 | 原 history、isolated-runner、execution-summary、skills-run-once 与全量回归通过；独立 Skill 共享并发槽测试通过。 |
| C9 | child-permissions 与 child-tool-policy 通过，包含 Plan 撤销、父收紧和父扩大仍受快照限制；原多 Skill 策略回归通过。 |
| C10 | 前台一次批准仅该子、兄弟不继承，后台 ask 拒绝；浏览器实际转后台后同 requestId 的迟到批准返回 400，目标文件不存在。 |
| C11 | agent 在外层策略始终禁止，load_skill 豁免不能越过黑名单；独立 Skill 递归拒绝和共享策略回归通过。 |
| C12 | MCP e2e 父完成后子自己的租约继续 tools/call；delegation 测试排队后删除父上下文，子 read_context 成功；初始化注入已取得租约后失败，release 计数为 1，临时目录清理，失败不冒充成功。 |
| C13 | manager 三种后台路径断言同 ID、单次 run/受控操作计数、相同 deadline；重复 wait 立即返回 terminal，无重跑/续期。 |
| C14 | 排队取消零启动，运行取消单终态；CLI Ctrl+C 等待 reason=cancelled 后 show 仍 running，随后显式 cancel 才终止；Web wait/detach/cancel 共用运行时测试通过。 |
| C15 | boundaries e2e 对运行中的子任务分别提交旧 revision 和持有主会话操作租约时的 clear，均拒绝且子仍 running；成功 clear 世代失效、runtime close 收敛和实际重启不恢复通过。 |
| C16 | boundaries e2e 子在父流式请求期间完成只排队，父请求次数保持 2；下一轮消费。另在 agent+慢 MCP 同批未配对时完成，child-result 只出现在两份 tool 结果完整配对之后。 |
| C17 | 持久化 e2e 注入首次保存失败，retry-save 后一份结果/回执且仅一次子执行；delivery 注入 ack 失败后回执补确认。原租约/revision 回归通过。 |
| C18 | delivery 多会话同时 pending 只消费所属任务；正文移除后已有回执禁止重复消费，新 manager 不恢复旧队列。clear 旧世代和退休回执裁剪通过；Web 实际切换会话为空，界面说明关闭丢失边界。 |
| C19 | boundaries e2e 子 Provider HTTP 错误为 model-error 且失败请求可见；not-found 后读取正确文件恢复，保留首次失败。runner/manager 与 tmux 另覆盖最终文本未验证、拒绝、轮次/总时限、取消和清理失败，停止事实独立于模型陈述。 |
| C20 | runner 同时注入 40 条失败、32 项长验证、16 项长 blockers 和超长最终文本，保留 32 条失败及总数、16 项验证、8 项 blocker、4096 字节文本、truncated、停止/副作用/run ID；delivery 超限摘要保留关键事实。 |
| C21 | 双端角色/任务查看、wait/background/cancel，Web 外域和任务归属拒绝；真实浏览器和 tmux 控制见 B/E 证据。 |
| C22 | run-once 真实 tmux JSON 退出 0，子取消且 cleanup complete；原 JSONL 唯一最终事件/进程退出回归通过。 |
| C23 | manager 并发、每轮计数不因退休重置、队列到期、共享前台槽、未投递保留及容量退休测试通过；limits 解析通过。 |
| C24 | scheduler 四个独立执行共用 coordinator 写入无重叠、读并发，排队取消不执行；原命令/工具序列回归及 MCP e2e 通过，锁键使用 canonical workspace.root。 |
| C25 | 真实受管进程到退出才释放写许可，status/stop 不死锁；停止失败替身保留错误和 running/持锁，实际 completion 后才释放；两个符号路径经 canonical root 归一后互斥。README 明确跨进程/外部编辑边界。 |
| C26 | sub-agent-usage 固定 agent/summary、失败/缺失 usage、两个子 ID 去重、父 self 分开和 cache 未知通过；任务 activity、子 parentRunId/parentCallId、消费回执可关联。实时聚合只覆盖保留记录。 |
| C27 | 687 项回归通过；tmux 实际工具失败、非法参数、命令超时和最大轮次证据见 tmux-final.txt，无真实模型请求。 |
| I1 | typecheck/build 退出 0；核心生产文件无 React/Next/runtime/UI 实现导入；package.json/package-lock.json 无差异。 |
| I2 | 现有文件/沙箱边界测试继续通过；runtime e2e 的合成凭据标记不出现在子日志；任务输出、审批只含任务事实，新增文件无凭据。 |
| I3 | delegation 逐场景注入目录创建、引用复制、迁移取消、子会话启动构造、MCP 初始化、执行、日志和清理错误；校验任务/目录释放、lease release 计数，清理错误保留 cleanup=failed，日志错误保留 evidenceLog=failed。 |
| I4 | catalog/history/summary/manager/receipts 容量与旧会话/usage 校验回归通过；实际重启同会话 tasks 为空，不自动恢复。 |
| I5 | 本报告区分替身、人工操作和未完成组合；无真实模型或缓存收益宣称，每项有实际日志/测试来源。 |
| Q1 | npm test：退出 0；687 passed / 0 failed / 0 skipped，tests-final.txt。 |
| Q2 | Q1 后 npm run lint：退出 0，lint-final.txt。 |
| Q3 | Q2 后 npm run typecheck：退出 0，typecheck-final.txt。 |
| Q4 | Q3 后 npm run build：退出 0，build-final.txt。 |
| Q5 | git diff --check：退出 0；检查跟踪与新文件，无依赖、环境文件、日志、截图或临时配置入库候选；无提交或推送。 |
| B1 | agent-browser 实际创建 defined explorer，查看任务 ID/终态与结构化结果，final-response/unverified；browser-closeout-defined.txt。 |
| B2 | 前台审批转后台消失，迟到批准 400 且文件不存在；保持执行的 Fork wait/detach/cancel 后 terminal/cancelled；browser-closeout-cancel-running.json。首次较短 Fork 已完成，单列且未当作取消通过。 |
| B3 | 新会话任务为空，原结果下一轮 committed；预算 0 的 validity=false，恢复原值；errors 为空，console 仅 DevTools/HMR，无错误覆盖层。 |
| E1 | tmux-ctrlc-*.txt 覆盖自然语言委派、角色/任务、show/wait/background/cancel；Ctrl+C 后仍 running，控制输入可用。 |
| E2 | tmux-final.txt 包含 not-found、invalid-arguments、真实 run_command timeout（exitCode=null/timedOut=true）、max-iterations，verification 均未被文本冒充通过。 |
| E3 | tmux-exit-result.json 显示退出时子 cancelled；run-once.txt 保留唯一最终 JSON/退出 0；重启 /resume 同会话后 /tasks=[]，未恢复后台。 |
| E4 | 浏览器 close 成功，开发服务和替身 SIGINT 退出 0；本次 tmux 会话不存在、所有本次端口释放，cleanup-final.json。 |

补测阶段发现并修复了角色目录只在父轮开始解析导致后续创建看不到修改、以及日志写入失败未反映在子结果中的问题，新增回归后重新执行全量门禁。前述补测只增加证据，没有删除子条件、降低安全策略或改写验收标准。真实模型、真实缓存收益、跨进程文件隔离与跨运行时恢复不在本轮通过结论内。


2026-10-20真实模型补充：已授权38个场景样本，复核33通过、1部分通过、4失败。追加修复子身份/父编排边界及运行日志cache字段，687项回归与lint/typecheck/build重新通过；真实模型结果不替代本清单的有限边界证据。详见 `docs/evals/sub-agents-real-model-2026-10-20.md`。

## 2026-10-20 改进增补验收

- [x] 当前子任务边界在真实出站请求中存在；完整Fork历史、配对与独立Skill行为不回退。
- [x] 原引用连续读取跨Unicode和转义内容无缺漏，不生成二次卸载引用；并行读取遵守批次及单结果预算，预算不足明确停止。
- [x] 交接保留实际命令失败/复验、callId、部分写入和省略计数；不从调用请求或命令文本推断文件写入，投递截断后事实仍保留。
- [x] 原始Fork、迁移检索、代码协作、失败修复各至少2次真实模型复测，失败不替换；代码制品独立验收，父分工遵守单独复核，保留逐请求文件哈希。
- [x] 全量测试及lint/typecheck/build通过；评测资源关闭、精确凭据扫描零匹配。

实测：新增18例真实模型样本14通过/4失败；读取闭环修复后的10例通过。全量693项、lint/typecheck/build通过。详见 [改进验收](../../evals/sub-agents-improvements-2026-10-20.md)；原失败与各子verification均保留。

## 2026-10-20 报告语义增补验收

- [x] 拒绝报告返回本轮有界候选，不包含失败/仅写入证据，不泄漏命令正文/路径；旧证据无效、写入后验证和质量门禁不放宽。
- [x] 报告调用计数区分none/rejected/accepted，与最终verification独立，accepted之后写入仍unverified；截断保留状态。
- [x] 定向真实循环和评测器反例通过；五状态CLI真实模型各2例，Web接受/拒绝各1例，tmux真实输入；原始repair另2例并区分制品/报告/父汇总。
- [x] 全量测试、lint/typecheck/build通过，全部样本保留，凭据零匹配并完成本次资源清理。

T14验证记录：702项全量及lint/typecheck/build通过；15个有效真实模型样本复核14通过/1部分通过，另保留1个无效夹具。原始修复第1例子报告缺失仍unverified，不能据制品通过宣称完整验收；详见 [报告语义验收](../../evals/completion-semantics-2026-10-20.md)。

## T15 当前方案：移除模型报告工具

本节取代此前报告提交/纠错相关要求；旧记录仅作为当时验收历史。

- [x] 默认主/子/独立Skill工具定义无report_completion，提示与内置角色/Skill不再要求提交；旧名称不能通过元数据重新启用。
- [x] 无报告专属强制收尾，正常工具仍可继续；普通失败/取消/最大轮次/权限/沙箱与通用失败预算保持。
- [x] 工具结果、退出码、副作用、证据ID与子结果交接保留；新本地unverified不阻止结束，不自动把执行成功当整任务验收通过；旧Assessment及字段兼容读取。
- [x] 旧Skill/角色元数据过滤不扩权，历史工具交换仍配对；新真实模型记录中报告调用为0，独立制品断言通过，失败样本仍保留。
- [x] 完成全量测试、lint/typecheck/build、Web HTTP/SSE及tmux真实输入，凭据扫描与清理证据齐全。

T15实测：21个真实模型样本通过，原生日志报告调用0，204个录制请求无该定义；现行678项与lint/typecheck/build通过，清理与凭据扫描见[移除验收](../../evals/report-completion-removal-2026-10-20.md)。

## T16：源码探索故障修复验收

- [x] 搜索目录/文件模式契约明确；目标类型错误可纠正，边界拒绝保留。
- [x] 只读事实有界去重/省略可见，原生失败原因与调用ID/轮次可关联，不保存原参数或源码正文。
- [x] 上限停止仍交接读取来源；预算提示在请求末尾计量、不入历史、不隐藏工具、不增加请求上限。
- [x] 同类真实模型矩阵、Web HTTP/SSE和tmux执行，保留全部失败；686项测试、lint/typecheck/build及凭据扫描/进程清理完成。
- [ ] 父模型在用户禁止代做时始终仅汇总：仍有有效样本违反，不能宣称已完全解决。
- [ ] 任意源码解释完整性与精确行号：自动入口/来源断言不能代替完整语义验收，人工抽查仍有猜测行号。

T16运行时修复与有限测试完成；有效真实场景16/22通过，剩余质量问题明确保留，见[修复与复测](../../evals/sub-agents-explorer-recovery-2026-10-20.md)。


## T17：整体架构改进验收

- [x] 完成序号排序；运行/排队共用停止归因；清理失败与副作用不被抹去。
- [x] 正文与摘要分离，存储状态明确；正文和工具事实可导出，中文分页、跨实例、过期、清空及符号链接边界通过。
- [x] Web、CLI与单次运行可显式选择父级分工；仅委派策略覆盖工具全部入口，子工具不被误禁；用户可切回协作。
- [x] 大路径及JSON转义仍有界投递，省略数可见；低预算分页不再制造二次引用，连续内容无缺口。
- [x] 真实模型完整保留通过与失败分布，Web路由遗漏修复后复测；浏览器正文读取与tmux闭环通过。
- [ ] 任意自然语言下的委派类型选择、上下文完整扫描及源码解释质量始终正确：真实样本仍有类型选错和跳读。

工程门禁、最终数字及版本/证据限制见 [交付报告](../../evals/sub-agents-architecture-delivery-2026-10-20.md)。

## P18验收记录

- [x] 错误委派类型不会创建任务，旧任务控制不受新类型选择影响；新字段逐轮保存。
- [x] 搜索覆盖信息来自完整运行时扫描，零匹配不等于语义否定；分页读取不强制禁用定位。
- [x] Fork别名只指向本次已复制的子副本；其他父引用、跨会话、符号链接仍拒绝。
- [x] 所有固定真实样本含失败均保留；完整回归和交互验证见 [报告](../../evals/sub-agents-reliability-2026-10-20.md)。
- [ ] 模型在任意任务中总能完整正确引用内容：本轮尚未证明，已观察到语义失败。

## P19 验收清单

- [x] AC19：实际 Runtime/HTTP handler 在慢 Fork 复制时可见 preparing；取消/后续查询均200，终态 ID 稳定，子请求0。
- [x] AC20：重复调用一次准备、改变输入拒绝、准备并发有界、未开始准备取消不初始化资源、准备中超时/关闭/清理失败、父请求结束不撤销任务。
- [x] AC21：注册中心保留已返回 stdout/stderr、退出/信号字段、截断和副作用；handoff 保留真实取消标志；未知输出不制造事实。
- [x] AC22：未保存 staged 下一轮重新领取，持久回执确认后不重领，失效不被迟到 commit 激活；压缩保留停止来源。
- [x] 工程检查及真实模型有限复测：721/721、lint/typecheck/build通过；两批生命周期样本共4/4，最终行为代码2/2；边界见 [交付报告](../../evals/sub-agents-lifecycle-architecture-2026-10-20.md)。
- [ ] 路线 D/E 的组预算、跨进程工作区隔离及质量/成本对照尚未验收；本运行时任务级协调见 P20。

## P20 验收清单

- [x] AC23：实际 Runtime/Provider/AgentLoop/文件工具，两个写任务观察0/1、最终文件2；父读取等待且状态控制可用。
- [x] AC24：两个只读子循环并行进入模型；能力策略来自元数据，角色名称和自然语言不能绕过独占策略。
- [x] AC25：独占排队取消不启动模型，清理与终态稳定；20种子×40次任务申请覆盖读写、取消、跨根和回收。
- [x] AC26：重入、只读升级、结束后回调、清理失败及同根冲突拒绝均有回归。
- [x] 最终733/733、lint/typecheck/build通过；真实模型原始8样本7通过/1评测误判，修正判据后工作区2/2、生命周期2/2；完整分布见 [交付报告](../../evals/sub-agents-workspace-coordination-2026-10-21.md)。
- [ ] 跨进程及外部编辑隔离、完整任务契约、组预算和单 Agent 对照尚未验收。

## P21 验收清单

- [x] AC27：原插队回归由失败转通过，同根资源阻塞时其他根任务可完成。
- [x] AC28：资源等待、就绪取消、动态并发和20种子×40任务均验证一次清理、并发上限、FIFO及回收。
- [x] AC29：关闭覆盖资源等待、就绪等待和活动执行，活动独立执行收到自有取消信号，调用者signal保持不变。
- [x] AC30：清理失败保留已知产物；父工具批完整配对后才插入子结果，使用受控只读门闩避免MCP写锁时序猜测。
- [x] 本轮742/742、lint/typecheck/build及7/7真实模型样本通过；完整分布及未验收边界见[调度收敛交付](../../evals/sub-agents-scheduler-2026-10-21.md)。

## P22 验收清单

- [x] AC31：计划数据快照不受源对象改变影响；绑定契约和TaskView使用相同收窄预算。
- [x] AC32：可变Set不能扩权，PreparedToolCall动态撤权拒绝；MCP禁止优先且缺失必需能力仍拒绝。
- [x] AC33：中文引用实际内容/哈希、跨会话拒绝、20引用仅列16并计省略、接纳哈希不符拒绝。
- [x] AC34确定性部分：不同Provider角色的实际请求、接纳摘要与运行日志一致，保留修复前失败。
- [x] 最终752/752及工程门禁；固定真实模型11/11、最终行为代码8/8；清单与边界见[交付报告](../../evals/sub-agents-admission-contract-2026-10-21.md)。

## P23 验收清单

- [x] AC35：100并发调用仅接纳7次；真实Runtime跨轮后台任务仍用原额度，清空移除预算视图。
- [x] AC36：本地HTTP重试最多2次，下一次拒绝；重试成功仍保留失败尝试未知用量；取消不退款。
- [x] AC37：预算与纯契约阶段12/12真实样本；最后时限改动后的复测单独记录，保留完整分布和版本边界。
- [x] AC38：隔离开发副本中保存128→64并刷新保持；全新浏览器会话错误数组为空；修复Webpack纯契约依赖。
- [x] AC39：修复前时钟回归失败、修复后通过；迟到完成按max-runtime停止且产物不丢。
- [x] 762项完整回归与工程门禁通过；完整失败记录、扫描范围及清理见本轮交付报告。
- [ ] token硬预算、任意Provider的内部重试、跨进程额度与单Agent收益对照未验收。

## P24 验收清单

- [x] AC40：受控时钟和门闩验证阶段总和、准备排队、两类等待、未开始阶段省略和终态冻结。
- [x] AC41：资源等待取消/关闭只清理一次，延迟包含真实等待且失败仍保留首个来源。
- [x] AC42：40次等待挤出活动记录仍保留执行清单；两次暂存/一次确认独立于执行；16KB回退保留清单。
- [x] AC43：最终769/769及工程门禁；真实CLI/Web9/9、10份子任务清单；文件、进程和预算原断言继续通过。
- [ ] 不将阶段清单解释为逐工具性能归因、计费上限、全部内部回滚耗时或重启后的完整追踪。

本轮实现、测试分布与持久化边界见[生命周期阶段诊断交付](../../evals/sub-agents-phase-timing-2026-10-21.md)。

## P25 验收清单

- [x] AC44：资源接纳、排队、开始、执行和清理内发起关闭均等待清理；管理器前台接纳集成通过。
- [x] AC45：就绪回调重入接纳及并发修改不插队；启动回调失败不误记实际执行；40个固定种子覆盖取消/关闭/清理失败。
- [x] AC46：取消广播内重入取得同一屏障，关闭后新调用只清理不接纳资源或执行。
- [x] 最终781/781及工程门禁，真实CLI/Web10/10；保留修复前关闭/FIFO失败，详见[调度所有权交付](../../evals/sub-agents-scheduler-ownership-2026-10-21.md)。

## P26 当前版本收口清单

- [x] AC47/AC48：旧配置补0、预算并发不超发、重试逐次预留、未知保留、HTTP实际输出限制、Provider能力不足预先拒绝。
- [x] AC49/AC50：拒绝伪造状态/路径穿越/重复；模型自述不改变验收，独立读取后改文件复验失败；权限及工作区边界测试。
- [x] AC51：单Agent/委派各3/3正确，记录所有耗时、请求与已报告token；本任务委派更慢、用量更多，隔离效果单独核查。
- [x] Web/CLI有限场景、设置保存刷新、最终浏览器错误为空；792/792及工程门禁通过，详见[收口报告](../../evals/sub-agents-final-delivery-2026-10-21.md)。

当前版本状态统一见[交付状态](delivery-status.md)；上述历史未勾选项为当轮证据或非目标边界，不代表现行版本仍缺少已交付能力。

## C52：默认角色审批可用性（2026-10-22）

本节替代C10、C13、B2中“detach撤销审批”的历史验收语义，旧记录保留为旧版本证据。

- [x] 内置general/default的显式后台、自动转后台、手动转后台及wait超时，保持请求ID与截止时间，批准后仅执行一次。
- [x] 父已回复后仍可审批；Web与CLI控制入口共用任务通道，错任务、旧请求及重复决定被拒绝。
- [x] 默认不放行写入或命令；非交互拒绝ask；取消/关闭清理等待；新增deny与Plan通过复检生效。
- [x] 原始截止时间结束等待、工程门禁及真实模型浏览器验收归档（见docs/evals/sub-agents-permission-lifecycle-2026-10-22.md）。

## C53：自主执行（2026-10-22）

本节取代C52的审批交互验收；C52保留为历史阶段记录。

- [x] 父/子/Skill/MCP不生成新审批，允许操作直接执行，非交互同样可用。
- [x] 显式deny、Plan、批量目标、资源/配置/指纹复检及取消的实际断言继续通过。
- [x] 旧历史审批无按钮，新决定接口410；移除CLI批准入口和UI模式控制；旧ask/模式兼容策略有测试。
- [x] 真实模型/开发服务器浏览器、工程门禁与资源清理证据归档，见docs/evals/approval-removal-2026-10-22.md。
