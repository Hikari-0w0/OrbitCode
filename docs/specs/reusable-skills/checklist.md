# 可复用 Skill 验收清单

状态：已批准
依据：同目录已批准的 spec.md、plan.md、task.md；用户已授权实施。下方保留原验收条款，按实际证据勾选。

只有条款全部取得符合预期的证据后才勾选；部分覆盖仍保持未勾选；模型最终回复、检查点保存成功、功能测试通过分别说明，不互相代替。

## 验证环境与证据规则

- 工作目录为 OrbitCode 仓库；测试全部使用临时 Workspace、用户配置根、会话/日志目录及本地模型替身，禁止读取真实用户配置来让测试通过。
- 下文测试文件已创建；相关证据可由完整 `npm test` 重现。单项中未执行的子场景不因全套测试通过而视为通过。
- 每项记录执行时间、环境、实际命令、原始退出码、关键观察、证据路径和失败后下一步。失败计入分母，重试保留前一次结果，不只保留最好结果。
- 功能证据保留于未入库目录；不把日志、截图、录屏、压缩包或任何凭据提交到仓库。凭据扫描使用合成哨兵字符串，不使用真实密钥。
- 本地替身端到端验证证明真实程序调用/工具/保存链路，不证明真实模型会稳定选择正确 Skill。未经用户另行授权不调用真实模型；若未测，最终明确该能力未验证。

## 需求验收

- [x] C01 / AC1 / F1：运行 `npx tsx --test src/runtime/skills/definition.test.ts`；验证单文件/目录入口、字段严格校验、空白名单、BOM/CRLF、重复键、未知字段、别名及非法模式。完整和位置参数替换是纯文本，缺参/引号未闭合不改变激活状态。（T2）
- [x] C02 / AC2 / F2：运行 `npx tsx --test src/runtime/skills/catalog.test.ts`；三层优先级正确，同层冲突明确；高层无效已知名称不回退；另一个有效名称可继续使用；缺目录、不可读来源和扫描超限分别可见。（T2）
- [x] C03 / AC3 / F3：运行 `npx tsx --test src/tools/load-skill.test.ts tests/skills-runtime.e2e.test.ts`；捕获首个模型请求，只有未激活名称/简介，无正文与资源；列表不发模型请求；加载失败无状态残留，加载成功下一次请求有完整指令。（T5、T13）
- [x] C04 / AC4 / F4：在 `tests/skills-runtime.e2e.test.ts` 记录同回合后续迭代、后续用户回合、自动及手动压缩后的请求；有效内容持续保留，多 Skill 共存、重复加载幂等、不同参数替换准确；有/无 ContextManager 均覆盖。（T5、T13）
- [x] C05 / AC5 / F4、F8：运行 `npx tsx --test src/runtime/skills/service.test.ts tests/skills-cross-process.e2e.test.ts`；CLI 激活后 Web 恢复保持原快照，停用保留历史，删除源文件不抹去已保存指令；清空、取消及迟到结果不复活状态；旧会话缺 skills 可打开。（T3、T13）
- [x] C06 / AC6 / F5：运行 `npx tsx --test src/runtime/skills/history.test.ts src/runtime/skills/isolated-runner.test.ts`；none/recent/all 选取准确、工具组完整、压缩摘要处理明确；子引用只能读自身上下文；共享异模型拒绝，独立指定已有模型成功，主模型绑定不变。（T7、T9）
- [x] C07 / AC7 / F5、F11：运行 `npx tsx --test tests/skills-isolated.e2e.test.ts`；分别触发成功、工具失败、拒绝、父取消、超时、最大轮数和独立递归；摘要状态/副作用/验证边界准确，子进程结束，迟到结果不回写。（T9）
- [x] C08 / AC8 / F6：运行 `npx tsx --test src/tools/skill-policy.test.ts`；两个共享 Skill 交集与父上限同时生效，definitions 与 executePrepared 一致，空交集仅保留 load_skill；伪造调用、先批准再执行均不能绕过白名单。（T4）
- [x] C09 / AC9 / F6：运行 `npx tsx --test src/tools/mode-policy.test.ts src/core/tool-scheduler.test.ts tests/skills-isolated.e2e.test.ts`；未知工具拒绝、外部待发现不可激活、扫描不连接 MCP；Plan 下写/命令/外部工具不可用；同批次 load_skill 后禁止调用不得开始执行。（T4、T5、T9）
- [x] C10 / AC10 / F7：运行 `npx tsx --test src/runtime/skill-commands.test.ts tests/skills-cli.e2e.test.ts tests/skills-web.e2e.test.ts`；双方列表、调用、刷新、停用、空格参数、保留控制词和 // 转义一致；忙碌/审批/子执行状态可见。（T10、T11、T13）
- [x] C11 / AC11 / F8：运行 `npx tsx --test src/runtime/skills/catalog.test.ts src/runtime/skills/service.test.ts tests/skills-cross-process.e2e.test.ts`；新增/修改/删除刷新可见，正在执行和已激活快照不改变，显式重新激活采用新版；入口变化不混用元信息与正文。（T2、T3、T13）
- [x] C12 / AC12 / F9：运行 `npx tsx --test src/runtime/skills/resources.test.ts src/tools/read-skill-resource.test.ts`；授权目录四类资源可按需读取，读取无执行副作用；外部资源、绝对路径、穿越、链接逃逸和受保护路径被拒绝；资源变化阻止继续使用旧激活。（T6）
- [x] C13 / AC13 / F10：运行 `npx tsx --test src/runtime/skills/builtin.test.ts`；三个样板可列出、加载及覆盖。临时仓库 commit 只提交授权文件且不推送；review 文件内容保持不变；临时 npm 项目 test 顺序和退出状态准确，失败不声称通过。（T12）
- [x] C14 / AC14 / F11、N4：运行 `npx tsx --test src/runtime/skills/service.test.ts src/runtime/skills/isolated-runner.test.ts src/core/agent-loop.test.ts`；激活数量/字节/模型窗口、资源与历史展开、子次数/轮数/总时限超限有明确错误；旧状态保留、重复失败终止、模型不可用无静默回退。（T3、T5、T9）
- [x] C15 / AC15 / N1—N6：核对后续 C16—C34 全部实际结果；确认同一运行逻辑服务两端、依赖未扩张、安全约束没有为测试放宽，并汇总完整验证证据。（T13）

## 集成、持久化与安全

- [x] C16 / P1、P9：检查 `src/core/skills` 和 AgentLoop 导入及主/子入口调用链，确认不依赖 React/Next/runtime，主/子均经共享 factory 和原 AgentLoop。运行 `tests/runtime-parity.e2e.test.ts` 回归无 Skill 的行为；依赖清单无新增运行时包。（T7、T13）
- [x] C17 / P3：通过跨进程测试制造同时停用/保存、保存失败后重试、清空后旧子结果、加载后取消；验证 revision/epoch 防止覆盖，pending-save 不重执行副作用，导出包含一致状态。（T3、T13）
- [x] C18 / P4：调度器测试中先排普通读取、再 load_skill、再受限调用；证据显示屏障前工作完成后才加载、后序调用受新策略限制；审批等待中策略变化也在执行前复检。（T5）
- [x] C19 / P6：子命令进入 strict 审批，工具尚未完成时 Web/CLI 已收到审批请求；提交允许/拒绝正确路由到唯一子 callId；一次性授权不串用，父权限回合不被重置，子结果不成为父 completion 证据。（T8、T9、T13）
- [x] C20 / P6：模拟事件队列满、断开事件消费者及父取消；无审批丢失/死锁，子进程、临时 ContextStore 和租约清理可观察，清理失败产生警告；父 MCP 连接不会被子清理误关。（T8、T9）
- [x] C21 / P5、P8：资源变更发生在审批前后时被重新校验；read_skill_resource 受白名单和 path 审批约束；load_skill 参数不能提供任意路径；用户级入口读取不授予用户主目录文件访问。（T6）
- [x] C22 / P7、P8：服务响应和日志中不出现合成凭据哨兵、完整环境变量或不必要绝对路径；客户端不能指定资源根/Workspace 根；JSONL 可逐行解析且包含子事件归属，非交互审批没有默认放行。（T10、T11、T13）
- [x] C23 / P6：检查超长子结果的摘要：状态、终止原因、验证状态、sideEffect 与计数保留，正文截断有标记及日志引用；摘要生成不产生额外模型请求，父模型不会收到子全部上下文。（T9）

## 项目检查

以下检查在相关功能测试完成后按顺序执行，记录原始退出码；失败先诊断，不弱化约束。

- [x] C24：运行 task T13 列出的五个 Skill 端到端测试，以及改动涉及的单元/回归测试，逐组记录通过/失败/未执行数量，不以总命令成功替代失败分析。
- [x] C25：`npm run lint`，预期退出码 0。
- [x] C26：`npm run typecheck`，预期退出码 0。
- [x] C27：`npm run build`，预期退出码 0。
- [x] C28 / P2：构建后启动生产服务器，访问 Skill 列表得到三个内置样板；从不同 cwd 启动 CLI 也可发现内置 Skill。测试只使用打包资源，不能依赖偶然残留源码路径；结束后停止生产服务器。（T12、T13）

## 真实程序端到端

前置：检查 `tmux` 和 `agent-browser` 可用；准备隔离目录和本地可控模型服务，服务能按场景生成真实协议响应并记录请求。缺少工具或平台沙箱时标记未验证并记录原因，不改用 mock 后声称浏览器/tmux 已测。

- [x] C29 / AC15 / Web：启动开发服务器，agent-browser 打开页面，查看 Skill 列表→调用带空格参数的共享 Skill→观察加载/工具/最终回复→下一回合确认激活→刷新定义→确认仍用旧激活→显式重新激活→停用→清空。逐步核对界面及模型请求；检查错误覆盖层和控制台无错误，结束关闭浏览器及服务器。
- [x] C30 / AC15 / CLI：在 tmux 新会话中启动 CLI，依次执行 `/skills`、`/skill run <测试名称> <参数>` 和后续请求；观察模型请求→load_skill/预加载→本地工具→最终回复→保存恢复完整闭环。CLI 退出后从 Web 恢复相同会话，确认激活及限制一致。
- [x] C31 / AC7、AC15：在 tmux 启动独立 Skill，请求需审批的无害工作区写入；先拒绝，再单独重新调用并允许，验证摘要与文件结果；长运行中取消，确认子进程终止、主会话可继续且激活不污染。
- [x] C32 / AC14、AC15：替身依次生成未知 Skill、缺参数、未授权工具、命令非零退出及命令超时；逐场景记录结构化错误、stdout/stderr/退出码或 timeout 字段、Agent 后续行为及文件无越权副作用。
- [x] C33 / AC7、AC15：替身持续生成合法工具调用，配置有限最大轮数，分别触发主/子上限；观察实际终止原因、工具不再执行、未验证事项明确；另测总运行超时及等待审批时取消，不以提前最终回复替代限额验证。
- [x] C34 / N6：终止并核对本任务创建的 tmux 会话、浏览器、开发/生产服务器、模型替身与受管理子进程全部清理；检查隔离目录和证据无真实凭据。只结束本任务进程，不使用宽泛 kill 模式。

## 最新实际结果（2026-10-17，Asia/Shanghai）

用户授权继续测试并修复问题后，新增 27 项回归，完整测试 **581/581 通过**，失败/取消/跳过均为 0；lint、typecheck、build 按顺序最终均退出 0。当前 **34/34 项通过**；这是本规格有限条款和本次环境的结果，不代表所有模型、系统和并发时序均已穷尽。原先未勾选的 15 项补证如下；其他 19 项由既有证据及本轮全量回归共同支持。历史表格保留原样，不把过去的缺口改写为当时已验证。

| 补齐条款 | 新增证据 |
| --- | --- |
| C01 | definition 严格字段、模式、标签、非法 YAML 组合、历史/模型字段及容量；单文件/目录发现由 catalog/builtin 回归覆盖 |
| C02 | catalog 同层重复、缺来源、非目录来源与链接逃逸；257 入口、1025 目录项、累计 8 MiB 及摘要 16 KiB 超限，来源不完整禁止激活 |
| C04 | context-variants E2E 覆盖无 ContextManager；runtime E2E 同时激活两个 Skill 后经过实际自动/手动压缩请求，正文均保留 |
| C05、C07 | state-safety E2E：源删除仍保持快照；导出保留停用前历史；独立模型等待期间清空拒绝，取消/清空后迟到响应不写入任何消息或 Skill |
| C06 | history 测试压缩摘要、回合不足提示、损坏工具组、引用隔离、普通/卸载历史展开预算；既有真实协议测试继续验证子/主模型隔离 |
| C12 | resources-boundaries 逐一读取模板/示例/脚本/参考且脚本不执行；用户外部资源、绝对/保护/穿越/链接路径拒绝；超大资源明确 limit-exceeded |
| C14 | service 第 65 个资源及容量失败原子性；history 1 MiB；budget E2E 第五次独立调用、真实 32k 窗口；catalog 累计大小；既有迭代/deadline/重复失败/模型不可用回归 |
| C17 | 两个实际 CLI 进程同时停用旧修订仅一方成功；state-safety 验证保存重试不重放模型/写入，清空 epoch、冲突保留待保存、删除清理及一致导出 |
| C20 | core event-queue 背压及关闭唤醒；isolated-runner 注入临时 ContextStore 删除失败，错误可见且保留副作用；真实 stdio MCP 子运行清理后父仍使用原 PID，父关闭后 PID 消失；既有取消/消费者退出回归 |
| C21 | resources-boundaries 用真实 Gateway，审批允许前/后分别改资源，实际执行复检均拒绝旧写入；用户入口不授予外部资源权 |
| C28 | 最终构建复制到仓库祖先目录以外，无源码/本地配置；Next API 和另一 cwd 的编译后 CLI 均发现三个样板与副本标记；追踪清单无禁止文件，退出 0 |
| C31、C32 | verify-skill-terminal 在实际 tmux 中完整运行拒绝→允许→长运行取消，随后未知 Skill/缺参/工具失败/无效参数/非零命令/超时/禁止工具及主子轮数上限，共 12 场景通过；文件、原始退出码及进程分别核对 |
| C15 | 其余 33 项均有对应证据；共享 runtime/AgentLoop、零新增依赖和安全限制保持；完整检查和清理完成 |

五类复现问题已修复：清空后 pending-save/运行标记残留、recent 压缩边界提示缺失、资源容量错误分类、Next 追踪本地配置、符号链接 CLI 入口静默退出。首次最终 lint 因早期仓库临时目录中的编译副本被扫描而退出 1；清理本任务副本后重跑通过，没有放宽规则，失败日志保留。

完整修复、命令原始退出码、证据目录、外部包浏览器验证与限制见 [2026-10-17 深度补测](../../evals/skills-acceptance-2026-10-17.md)。本轮没有新增真实模型调用；原真实模型分布及修复复测继续分别保留。

## 历史结果（2026-10-16，Asia/Shanghai）

本节保留当时覆盖缺口与失败记录，不代表当前状态；最新结果见上一节。

初次确定性验收为 19/34 项完整通过；首次真实模型证据使 C13 暂降为未通过。用户授权修复并取得复测证据后，C13 恢复，当时为 **19/34 项完整通过，15/34 项部分验证**。未勾选项包含已通过子场景，但尚未取得原条款全部证据，不能宣称 34/34 验收通过。实现完成与验收覆盖分开记录；首次真实模型补测保留 10 通过、2 失败、3 权限策略阻塞；修复后主复测 12/12、最终边界补丁追加 3/3，分阶段保留，详见下方记录。

初次确定性检查环境：macOS、本地 Node/npm、隔离 Workspace/配置/运行记录及本地 OpenAI 协议替身；该阶段未调用真实模型。后续真实模型使用用户明确授权的项目配置，证据分开记录。以下“自动化通过”均指最终 `npm test` 原始退出码 0；各测试名及断言见对应文件。

| 检查 | 实际结果与证据 | 未覆盖/下一步 |
| --- | --- | --- |
| C01 | definition 测试通过：严格字段、空白名单、BOM/CRLF、重复名称字段、别名/锚点、引号、缺参、单遍替换及无 Shell 展开 | 未逐一注入全部未知字段、非法模式、自定义标签/多文档组合；保持未勾选 |
| C02 | catalog 测试通过：三层优先级、坏文件隔离、高层无效名称阻断 | 同层重复、不可读来源、目录项/入口数量与累计大小上限未全部故障注入 |
| C03 | runtime E2E 捕获首次目录和加载后请求，断言正文延迟加载；列表 API 不请求模型；service 缺参失败保持快照 | 通过 |
| C04 | runtime E2E 验证同回合/后续回合保留、真实自动及手动压缩请求后保留；service 幂等通过 | 无 ContextManager 路径和多个 Skill 同时激活后的压缩组合未专门测试 |
| C05 | 跨进程 CLI 恢复及停用通过；浏览器清空后直接读取 LocalConversationStore，revision 9、消息 0、activeSkills 0；旧检查点回归通过 | 删除源文件后恢复、清空与子迟到结果竞态未专门注入 |
| C06 | history none/recent/all 及卸载引用复制/禁止父引用通过；独立模型 secondary 请求 child-model，后续主请求 test-model、绑定 primary 不变；共享模型冲突拒绝 | 带压缩摘要及损坏工具组的历史组合未专门注入 |
| C07 | 独立允许/拒绝、工具失败、父取消/审批取消、总 deadline、最大轮数及递归拒绝通过；真实 sleep 30 受管进程取消后 PID 消失 | 清空竞态的迟到子结果未单独测试 |
| C08 | skill-policy 动态交集/父上限、准备后策略变化拒绝通过；runtime E2E 空白名单仍可加载，伪造后序写调用未执行 | 通过 |
| C09 | mode-policy、scheduler、service 及 Web Plan E2E 通过；未发现 MCP 工具拒绝，模式限制及加载屏障生效；发现代码无连接调用 | 通过 |
| C10 | 公共命令、CLI/Web E2E、单次 JSONL 测试通过；保留控制词显式 run、参数及 // 语义由 parser 测试验证；浏览器展示子审批 | 通过 |
| C11 | runtime E2E 与浏览器验证 V1→V2 刷新不改激活，显式调用采用 V2；旧 catalogRevision 面板调用在模型请求前拒绝 | 通过 |
| C12 | resources 测试验证读取、穿越、链接逃逸与资源变化；strict 审批拒绝后正文不进模型 | 四类资源逐一读取、用户级外部资源、受保护路径与绝对路径组合尚未全部注入 |
| C13 | builtin 解析及 skills-builtins E2E 全部通过；临时 Git 只提交授权文件无推送，review 文件不变，npm 依次 lint/typecheck/build 保留失败退出码 7 和 stdout/stderr | 修复后样板及真实模型 review/commit 通过；test 主复测 3/3、最终追加 1/1，复验与初检分别报告，C13 恢复通过 |
| C14 | 激活数量/字节、模型不可用、共享模型冲突、子 deadline/轮数、递归限制及 AgentLoop 失败预算回归通过 | 目录累计大小、历史展开、资源数、独立调用次数与模型窗口组合未全部触发 |
| C15 | 架构、安全与完整检查结果已汇总，无新增依赖 | 其余未勾选项尚有子场景，因此本汇总项保持未勾选 |
| C16 | 主/子均使用 agent-session-factory、原 AgentLoop/runAgentTurn；core 无 UI/runtime 导入；runtime-parity 通过，package.json/package-lock 无变化 | 通过 |
| C17 | 既有 recovery/store CAS、pending-save、epoch 回归及跨进程停用通过；Skill 快照随检查点保存 | Skill 停用/保存并发、清空后旧子结果、导出组合未专门制造竞态 |
| C18 | scheduler 屏障回归、Skill 同批次 load→禁止 write E2E、prepared 调用执行复检通过，越权文件未创建 | 通过 |
| C19 | CLI 和 Web 在子工具未完成时收到 strict 审批，允许/拒绝实际影响文件；展示 callId 带子 runId，子 raw call 不在主模型上下文，父完成证据保持独立 | 通过 |
| C20 | event-queue 背压/关闭唤醒、审批取消、真实进程取消、子 close 失败警告及 MCP 取消回归通过 | 子临时 ContextStore 删除失败、父 MCP 租约与子清理并发未完整故障注入 |
| C21 | path 审批拒绝通过；工具 schema 不接受任意根路径；资源读取前/每轮指纹校验代码已检查 | 资源变化恰好发生在审批允许前后的竞态未单独注入 |
| C22 | skill-http 非法方法/来源/参数测试及 JSONL 逐行解析通过，非交互 child 审批返回 blocked；隔离现场 34 份请求/日志对象扫描未发现两种合成凭据哨兵；客户端无资源根输入字段 | 通过；扫描只覆盖本次测试现场 |
| C23 | isolated-runner 超长中文结果测试通过：摘要 ≤8192 UTF-8 字节、无截断乱码、有截断标记、runId/状态/验证/副作用/工具计数保留；仅执行一次子模型流 | 通过 |
| C24 | `npm test`：554/554 通过，失败/取消/跳过均为 0，退出码 0；包含七组 Skill E2E 及全部既有回归 | 通过；测试通过不代替其余条款的未覆盖场景 |
| C25 | `npm run lint` 退出码 0 | 通过 |
| C26 | `npm run typecheck` 退出码 0 | 通过 |
| C27 | `npm run build` 退出码 0，包含 conversation skills API 路由 | 通过 |
| C28 | production 3098 的列表返回 commit/review/test，Next nft 文件追踪含三个入口；其他 cwd 以绝对 CLI 入口启动并列出三个内置，退出码 0 | 未把生产包复制到完全移除仓库源码的目录重测；不能声称完成纯打包资源隔离测试 |
| C29 | agent-browser 完成列表、带空格参数共享执行、后续保留、刷新不覆盖、重新激活、停用及清空；最终错误与控制台检查无错误，相关浏览器/dev 已关闭 | 通过；截图与请求分别取证 |
| C30 | tmux 启动真实 CLI，列表/共享调用/本地读取/后续请求/保存形成闭环；跨进程恢复测试及 Web 会话展示验证相同快照与限制 | 通过 |
| C31 | 浏览器实际完成独立写入允许/拒绝；CLI 自动化完成审批取消、允许/拒绝及真实子进程取消；tmux 独立允许写入形成主摘要 | 原条款要求在 tmux 单独执行完整“拒绝→允许→长运行取消”序列，现场未把三项全部重复，保持未勾选 |
| C32 | tmux 实际触发文件 not-found、路径参数 invalid-arguments、sleep 2/100ms 超时及最大轮数；未知 Skill/缺参/禁止工具由单元和集成测试覆盖；非零退出由 builtin E2E 覆盖 | 未在同一 tmux 现场重复所有错误种类，保持未勾选 |
| C33 | tmux 主循环持续工具调用在 4 轮上限停止；子轮数限制 E2E、审批等待取消和总 deadline 测试通过，停止原因可观察 | 通过；子总 deadline 采用可控 AgentSession，真实进程取消另有实际工具测试 |
| C34 | 任务所有命名浏览器已关闭、tmux 已退出；3097/3098/58912 监听已停止，受管子 PID 已消失；只清理本任务拥有的进程，证据未入库 | 通过 |

### 原始证据与复现

完整检查按 `npm test && npm run lint && npm run typecheck && npm run build` 顺序运行，保留每步原始退出状态。完整检查日志：

- `/tmp/orbitcode-skills-tests-final.log`（初次 543 passed，0 failed；修复后完整检查见下方日志）
- `/tmp/orbitcode-skills-lint-final.log`
- `/tmp/orbitcode-skills-typecheck-final.log`
- `/tmp/orbitcode-skills-build-final.log`
- `/tmp/orbitcode-skills-summary-final.log`、`/tmp/orbitcode-skills-model-selection-final.log`（聚焦复测）

真实程序证据：`/tmp/orbitcode-skills-tmux.log`、`/tmp/orbitcode-skills-tmux-final-capture.txt`、`/tmp/orbitcode-skills-browser-errors-final.json`、`/tmp/orbitcode-skills-browser-console-final.json`、`/tmp/orbitcode-skills-browser-accepted.png`、`/tmp/orbitcode-skills-browser-cleared.png`、`/tmp/orbitcode-skills-production-catalog.json`、`/tmp/orbitcode-skills-cli-cwd.log`。现场隔离目录由 `/tmp/orbitcode-skills-live.json` 记录。以上为当前机器的临时文件，可能随系统清理而消失；可用已入库测试重现自动化链路。

### 失败与复测记录

- 首次子事件队列取消调整导致 4 项既有 MCP 取消/超时回归失败；修复过早关闭队列，保留在途工具结果并用局部 AbortController 清理消费者。相关 27 项聚焦回归及最终完整测试通过。
- 首次 HMR 页面遇到旧目录响应没有 overridden 字段，导致面板 map 错误；增加兼容读取后，新浏览器检查无页面及控制台错误。
- 单次执行新测试最初误按顶层读取 outcome，实际协议位于 result.outcome；修正断言，JSONL 成功及 blocked 两项通过，未改协议绕过检查。
- 第二模型测试最初缺少 provider 必填 context，配置校验拒绝；补全测试配置后，子 child-model / 主 test-model 请求及绑定隔离断言通过。
- 超长摘要检查发现原实现只约束正文，长中文文件路径可能突破整体预算；修复整体 UTF-8 字节预算并增加实际长结果回归，聚焦与完整测试通过。

## 真实模型补测（用户已明确授权）

使用项目配置的 deepseek-flash，完成 15 个场景样本、19 次 CLI 执行和 7 次独立子运行，独立复核为 10 通过、2 失败、3 阻塞。资源精确授权后的主动选用及资源读取为 3/3；独立审计为 2/3；共享快照、白名单边界、review、commit 与 strict 子审批拒绝均有真实模型证据。

保留失败为一次独立子模型反复加载自身而未读文件，以及 test 额外复验后最终检查次数声明不准确。首次三个资源样本被评测策略阻塞，修正为精确路径授权后另行复测，不删除原样本。S4/S7 的原自动评分假阴性有独立复核依据，原报告保留。测试没有修改 Agent 行为。

完整条件、失败 runId、分布、用量边界、凭据扫描与证据路径见 [真实模型评测](../../evals/skills-real-model-2026-10-16.md)。这些样本不补齐前述未覆盖故障注入，也不把先前 Web 替身验证改称真实模型 Web 验收。

## 修复复验（用户授权“开始修复”）

明确独立 Skill 已激活状态；新增运行时命令事实及模型陈述分层，test 样板要求核对最新记录并单列复验；保持递归拒绝、白名单、Plan/Do 和审批机制。确定性测试 554/554、lint/typecheck/build 均退出 0；日志 `/tmp/orbitcode-skills-fix-{tests,lint,typecheck,build}-final.log`。

真实模型主复测 12/12 通过，最终标签序列化预算补丁后追加独立审计/test/strict 子审批 3/3 通过。C13 的原失败样本不删除；复验准确的本轮证据使本项恢复通过。其余未覆盖项保持未勾选，不以本轮结果填补未执行的故障注入。

完整条件、两个源码版本、独立复核及剩余边界见 [修复验证](../../evals/skills-fixes-2026-10-16.md)。

## 文档自检

AC1—AC15 全部映射 C01—C15；C16—C23 覆盖集成/安全，C24—C28 覆盖项目检查与生产资源，C29—C34 覆盖用户交互及清理。原条款未因测试覆盖不足而删除；本轮补证后全部勾选，历史缺口及失败仍保留。

## 当前实现真实模型复测（2026-10-17）

用户另行授权后，以项目配置 deepseek-flash 执行 CLI 12 个场景和 Web HTTP/SSE 4 个场景，16/16 有效功能场景通过。CLI 16 轮中 15 次 completed/退出 0，一次独立写入按预期 blocked/退出 3；Web 完成四轮，实际审批、写入、快照停用及 Plan 无写入分别复核。另一次 Web 夹具因提前等待完整 SSE 阻塞审批而中止，退出 1，修正夹具后新目录复测通过；原失败保留，不改 Agent 行为。

本轮源码及内置样板指纹保持不变；未重跑上节已通过的 581 项确定性测试。详细分布、命令事实、30 条运行记录、usage/后台任务边界和证据见 [当前实现真实模型测试](../../evals/skills-real-model-2026-10-17.md)。34/34 清单结果与本轮模型有限样本分开解释，不将通过数量当作任意模型成功率。
