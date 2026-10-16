# 项目指令、会话接续与长期记忆 Checklist

状态：已批准
依据：已批准的同目录 spec.md、plan.md、task.md。

已执行本轮确定性验证与隔离进程端到端检查，结果及边界见末尾记录。勾选仅对应实际测试、检查和观察到的场景，不代表真实模型语义质量或所有运行环境均已验收。

## 需求验收

- [x] C01 / AC1 / F1、F3：三来源优先级、非冲突合并、新会话/恢复/下一轮刷新及缺失/不可读行为正确；读取失败没有模型或 MCP 连接。验证：`npm test -- src/runtime/instruction-loader.test.ts src/runtime/background-service.test.ts src/runtime/agent-runtime.test.ts`，捕获请求与调用计数。
- [x] C02 / AC2 / F2：正常相对引用、空格路径、重复、循环、深度 5/6、32/33 文件、16,000/16,001 单文件字节、48,000/48,001 累计字节，以及缺失、绝对路径、URL、父目录和符号链接越界均符合要求。验证：`npm test -- src/runtime/instruction-loader.test.ts src/lib/bounded-files.test.ts`；拒绝目标内容哨兵不得出现在读取结果与诊断。
- [x] C03 / AC3 / F3、F11：指令与笔记含越权、泄密要求时仍受现有权限约束，普通规则可加载；跨项目 memory 引用与通用主目录读取不能因此获准。验证：`npm test -- src/tools/read-memory.test.ts src/tools/permission-gateway.test.ts src/runtime/project-memory.integration.test.ts`。使用虚构秘密哨兵，禁止真实凭据。
- [x] C04 / AC4 / F4：缺结果调用保留 callId 并标为未知中断，不重放；重复 callId、孤立结果阻止继续；revision 冲突不覆盖，绑定不改变。验证：`npm test -- src/runtime/conversation-recovery.test.ts src/lib/local-conversation-store.test.ts src/runtime/conversation-service.test.ts`，断言工具实际执行计数。
- [x] C05 / AC5 / F5：最新背景计入实际请求预算；接近上限时先压缩，压缩失败、容量不足、熔断均停止相应请求。验证：`npm test -- src/runtime/background-service.test.ts src/core/context/context-manager.test.ts src/runtime/agent-runtime.test.ts`，保留预算前后及调用计数证据。
- [x] C06 / AC6 / F5：23:59:59、24:00:00、超过 24 小时、缺失/未来时间与重命名场景提醒正确，每个请求只有一份，不持久化重复提醒，不声称文件已重新验证。验证：`npm test -- src/runtime/background-service.test.ts src/runtime/conversation-service.test.ts`，使用固定时钟。
- [x] C07 / AC7 / F6：正常最终回复保存后一次提取；保存失败不提取、retry-save 成功一次；取消、错误、超时、最大循环与未完成调用均零提取。验证：`npm test -- src/runtime/run-agent-turn.test.ts src/runtime/memory-lifecycle.test.ts src/runtime/conversation-service.test.ts`，对比保存 revision 与任务来源。
- [x] C08 / AC8 / F7：慢响应、断网替身、非法响应、额外工具调用、超时、队满及进程中断有界结束；最终对话状态不改变，关闭/清空/删除后无迟到提交。验证：`npm test -- src/runtime/memory-extractor.test.ts src/runtime/memory-jobs.test.ts src/runtime/memory-lifecycle.test.ts`，使用屏障控制竞争顺序及真实子进程崩溃。
- [x] C09 / AC9 / F8、F9：四类笔记可检查，用户级仅保存有跨项目依据的信息；项目笔记不跨项目加载，临时日志/无依据事实/虚构密钥被拒绝，参考链接未读取时标为 reference-only。验证：`npm test -- src/runtime/memory-validation.test.ts src/runtime/memory-store.test.ts src/runtime/memory-service.test.ts`。
- [x] C10 / AC10 / F9：200/201 行、25,000/25,001 字节、中文多字节与末尾换行边界正确；超限候选未收录且旧数据完整。验证：`npm test -- src/runtime/memory-index.test.ts src/runtime/memory-store.test.ts`，核对实际 UTF-8 大小与逻辑行数。
- [x] C11 / AC11 / F10：重复、冲突、伪造来源/路径、非法 frontmatter、并发进程、人工修改和各提交阶段中断不会丢更新或提升证据等级；HEAD 始终指向完整代，人工分叉内容保留。验证：`npm test -- src/runtime/memory-validation.test.ts src/runtime/memory-store.test.ts src/runtime/memory-lifecycle.test.ts`。
- [x] C12 / AC12 / F11：捕获连续 Agent 请求，只有当前作用域有效索引而非全正文；正文分页经当前引用读取，过期/越界引用拒绝；索引损坏告警降级，正文工具输出计入预算。验证：`npm test -- src/runtime/background-service.test.ts src/tools/read-memory.test.ts src/runtime/project-memory.integration.test.ts`。
- [x] C13 / AC13 / F12：两端均能检查来源、任务状态、修改/删除笔记及切换开关；下一轮刷新，同一来源不复活已删除笔记；查看和编辑零模型调用。验证：`npm test -- src/web/background-http.test.ts src/components/conversation-background-panel.test.tsx src/cli/commands.test.ts src/cli/terminal-chat.test.ts src/runtime/memory-service.test.ts`，再执行 E01/E02。
- [x] C14 / AC14 / F13：30 天前一毫秒、恰好 30 天、超过 30 天、未来/非法更新时间的候选分类正确；启动和预览不删除。验证：`npm test -- src/runtime/conversation-cleanup.test.ts src/web/conversation-cleanup-http.test.ts`，比对会话目录前后清单。
- [x] C15 / AC15 / F14：选定清理复检 revision、期限、租约、待保存/恢复，部分失败逐条报告；工作区、指令、笔记及独立日志均保留。验证：`npm test -- src/runtime/conversation-cleanup.test.ts src/runtime/conversation-service.test.ts src/web/conversation-cleanup-http.test.ts`，并执行 E03。
- [x] C16 / AC16 / F1、F4、F6、F11、F12：Web 保存笔记后 CLI 恢复同会话获得相同背景，反向亦然；不同隔离配置根不读取/写入日常用户资料。验证：`npm test -- src/runtime/project-memory.integration.test.ts` 与 E01/E02；记录解析后的测试目录标识，不读取真实用户记忆。

## 集成、安全与资源

- [x] I01：依赖方向保持入口 → runtime → core/工具/模型；core 不导入 runtime、React 或页面，后台提取不使用 AgentLoop；`package.json` 与 lockfile 无新增运行时依赖。验证：检查改动导入和依赖 diff，结合 typecheck；记录实际检查命令及结论。
- [x] I02：用户级 memory 配置与任务状态服从 data-dir；项目仍来自明确绑定的 Workspace。验证：在两个临时 data-dir 和两个临时 Workspace 中放不同哨兵，调用 Web、交互 CLI、run-once，捕获文件访问与请求载荷。
- [x] I03：后台提取输入/输出、工具读取、加载与锁超时符合 Plan 限额；单并发、8 队列、30 秒、0 重试均有计数证据。验证：`npm test -- src/runtime/memory-jobs.test.ts src/runtime/memory-extractor.test.ts src/tools/read-memory.test.ts`。
- [x] I04：来源锁→用户状态锁→作用域锁无反向获取；并发关闭、删除、清空、提交和两端竞争均有界返回。验证：`npm test -- src/runtime/memory-lifecycle.test.ts src/runtime/memory-store.test.ts`，记录子进程退出码。
- [x] I05：管理接口拒绝非本地/非法来源、任意路径及过期 revision；笔记正文按文本显示，不能作为 HTML 执行。验证：`npm test -- src/web/background-http.test.ts src/web/conversation-cleanup-http.test.ts src/components/conversation-background-panel.test.tsx`。
- [x] I06：虚构凭据哨兵不进入提取请求、笔记、索引、诊断及持久状态；原始供应商错误不直接输出。验证：提取/存储集成替身注入哨兵，搜索隔离输出目录并断言无匹配；不得扫描或打印真实环境变量。
- [x] I07：新工具不削弱工具参数校验、Plan 模式、命令超时和 Workspace 边界。验证：`npm test -- src/tools/registry.test.ts src/tools/permission-gateway.test.ts src/core/agent-loop.test.ts src/web/chat-contract.test.ts`。

## 项目检查

严格按以下顺序执行，前项失败先修复；新增修改后根据影响重跑相关检查。

- [x] Q01：`npm run lint` 退出码 0。
- [x] Q02：`npm run typecheck` 退出码 0。
- [x] Q03：`npm run build` 退出码 0。

## 端到端操作与证据

所有场景使用临时 data-dir、临时 Workspace、虚构凭据和本地 OpenAI 兼容替身。fixture 已实现，接口为 `npx tsx scripts/fixtures/project-memory-provider.ts --port <port> --scenario <scenario> --evidence-dir <临时证据目录>`；scenario 为 happy、tool-failure、invalid-arguments、command-timeout、max-iterations。替身仅用于证明实际进程/工具/存储链路，不声称证明真实模型提取质量。

准备：将替身地址及虚构凭据写入隔离目录的托管配置，绑定临时 Workspace；预置三层指令、include、测试笔记及指定时间会话。不得修改日常设置。Web 以 `ORBITCODE_DATA_DIR=<隔离目录> npm run dev -- --port <web端口>` 启动；CLI 使用 `npm run cli -- --data-dir <隔离目录> --resume <会话ID>`。保存命令、端口、PID、会话 ID 和脱敏请求记录，结束回收进程。

- [x] E01：使用 agent-browser 打开隔离 Web，创建会话并输入包含明确项目偏好的请求；观察实际工具调用、最终回复与保存成功，随后状态由 queued/running 转到 saved。检查背景面板、正文、开关及删除，检查页面内容、错误覆盖层和控制台错误。记录浏览器检查命令与输出；结束关闭浏览器。若 agent-browser 不可用，记录阻碍，不能用单元测试勾选此项。
- [x] E02：在 tmux 中启动交互 CLI，恢复 E01 的会话，查看 `/background`、`/memory list` 和正文；输入需读取笔记的真实请求，确认替身收到索引并通过 read_memory 获得正文。CLI 正常保存新偏好后回到 Web 同一会话，下一轮看到更新。CLI run-once 退出取消未完成提取可产生 abandoned，前台结果保持成功；另记录这一退出边界。
- [x] E03：两端先预览混合过期/未过期/活动/待恢复会话；预览后更新一个候选 revision，再选定清理。观察过期且无冲突的选定项删除，其余明确跳过；清理前后比对测试工作区、指令、记忆和独立日志 hash。
- [x] E04：在 tmux 依次使用 tool-failure、invalid-arguments、command-timeout、max-iterations 场景。工具失败使用真实失败命令，无效参数须被工具校验拒绝，命令超时由本地执行器终止，最大循环由真实 AgentLoop 上限停止。核对退出状态、工具结果和终止原因；异常停止零提取，工具失败后若正常恢复并最终成功保存可提取，不能把两者混淆。沙箱不可用时明确记录未验证，不放宽沙箱。
- [x] E05：终止包含未完成轮次的测试进程后重启，通过已有 recover 恢复；检查未知中断标记、无工具重放，构造超 24 小时时间提醒并触发必要压缩。过程只恢复会话状态，不回滚测试工作区文件。
- [x] E06：所有浏览器、开发服务器、替身和 tmux 测试进程关闭，确认相关端口不再监听；测试产物不加入 Git，用户原有服务不受影响。

## 实际结果（2026-10-15）

本轮 32/32 检查项通过；全量测试 499/499，无失败、跳过或取消。下表记录检查项的实际证据。更细的输入边界以对应测试断言为准；端到端仅使用本地替身，不代表真实模型会准确遵循全部自然语言偏好。

执行命令及退出码：

- `npm test`：0，499 项通过，约 8.4 秒。完整输出：`/tmp/orbitcode-project-memory-tests-complete.txt`。单项命令见各检查项；补充提取异常、时间边界、凭据隔离和四阶段提交失败用例已纳入本次全量运行。
- `npm run lint` → `npm run typecheck` → `npm run build`：依次退出 0。构建输出：`/tmp/orbitcode-project-memory-build-complete.txt`。
- `git diff --check`：0。`git diff --numstat -- package.json package-lock.json` 无输出，未新增依赖；检查 core 导入未发现 runtime、React、Next.js 的反向依赖。
- agent-browser 的 open、snapshot、screenshot、errors、console、close 均完成；最终页面无 JS 错误、错误覆盖层，控制台仅开发环境 React/HMR 提示。

| 检查项 | 实际结果与证据 |
| --- | --- |
| C01 | instruction-loader、background-service 和共享运行层集成测试通过；来源顺序为 user → project-agents → project-instructions，每轮重新准备背景，错误在请求前阻止继续。Web 请求记录包含三来源。 |
| C02 | include、bounded-files 测试通过：深度/文件数/UTF-8 大小边界、循环、缺失、绝对路径、URL、父目录及符号链接越界被限制；敏感文件内容不通过 include 加载。 |
| C03 | read-memory、权限网关、文件/命令沙箱与共享集成测试通过；不透明引用不能换成外部路径，既有 Workspace 与敏感目录限制仍生效，包括未来创建的 memory 目录。提示组装明确层级，未用真实模型证明其自然语言服从性。 |
| C04 | recovery、conversation-store/service 测试通过；真实进程中断后恢复 checkpoint，缺结果保持未知，不重放工具，effect.txt 未回滚。 |
| C05 | context-manager 测试和实际旧历史恢复通过；容量不足安全终止，调整测试窗口后先摘要再继续工具/最终回复；请求含背景预算。 |
| C06 | 固定时钟测试验证阈值、缺失及未来时间；提醒使用 lastTurn.endedAt，独立于 summary.updatedAt。实际 48 小时恢复后两个 Agent 请求各含一份提醒。 |
| C07 | run-agent-turn 的终止原因/保存状态矩阵及 retry-save 集成通过；保存失败零提取，重试保存后使用原模型快照一次提取，异常停止不调度。 |
| C08 | 无效 JSON/结构、工具响应、输出/输入超限、网络错误、队满、截止信号和取消竞争测试通过；独立后台子进程 SIGKILL 后为 abandoned，已保存 revision 1 与零笔记保持，无队列重放。见 background-crash.json。 |
| C09 | 四类别、证据、跨项目依据、reference-only、明显进度/孤立日志及虚构凭据校验测试通过；用户/项目隔离验证通过。自然语言事实真伪仍非 schema 可证明。 |
| C10 | 索引 200/201 行、25,000/25,001 字节、中文与换行测试通过；实际存储容量不足拒绝候选并保持旧修订。 |
| C11 | 版本、去重、冲突、人工编辑、删除墓碑、来源和 frontmatter 校验通过；两子进程同修订只有一个保存成功；注入正文、索引、manifest、HEAD 写入失败均保持旧完整版本。 |
| C12 | 快照引用、正文分页、删除/改动后过期、跨作用域拒绝及预算集成通过；CLI 实际 read_memory 取得 Web 生成的正文。 |
| C13 | HTTP/组件/CLI 测试及 Web 实际检查、编辑冲突后保留草稿、刷新修改、开关与删除通过；已删除旧来源不复活。查看/编辑路径不调用模型。 |
| C14 | 30 天前一毫秒、阈值、超过阈值、未来/非法更新时间测试通过；预览前后存储 revision 未变化。 |
| C15 | 清理测试及实际 HTTP 混合集合通过：合格项 deleted，新修订与活动租约 skipped；36 个工作区/指令/记忆/状态/日志等非会话文件 hash 完全一致。见 cleanup-preservation.json。 |
| C16 | Web 保存 → tmux CLI 恢复 read_memory；CLI 生成跨项目偏好 → Web 背景查询看到 user 级笔记。两个临时项目/隔离根测试通过。旧测试辅助代码遗漏的用户根已补齐，清理本轮生成的诊断后重跑未再写入日常目录。 |
| I01 | core 导入与依赖 diff 检查通过；提取仅调用 ChatProvider，不创建 AgentLoop。 |
| I02 | 隔离 CLI 子进程/两个 data-dir 哨兵测试及 Web、交互 CLI、run-once 共享临时根验证通过。测试根记录于 /tmp/orbitcode-memory-e2e.json，未改日常设置。 |
| I03 | 输入/输出、读取、加载/锁限额及单并发+8 等待任务测试通过；30,000ms 截止参数经注入时钟断言，网络失败仅一次请求。 |
| I04 | 生命周期竞争、跨进程 CAS 和短提交等待测试通过；关闭、清空、删除后无迟到提交，模型等待期间不持来源锁。 |
| I05 | 管理接口复用本地/同源保护，严格拒绝路径字段和无修订更新；组件以文本渲染 Markdown，编辑冲突保留输入；契约与组件测试通过。 |
| I06 | 虚构凭据集成验证：提取请求不含已知秘密，含秘密候选拒绝；递归检查隔离 user/workspace 下笔记、索引、诊断及状态无该哨兵；原始供应商错误被转换为安全错误。 |
| I07 | 全量既有工具、Plan、权限、命令超时、AgentLoop 和 Web 合同测试通过，未放宽沙箱。 |
| Q01–Q03 | lint、typecheck、build 依次退出 0。 |
| E01 | 隔离 Web 实际请求 read_file → final-response → saved → 项目笔记；面板编辑/冲突/关闭/删除检查完成，web-memory.png、web-final.png 保留页面证据。 |
| E02 | tmux 恢复原会话并通过 read_memory 读取正文；CLI 保存跨项目偏好后 Web 查询可见。真实 run-once completed/final-response/saved revision 1，退出码 0；未完成提取为 abandoned，见 run-once.txt。 |
| E03 | Web 预览与确认删除、CLI /cleanup preview 和 /cleanup delete + /confirm 均完成；HTTP 竞态与文件 hash 检查通过，见 cleanup-preservation.json、cli-cleanup.txt。 |
| E04 | tmux 中实际失败命令 exit 1、无效参数拒绝、sleep 超时 SIGTERM、3 轮 max-iterations 均观察到；前三者恢复后正常保存，max-iterations 无提取任务。见 cli-failure/invalid/timeout/max.txt。 |
| E05 | 写入 effect.txt 后终止叶子进程，HEAD 仍为 revision 0；重启 /recover 恢复中断会话而不重放写入。人工测试历史为 48 小时，先摘要再 read_file、保存至 revision 5；见 recovery.json、cli-before-kill.txt、cli-resumed-success.txt 及 aged 请求记录。 |
| E06 | agent-browser 会话已关闭，6 个本轮 tmux CLI 均 /exit；18991–18999 的开发服务器/替身全部停止，无监听端口，无剩余本轮 tmux 会话。截图、日志、临时脚本均未加入 Git。 |

本机临时证据根：`/tmp/orbitcode-memory-evidence/`；摘要/提醒请求：`/tmp/orbitcode-memory-evidence-aged/requests.jsonl`。端口 18992 为 Web，其余 18991、18993–18999 为 loopback 替身。主要往返会话为 `9fc18c05-a44f-49b5-9630-cdde56f99259`，真实中断恢复会话为 `9cce62b4-82e0-4165-b4c7-b21e9e7453bd`；只用于本轮隔离环境。

未覆盖环境与风险：未调用真实供应商模型评估提取准确率、长期冲突语义或对恶意自然语言的服从性；实际命令沙箱端到端仅覆盖本机 macOS。应用内提交通过锁/CAS/不可变版本保证一致性，任意外部编辑器不遵守锁时不承诺严格线性一致，保留旧代供检查。凭据校验不能识别一切未知格式或编码后的秘密。后台任务为尽力异步处理，进程退出可放弃，未承诺跨重启必达。


## 真实模型补充验收（2026-10-15）

用户随后授权使用项目真实模型，已完成 3 组 15 轮 DeepSeek Flash 对话。结果为**部分通过**：偏好存取、指令优先级与作用域边界有真实成功证据；项目知识提取、明确纠正及新会话采用纠正后的事实仍不稳定。因此上面的 32/32 仅表示确定性约束与替身场景完成，不能解释为真实模型长期记忆质量已通过。

已修正提取提示中 evidence 数组、correction/replaces 协议说明，校验未放宽；加入真实协议反例后全量测试为 500/500，lint/typecheck/build 退出 0。详细失败与 runId 见 [真实模型报告](../../evals/project-memory-real-model-2026-10-15.md)。后续质量改进需保留失败样本并独立复测，不能以模型最终回复中的“已记住”作为写入成功。


## 真实模型失败修复复验（2026-10-15）

用户授权修复后，已修复异步结果表述、纠正目标限制、人工编辑竞争和旧记忆重复提取。新增 6 项确定性回归后，全量 506/506，lint/typecheck/build 均退出 0（输出：/tmp/orbitcode-memory-repair-tests.txt、/tmp/orbitcode-memory-repair-build.txt）。

最终版本的真实 5 场景加独立空记忆场景，按实际笔记、工具返回、跨项目索引及前后快照比较，6/6 验收通过；前台表述另经人工核对。纯查询保持笔记不变，纠正保存后新会话读出 MARBLE-93，缺少事实时回答未知且未调用工具。详见 [真实模型修复报告](../../evals/project-memory-repair-2026-10-15.md)。上述修复前失败记录保留，不将本次有限成功推广为长期稳定性保证。


## 实际页面与 CLI 真实操作（2026-10-15）

用户要求代为操作验收后，已通过真实浏览器、HTTP、后台存储及 tmux CLI 完成 6 轮 DeepSeek Flash 对话。独立检查 7/7：Web 保存、新会话读原值、纯查询不增笔记、纠正后读新值、跨项目隔离、CLI 读 Web 纠正、Web 显示 CLI 续接。页面无 JS 错误或错误覆盖层，前台耗时约 2.8–4.6 秒（不含后台提取）。测试服务和浏览器已关闭，临时凭据配置已删除。实际操作及 runId 见 [页面与 CLI 验收报告](../../evals/project-memory-web-cli-2026-10-15.md)。本轮未修改功能代码，未将历史 506 项回归当作新运行的证据。
