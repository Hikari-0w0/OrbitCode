# 界面配置与 Agent 评测闭环 Checklist

状态：已批准
日期：2026-10-11
依据：[spec.md](spec.md)、[plan.md](plan.md)、[task.md](task.md) 已批准

> 文档已获批准；验收项仅在完整满足后勾选。每项执行后记录命令/环境、退出码、关键观察、证据路径；未运行和环境阻塞不得勾选。原始产物写入已忽略 tmp/agent-evals/，文档只保留脱敏摘要。

## 需求验收

- [x] AC1 / F1：隔离空配置启动 Web，用 agent-browser 打开设置、添加模型和工作区，完成第一轮；损坏配置仍能打开设置与历史，未确认恢复前文件未变。（T1、T5、T6）
- [x] AC2 / F2：表单新增、重命名、默认、停用、保留/替换/清除凭据；mock 模型有效/无效/超时/取消分别显示正确状态，编辑后旧探测失效，响应中无合成密钥。（T1、T5、T6）
- [x] AC3 / F3：合法目录可使用；失效与越界路径被拒绝，工作区根显示明确；移除后原文件存在，历史可读，新请求不能误用归档资源。（T2、T6）
- [x] AC4 / F4：HTTP 和 stdio fixture 分别走配置→审批→连接→工具列表→断开→重连；检查保存时连接/进程计数为零，重连不重放工具，作用域覆盖正确。（T4–T6）
- [x] AC5 / F5：旧配置预览导入，缺变量/冲突/非法字段明确显示；无效批次没有部分写入，源文件字节不变，显式 --config 来源正确。（T2、T6）
- [x] AC6 / F6：Web 与 CLI 同版本资源一致；运行中编辑后旧轮仍用旧快照、新轮用新版本；改名旧会话仍能解析，停用历史只读；跨进程同 revision 保存仅一项成功。（T1–T4）
- [x] AC7 / F7：浏览器切换绑定、审批、取消、保存失败重试、刷新恢复；页面显示停止/验证/保存不同维度，重试保存不再调用模型/工具；控制台和错误覆盖层无异常。（T7）
- [x] AC8 / F8：多行文件/stdin、resume、JSON/JSONL；直接解析 stdout，事件递增且仅一个终态；启动失败 runId 为 null，正常结果关联日志；EOF、超时、SIGINT、保存和清理失败按约定退出，旧 CLI 仍可交互。（T8）
- [x] AC9 / F9：未授权命令触发 blocked/退出码 3，动作未执行且无需 stdin 回复；policy 允许项执行、deny 胜出；Plan 写入与 MCP 工具仍被拒绝。（T8）
- [x] AC10 / F10：以不同 data-dir 连续运行，用户目录哨兵配置、权限、日志不被读取/修改；fixture 之外的 MCP 未启动，无关模型密钥未进入 MCP 子进程。（T3、T8、T9）
- [x] AC11 / F11：确定性测试覆盖配置/执行/恢复，浏览器首轮闭环通过；默认 npm test 不产生真实模型请求，故障路径可重复。（T1–T11）
- [x] AC12 / F12：E1–E6 固定初态进入独立 CLI；外部验收区分正确修改、伪完成、禁止副作用、验收故障；Agent 改写工作区同名测试不能改变判分。（T9）
- [x] AC13 / F13：生成包含全部重复结果的基线及可比版本报告，列明失败分母/缺失数据/人工介入；候选改善按同条件复测，不把单次成功或自评当通过率。（T10–T12）

## 集成与安全检查

- [x] N1：用合成敏感哨兵检索设置响应、错误、日志、模型请求、普通配置导出，确认无明文；真实截图不展示密钥，私密配置/备份权限为 0600、目录 0700。
- [x] N1：跨站 Origin、伪 Host、缺管理会话、缺 CSRF token、访问他人 operationId 均被拒绝；合法本地设置操作成功，不依赖可伪造 forwarded headers。
- [x] N2：结构审查确认 core 不导入 React/Next/UI，Web/CLI 配置与执行共用 runtime；依赖清单没有新增 Agent 框架、托管执行或未说明运行时依赖。
- [x] N3：模拟存储不可写、临时文件写入失败、并发保存、进程崩溃和配置损坏；旧完整文件可保留/显式恢复，无法解析时不切换为另一配置来源。
- [x] N4：路径真实解析和符号链接边界仍生效；MCP 配置解析不 spawn、不请求网络；审批前后配置/目标改变触发既有复检规则，不继承无效授权。
- [x] N4：两个运行共享 MCP 时变更配置，既有租约可完成、新租约使用新配置；断开排空、失败重连和取消不会杀死无关运行或遗留子进程。
- [x] N5：键盘可完成表单和主要操作；字段标签、错误反馈、加载/空/失败/禁用状态明确，颜色不是唯一状态提示。
- [x] N6：模型探测 30 秒、MCP 探测 20 秒默认总时限和取消可观察；单次 CLI 外层时限覆盖准备至清理，父执行器在宽限后终止进程组，报告未完成清理。
- [x] F8、F13：日志 schema 扩展向后兼容旧记录/导出，日志写失败有 warning/非零结果；硬崩溃没有终态时评测器保留 executionId 和证据缺失。
- [x] F10、F12：验收器及预期数据位于授权工作区外，禁止 Agent 修改；隔离凭据仅按显式引用传入，不自动加载日常 .env.local。

## 确定性回归与项目检查

下面命令在对应实现及测试文件建立后执行；当前不存在的拟新增测试不视作已运行。

- [x] T1–T3：配置存储、导入、身份和路径注入测试通过；执行 task.md 中对应命令并记录跨进程证据。
- [x] T4–T5：MCP 生命周期、本地管理保护和设置 API 测试通过；记录 HTTP/stdio 及审批取消两类结果。
- [x] T6–T8：设置组件、聊天摘要、CLI 协议及权限测试通过；记录 JSON stdout 解析和退出码断言。
- [x] T9–T10：评测器与报告测试通过；人工复核任务分母、blocked 与验收 passed 可并存、usage 缺失不为零。
- [x] 全部确定性测试通过：`npm test`，记录退出码及跳过项；平台跳过不等于验收通过。
- [x] ESLint 通过：`npm run lint`，退出码 0。
- [x] 严格类型检查通过：`npm run typecheck`，退出码 0。
- [x] 生产构建通过：`npm run build`，退出码 0；按 lint → typecheck → build 顺序。

## 浏览器与终端端到端

- [x] 启动隔离开发服务，用 agent-browser 从空态完成模型→工作区→可选 MCP→对话→审批→结束摘要，记录页面、控制台与错误覆盖层观察。
- [x] 浏览器检查错误凭据、目录失效、MCP 拒绝/超时、配置冲突、保存失败和刷新恢复；每个错误可定位修复，历史消息可访问。
- [x] 在 tmux 启动交互 CLI 并输入真实请求，观察模型请求→工具→本地结果→最终回复→持久化；仅使用预先提供的未入库凭据，不在命令或录屏中展开密钥。
- [x] 在 tmux 配合本地模型替身分别覆盖工具失败、无效参数、命令超时、达到最大轮数；记录正确停止及资源清理，不声称这是随机真实模型覆盖。
- [x] 单次 CLI 无人工输入执行完整 fixture，父进程等待退出，输出可解析且关联 export-run；验证“进程成功退出但外部验收失败”的反例。
- [x] 测试结束关闭浏览器、tmux 测试会话、开发服务、fixture 服务和 MCP/受管子进程；不影响用户其他进程。

## 真实模型基线与改善

- [x] 调用前明确 provider、cases、repeat、轮数和总时限；凭据通过环境或本地私密存储提供；未明确时不请求服务，记录未验证原因。
- [x] E1–E6 在固定初态、策略和版本下重复运行；建议每 case 3 次，若预算缩减则明确样本数及缺口；保留每次 executionId/runId 和外部验收结果。
- [x] 报告真实调用故障、超时、授权阻塞、产物错误和证据缺失，外部故障不静默剔除；E1 人工评分单列，MCP fixture 与远程 smoke test 分开。
- [x] 最多三个问题按“事实→证据→影响→假设→证伪标准”整理，已有合理恢复和验证保留；没有证实缺陷时不盲改。
- [x] 若存在候选修复，一次改一个主要因素，运行相关回归及同条件重复评测；报告质量与效率，失败或无提升不包装成改善。若无候选修复，记录不适用原因，不能标为已经提升。
- [x] 发布到仓库的只有脱敏任务、使用文档和结论；原始代码正文/日志/会话/截图留忽略目录；不提交密钥或真实评测记录包。

## 实际结果

当前结果：2026-10-14 已补齐本轮功能与验收链路，清单在下列证据边界内通过。确定性测试 466/466，无失败或跳过，lint → typecheck → build 均为 0。真实全量回归每例 3 次，E4 专项候选另 3 次，tmux 真实交互 1 次；原有单样本失败不删除，不宣称模型开放任务全通过。详见 [收尾验收](../../evals/interaction-closeout-2026-10-14.md)。此结论覆盖本机单用户、当前 macOS 环境；不保证任意模型输出、远程 MCP 可用性或所有外部文件恶意替换场景。

实施阶段按以下格式追加：

| 检查项 | 状态 | 命令/环境 | 退出码与关键观察 | 脱敏证据路径 | 限制/下一步 |
| --- | --- | --- | --- | --- | --- |
| 确定性回归 | 通过 | `npm test` | 0；443/443，通过数含本轮配置、CLI 与 mock 评测测试 | `src/lib/local-settings-store.test.ts`、`tests/eval-runner.e2e.test.ts` 等 | 未覆盖真实模型效果与全部故障路径 |
| 项目检查 | 通过 | `npm run check`（lint → typecheck → build） | 0；生产构建含 `/settings` 及设置 API | `package.json` | 后续代码变更需重跑 |
| 设置→首轮模拟对话 | 局部通过 | 隔离 `ORBITCODE_DATA_DIR`、开发服务 3108、agent-browser、回环模型替身 | 界面新增/改名模型与工作区、保存 MCP、返回对话后收到模拟回复，显示验证未通过；设置 GET 不含合成密钥；浏览器 errors 空 | `src/components/settings/settings-panel.tsx`、`src/app/api/settings/route.ts` | 尚未覆盖所有审批、取消与保存失败交互 |
| 损坏设置恢复 | 局部通过 | 隔离开发服务 3109、agent-browser | 设置页显示显式恢复按钮；点击后旧文件备份且原字节保留，备份/新设置均 0600；无错误覆盖层 | `src/lib/local-settings-store.test.ts`、`src/app/api/settings/recovery/route.ts` | 符号链接与外部并发替换仍需扩展测试 |
| 配置损坏时历史只读 | 通过本次范围 | 隔离开发服务 3110、预建旧会话、损坏设置、agent-browser | 会话列表和详情仍可打开，旧模型/工作区标为不可用，新建与输入禁用；浏览器 errors 空，未触碰损坏文件 | `src/components/chat-workspace.tsx`、`src/components/conversation-list.tsx` | 只读历史已验证，主动修复仍需前往设置页 |
| CLI JSON/JSONL 与策略 | 局部通过 | `npx tsx --test tests/cli-run-once.e2e.test.ts` | mock 模型完成时单 JSON；未授权写入 blocked/退出码 3，不落盘；显式策略放行后 JSONL 唯一终态 | `tests/cli-run-once.e2e.test.ts` | 尚未覆盖硬崩溃与全部信号路径 |
| tmux 交互闭环 | 通过本次模拟任务 | 隔离 `--data-dir`、tmux、回环模型替身 | 模型两轮、`read_file` 成功读取工作区标记、最终回复、revision 1 保存；测试进程已结束 | `src/cli/main.ts`；原始会话已按隔离测试清理 | 不是随机真实模型能力证明 |
| 评测执行器 | 局部通过 | `npx tsx --test tests/eval-runner.e2e.test.ts` | E1 mock 独立 CLI 终态并标人工待评；E5 fixture 实际 `tools/call` 与答案标记通过；失败产物与假完成测试通过 | `src/evals/fixtures.test.ts`、`tests/eval-runner.e2e.test.ts` | 真实基线另见下行；每例样本仅一次 |
| 全用例确定性闭环 | 通过本次 fixture | 独立 CLI 子进程、真实本地文件与沙箱命令、模拟模型 | E2/E3 外部函数用例通过；E4 真实检查失败→修改→检查成功，按 callId 读取真实参数核对；E6 无禁止副作用且说明边界；E1 人工待评 | `tests/eval-runner.e2e.test.ts` | 不等于真实模型效果通过 |
| 并发与崩溃锁回收 | 通过本次范围 | 两个独立进程竞争，持锁子进程 SIGKILL | 同 revision 仅一个事务成功；死 owner 锁被回收；恢复改为先硬链接备份再原子替换，原文件没有移走窗口 | `tests/settings-cross-process.e2e.test.ts` | 外部恶意替换不属于事务写入者 |
| 模型测试取消与 MCP 管理 | 通过本次范围 | 隔离开发服务 3111/3112、agent-browser、模型与 HTTP/stdio 替身 | 模型探测成功带时间，取消显示已取消；两种 MCP 均显示 echo 工具并可断开；12 轮/3 分钟/strict 偏好保存，清除凭据后模型停用；浏览器 errors 空 | `src/components/settings/settings-panel.tsx` | MCP 探测总超时仍未在浏览器等待完整 20 秒 |
| tmux 四类异常 | 通过本次模拟任务 | 隔离数据目录，默认 permissive 为测试显式设置，2 轮预算 | not-found 与 invalid-arguments 回传模型后最终回复；sleep 命令 100 ms 超时并 SIGTERM；最后一次工具未执行，唯一 max-iterations 停止；每轮保存 revision，资源已关闭 | 终端观察；已有自动化故障用例可复跑 | 首次替身含非法 ID 的四次结果不计入覆盖 |
| DeepSeek Flash 真实基线与候选 | 局部通过 | E1–E6，各组每例 1 次；180 秒/12 轮 | 两组各 6/6 completed；自动验收 4 passed/1 failed/1 indeterminate → 5 passed/0 failed/1 indeterminate；E1 人工部分通过；E4 原始退出码证据改善但效率未提升 | `docs/evals/deepseek-flash-2026-10-13.md` | 单样本不能证明稳定性；MCP 为本地 fixture；其余清单未完成条件保持未勾选 |

通过率分母使用实际清单项数，未验证与不适用分别列出；真实评测通过率按每 case 实际运行次数单独计算。


### 2026-10-14 收尾证据索引

| 清单 | 新增或复用的验证 | 结论及边界 |
| --- | --- | --- |
| AC2、AC3、AC5 | settings-service/settings-import/settings-snapshot 单元测试；浏览器错误凭据、30 秒超时、取消、编辑后失效、无效路径、配置冲突、不可写反馈 | 凭据保留/替换/清除、稳定身份与显式来源有效；目录停用/移除不删除文件 |
| AC4、N4 | settings-api.e2e、mcp-connections、mcp-e2e、stdio-transport | HTTP/stdio 显式连接、审批、发现、断开/重连；保存零启动，停用真实 stdio PID 退出，旧租约排空；不重复业务调用 |
| AC6、AC10 | settings-runtime.e2e、settings-snapshot、runtime-parity.e2e、settings-cross-process.e2e、cli-run-once-process.e2e | 运行中更新，当前轮旧模型/目录、下一轮新模型/目录；显式隔离读取路径，损坏日常兼容配置及项目环境哨兵不影响运行；不同 data-dir 不混写；MCP 不继承无关凭据。测试进程注入合成默认用户目录（不修改 HOME）；损坏配置/权限/MCP 与日志哨兵保持原样，两次实际运行各写入独立目录；生产用户文件未受影响 |
| AC7、N5 | chat-session-state 与 conversation-binding 测试；agent-browser 严格模式本次允许、拒绝 MCP、取消、保存失败→恢复权限→重试→刷新、模型切换 | 停止/验证/保存分别显示；重试前后模型请求计数 13→13。实际使用 focus → Tab → 键盘输入 → Enter 提交工作区表单并显示路径错误，再以 Enter 提交运行偏好成功；原生标签与按钮经结构检查；不声称已做全屏幕阅读器或所有浏览器认证 |
| AC8、AC9 | cli-run-once 与 cli-run-once-process.e2e | 文件/stdin 多行、resume、JSON/JSONL、EOF、SIGINT、超时、清理/保存/日志失败、唯一终态与 export-run 关联；deny 胜出，permissive+allow 仍不能覆盖 Plan 边界 |
| AC11、AC12、F8/F13 | 全部 466 测试；eval-runner/fixtures/report | 固定任务外部验收、伪完成/恶意验收逃逸失败、CLI 硬退出保留 executionId/退出码及缺口；默认测试只有替身 |
| AC13、T11/T12 | 18 次真实全量回归 + E4 3 次候选；tmux 真实读取闭环；原有四类 tmux 替身异常 | 全量自动 13 passed / 2 failed / 3 indeterminate；E4 专项 3/3 passed；E1 另人工复核。小样本效果与语言一致性保留限制 |
| N1、N3、N6 | local-management-guard/settings-contract/settings-operations/settings-service/local-settings-store 与跨进程测试；浏览器 SSE 操作成功与取消 | 新管理会话独立，跨会话 operationId 拒绝，订阅前不执行、断流取消、晚到成功不复活；请求大小/字段限制；不可写、临时写入中途失败和死 owner 保留事务边界。配置已经持久化但连接清理失败时返回成功及明确警告，避免伪装保存失败 |
| N2、资源清理 | 依赖及 core 导入审查；本轮独立浏览器/3140/3141/tmux 均关闭，原有 3000 服务保留 | 无新增依赖或 Agent 框架；临时私密设置与源码副本已删除，原始运行证据留忽略目录 |

勾选代表按当前任务范围、已列平台及证据完成，不代表模型质量达到 100%，也不把静态结构审查等同于未执行的跨平台测试。拟实施文件合并位置见 task.md，原有验证表是历史证据，不用其旧计数覆盖本次结果。
