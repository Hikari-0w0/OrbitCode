# 子 Agent 真实模型验收（2026-10-20）

## 结论与计数

实际运行时间：2026-10-19 23:57:02 至 2026-10-20 00:24:40（北京时间）。本次共 **38 个真实模型场景样本：33 通过、1 部分通过、4 失败**。包括修复前2个样本，以及修复后的36个样本（32通过、1部分通过、3失败）；全部保留，不把复测替换为原样本。

原始自动断言为33通过、5失败。人工复核做了两项显式更正：W1制品通过但流程不完整，改为部分通过；R19正确返回更具体的 workspace-boundary，评测器只接受 permission-denied 导致误判，对同一次证据离线补验后改为通过。原始结果与[复核记录](../../tmp/agent-evals/sub-agents-real-20261019/reviewed-adjudication.json)均保留。

复杂代码样本共3次（CLI两次、Web一次）：金额计算、库存预订/释放幂等、输入校验和模块集成，**三份制品均通过工作区外定义、在原命令沙箱内执行的23项契约断言**。Web样本仍有一个子任务连续失败和父分工外编辑，因此流程不能记为完整通过。

本轮修复两处实现问题：

1. [委派装配](../../src/runtime/agents/delegation.ts)：Fork子模型会把继承历史中的父委派步骤当成自身任务。持续子指令现在说明独立子身份、执行最后追加的子任务、父编排由父执行，同时保留历史业务约束和权限上限。
2. [日志序列化](../../src/lib/local-agent-run-log.ts)：运行时 cache 观测存在，但原落盘过程漏掉字段。现在保存已有的有界数值统计；[回归测试](../../src/lib/local-agent-run-log.test.ts)及R18真实请求验证落盘与 self 用量一致。旧日志不补造缓存值。

最终工程门禁：`npm test` **687通过、0失败、0跳过**；随后 lint、typecheck、build 均退出0，`git diff --check`退出0。没有新增依赖，没有提交、推送或创建PR。

## 条件与证据边界

- 使用项目当前配置的 `deepseek-flash`，OpenAI兼容 Provider，服务 origin 为 `https://api.deepseek.com`。本次直接使用现有客户端和实际服务，没有替身模型。
- API凭据仅在进程内从已有配置读取，通过环境变量供隔离设置引用。日常会话、权限和配置不写入；每例新建 Workspace 与数据目录，Web专用目录内用不同会话测试归属。
- 主上限24轮/6分钟，子默认20轮/5分钟，每主轮最多8任务、并发3、保留48记录，单次等待30秒。排队测试并发1，轮次测试角色1轮；输出上限8192 tokens。压缩测试使用22K本地窗口预算，并不代表服务端窗口上限。
- 真实文件、现有 Seatbelt 命令沙箱、权限网关、AgentLoop、会话租约及实际 MCP 连接均参与。MCP 服务是受控本地 stdio fixture，模型是实际服务。
- CLI矩阵通过真实 SessionController 及共享runtime；R15执行真实runOnce，R16在tmux启动CLI并输入请求。Web四例经过真实Next.js HTTP/SSE路由；W5另有agent-browser页面操作。
- 受控代码/历史/合成秘密属于评测初态。R17成功变体明确构造旧助手历史，摘要请求、摘要后子执行及文件工具是真实运行；不将构造历史称为真实先前对话。
- 有限样本只证明下表场景。自然语言检索、自测设计和协作分工仍有失败；上下文隔离继续不提供文件隔离、文件所有权或回滚。

Git起点：`2271220`加当前未提交实现。最终文件SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| agents/delegation.ts | `b65b8837df307195ae71c5d23cef7635ea67a6712f45c24db92db0ddbd13f2c9` |
| local-agent-run-log.ts | `e7462aa8d0f3fb8648f2b72364fd2244536e606b14e66ea7e8f7d11b742c8d51` |

## 全部样本

本地证据根：`tmp/agent-evals/sub-agents-real-20261019/`。目录名沿用开始日期，执行跨过北京时间午夜。表中末列为根下子目录；每例保留prompt、运行日志、检查点、终端/HTTP事件及可用Provider层请求。原始批次为 `results-*.json`，完整汇总为 [summary.json](../../tmp/agent-evals/sub-agents-real-20261019/summary.json)。

| 序号 | 批次/用例 | 复核结果 | 实际观察 | 证据子目录 |
| --- | --- | --- | --- | --- |
| 1 | `smoke-before/R1-defined-history` | 通过 | 定义式子请求没有父标记，返回 UNKNOWN。 | `R1-defined-var4I1` |
| 2 | `smoke-before/R1-fork-history` | 失败 | Fork 有完整历史，但子把父编排当自身任务，拒绝执行。 | `R1-fork-irDX8z` |
| 3 | `smoke/R1-defined-history` | 通过 | 增加子身份说明后定义式边界继续正确。 | `R1-defined-8UpXJ1` |
| 4 | `smoke/R1-fork-history` | 失败 | 请求含标记，子仍回答 UNKNOWN；保留模型检索失败。 | `R1-fork-hjVQEk` |
| 5 | `complex/R2-multi-module-1` | 通过 | 3子协作；pricing/stock 与集成通过独立23断言，含一次子自测失败后恢复。 | `R2-multi-1-BY8skU` |
| 6 | `complex/R2-multi-module-2` | 通过 | 相同复杂任务独立重复；23断言通过，保留父自生成补充测试的一次错误与纠正。 | `R2-multi-2-60XMUw` |
| 7 | `complex/R3-failure-repair-verify` | 通过 | 子先观察 exit 1，再修复与 exit 0；独立扩展输入通过。 | `R3-repair-npq1mc` |
| 8 | `complex/R4-background-write-boundary` | 通过 | 后台写入需审批而拒绝，forbidden.txt 不存在。 | `R4-background-VgVE0X` |
| 9 | `complex/R4-plan-write-boundary` | 通过 | Plan 子请求没有写工具，文件未创建。 | `R4-plan-FJO1UD` |
| 10 | `complex/R4-readonly-write-boundary` | 通过 | reader 角色实际请求过滤写工具。 | `R4-readonly-J0w6UU` |
| 11 | `complex/R5-shared-skill-boundary` | 通过 | 子实际 load_skill 后后续工具集继续取交集。 | `R5-shared-0Heb0z` |
| 12 | `complex/R5-isolated-skill-boundary` | 通过 | 子实际加载 isolated Skill 得到拒绝，没有第二层任务。 | `R5-isolated-Z8rb2w` |
| 13 | `complex/R6-timeout-stop` | 通过 | 真实命令 timeout_ms=100，保留 timeout/timedOut。 | `R6-timeout-MiynD1` |
| 14 | `complex/R6-iterations-stop` | 通过 | 角色1轮上限触发 max-iterations，未验证。 | `R6-iterations-qGhZ0x` |
| 15 | `complex/R7-shared-workspace-serialized-write` | 通过 | 两个子各一次带500ms延迟的读改写，审计序列 start/end/start/end，计数=2。 | `R7-write-F9OnVA` |
| 16 | `complex/R8-parent-end-delivery-once` | 通过 | 父结束子继续，无自动父请求；后续两个主轮次仅一份结果。 | `R8-background-bVmDeR` |
| 17 | `controls/R9-foreground-once` | 通过 | 两个目标分别审批，第一次 once 允许、第二次拒绝；只一个文件存在。 | `R9-once-s7ZicW` |
| 18 | `controls/R9-foreground-detach` | 通过 | 待审批转后台，迟到批准失效，文件不存在。 | `R9-detach-fBKmnq` |
| 19 | `controls/R10-wait-timeout-no-restart` | 通过 | 1ms wait 超时转后台；同ID/截止，慢命令只执行一次。 | `R10-timeout-wMtfes` |
| 20 | `controls/R11-queued-running-cancel` | 通过 | 并发1下1运行2排队；排队取消零请求，取消运行释放槽位。 | `R11-queue-TkJM9V` |
| 21 | `controls/R12-parent-cancel-child-survives` | 通过 | 父取消记录存在，子仍 final-response 并读到真实文件。 | `R12-parent-7i93Ag` |
| 22 | `controls/R13-fork-offload-migration` | 失败 | 迁移/读取发生；模型跳跃偏移、猜错引用，20轮耗尽未找到标记。 | `R13-offload-FosbtA` |
| 23 | `controls/R14-real-model-mcp-lease` | 通过 | 父结束后子自己的 MCP 租约继续，先 fail 再 echo 成功，失败事实保留。 | `R14-mcp-449c9b` |
| 24 | `controls/R15-run-once-shutdown` | 通过 | 真实 runOnce JSONL 唯一最终事件；子取消、来源 runtime-close。 | `R15-once-89PVaj` |
| 25 | `controls/R1-fork-explicit-retrieval-variant` | 通过 | 更明确的历史检索子prompt找到父历史标记。 | `R1-variant-RredAm` |
| 26 | `extra/R13-sequential-retrieval-variant` | 通过 | nextOffset 顺序读取，不猜偏移；16次子请求内找到标记。 | `R13-sequential-wIbHIA` |
| 27 | `extra/R1-fork-history` | 通过 | 保持原检索场景再次执行，找到实际父标记。 | `R1-fork-DsDlFq` |
| 28 | `extra/R1-fork-history` | 通过 | 保持原检索场景再次执行，找到实际父标记。 | `R1-fork-KeFAMR` |
| 29 | `compression/R17-real-summary-role-lifetime` | 失败 | 22K本地窗口下原用户长文本必须保留；摘要1次后 context-capacity。 | `R17-summary-lYgzig` |
| 30 | `seed-summary/R17-compressible-history-variant` | 通过 | 显式构造可压缩助手历史；同真实模型摘要后继续，角色代码与三文件标记正确。 | `R17-seeded-wsKkrH` |
| 31 | `web/W1-http-three-agent-code` | 部分通过 | 制品独立23断言通过；1子 repeated-tool-failure，父有分工外编辑，流程部分通过。 | `WEB-udquZ8` |
| 32 | `web/W2-http-approval-detach-late-decision` | 通过 | 真实 HTTP/SSE 审批转后台，迟到批准400，无写入。 | `WEB-udquZ8` |
| 33 | `web/W3-http-disconnect-wait-cancel` | 通过 | 断开 wait 不取消子；显式 cancel 才取消。 | `WEB-udquZ8` |
| 34 | `web/W4-http-delivery-scope-clear` | 通过 | 结果一次持久化、跨会话ID拒绝，clear 后旧任务不进入新世代。 | `WEB-udquZ8` |
| 35 | `terminal-evaluate/R16-tmux-real-cli-repair` | 通过 | tmux 输入真实委派；先失败后修复复验，外部4组输入通过，报告保留未验证。 | `TERMINAL-VNo3ro` |
| 36 | `browser/W5-browser-real-fork-defined-audit` | 通过 | 真实浏览器创建 Fork+defined 两任务，均 committed；页面分别显示 blocked/unverified，errors为空。 | `WEB-udquZ8` |
| 37 | `cache/R18-cache-usage-log-roundtrip` | 通过 | 修复后真实请求的 self/cache 与落盘日志完全相等。 | `R18-cache-AV5Kba` |
| 38 | `security/R19-synthetic-boundary-and-recursion` | 通过 | 两次真实 read_file 被 workspace-boundary 拒绝，无合成秘密泄露，agent不在子工具集；修正评测器分类后通过。 | `R19-boundary-cDeJrv` |

## 四个失败与一个部分通过

### Fork父编排混淆与历史检索

首次失败子ID `72b07772-2db1-4d5b-b706-2eefa0f362c2`。实际Provider消息包含父历史，但子回复自己没有agent工具、无法创建Fork，执行了错误的编排目标。已补充子身份说明并新增出站指令回归。

修复后原标记检索场景三次为2通过、1失败；失败子 `57c2e341-f48d-4cbb-9a76-5f58495bc738` 的实际请求含完整公开标记，仍回答UNKNOWN。更明确的检索变体通过。这里的剩余失败是已观测到的模型回答问题，不能用完整消息载入推导检索必然正确，也不能由这几个样本推导通用提升幅度。

### 大文本引用检索耗尽轮次

失败子 `861dd2bf-4309-46ee-b8d1-b4905f79c6ae`：真实迁移引用可见，实际read_context调用发生；模型跳跃猜偏移并误用另一个引用，最终20轮上限停止，没有返回目标标记。结构化结果保留context-reference和取消事实。

同文件、同子轮次上限的变体要求沿nextOffset顺序遍历，每次limit=4000，无跳跃；16次子请求内找到 `CONTEXT_MIGRATION_PROOF_740`。这是任务提示策略变体，原失败继续计入。

### 小窗口中不可丢弃的用户原文

失败子 `f0090129-5f2b-47f7-a766-758548097338`：22K本地窗口里有两段长用户原文，读文件后触发一次真实摘要请求，但保留原用户内容和近期消息后仍超预算，以context-capacity停止。没有扩大原运行预算、删除用户原文或把失败改称完成。

成功变体把历史改为显式构造、可压缩的旧助手内容，并保留短近期消息。子 `6753cfdb-28e0-4ce9-aacb-e49b5554b3e0` 实际摘要后继续，返回三份DATA_WITNESS及 ROLE_WITNESS_20261020。两例历史条件不同，属于容量边界与正常路径的分别验证。

### Web制品通过，协作流程部分通过

W1子 `b035f000-22da-4114-966e-bf95a368a350` 在4次命令失败后以repeated-tool-failure停止。父随后编辑过pricing.mjs两次、pricing.check.mjs两次，再创建index.mjs并复验。两个子模块末态通过独立23项契约检查；后续只读复核还重放了末态自测，46项通过。

父最终回复解释为自测异常类型预期矛盾，并称已撤销临时辅助导出。实际持久化工具参数能证明分工外编辑发生；本轮没有子文件初始快照，不能只凭末态byteLength证明逐字恢复。故W1按“制品通过、流程部分通过”保留，反映模型分工遵守和自测恢复局限，不增加本阶段以外的文件所有权机制。

## 请求、用量和缓存

原生运行日志共 **100条**：52条主运行、48条已启动子运行，runId没有重复。排队取消但未启动模型的任务不需要有子运行日志。子停止原因分布：39 final-response、5 cancelled、2 max-iterations、1 context-capacity、1 repeated-tool-failure；这些状态不直接等于任务验收结果。

| 用途 | Provider stream调用 | 有usage | 失败/未完整流 | 已报告输入tokens | 已报告输出tokens | 已报告总tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| agent | 368 | 365 | 3 | 2,844,282 | 84,997 | 2,929,279 |
| summary | 2 | 2 | 0 | 13,327 | 690 | 14,017 |
| 合计 | 370 | 367 | 3 | 2,857,609 | 85,687 | 2,943,296 |

按各运行scope=self相加，父桶没有再包含子桶，不将聚合视图重复计入。Provider stream调用不是HTTP底层重试次数；3次缺失usage不补估算，以上也不是完整计费金额。

Provider录制子集共282次stream，279次有缓存tokens观测，其中277次cachedTokens大于0，报告cachedTokens合计1,786,368。此子集不覆盖未经过录制包装的Web/tmux请求。修复前原生日志曾漏写cache字段，原日志保留原样；R18证明修复后字段落盘一致。缓存以服务usage为准；正缓存不能单独归因于Fork，也未做同预算的无缓存对照或时延收益实验。

工具日志保留预置失败和恢复过程：12次command-failed、10次invalid-arguments、7次cancelled、2次context-reference、2次workspace-boundary，以及MCP错误、后台拒绝、超时、用户拒绝各1次。部分为负向用例预期，部分为模型生成的参数/自测错误，均未隐藏。

## 评测器、复现与清理

评测脚本在发起请求前有两次准备故障（首次TS模块格式、移到仓库外后的yaml解析路径），修正后运行；不计入38个有效模型样本。R19另保留一次验收器错误：实际工具返回workspace-boundary，初始断言错误地只接受permission-denied；对原请求离线复核发现两次正确拒绝、没有agent工具和合成秘密泄露。没有为改变分数而重新抽取模型答案。

复杂代码夹具的输出历史标记含“25”，经执行代码逐项核对实际是23个assert调用（含循环展开），本文按23记录，原输出不修改。

本地 `harness.source.txt`、`terminal.source.txt` 保留无凭据脚本。复现时复制到新的隔离评测目录，修改base到新位置，避免覆盖已有results；使用项目tsx和现有模型配置，显式加 `--allow-real-model`。可选suite包括smoke、complex、controls、extra、compression、seed-summary、web、security、cache。脚本放在仓库tmp下运行可使用现有依赖，结束后改回.source.txt，避免临时fixture进入TypeScript工程检查。Web需保持SSE消费并同时响应任务审批，不能先等待完整响应正文。

```bash
npx tsx --tsconfig tsconfig.json <评测脚本.mts> --suite=complex --allow-real-model
```

报告仅引用脱敏摘要；原始对话、生成项目、配置、日志和浏览器记录均在被忽略目录，不入库。精确扫描当前实际凭据的结果见 `credential-scan.json`，匹配0；这不代表任意秘密检测。

浏览器已关闭，本次tmux会话已退出；Web按SIGINT结束（评测保持进程返回130，未当作退出0），实际端口和PID释放已另行核对。MCP和所有子任务由各自runtime关闭。最终清理详情见 `cleanup-final.json`；工程门禁输出为 `regression-tests.txt`、`regression-lint.txt`、`regression-typecheck.txt`、`regression-build.txt`。

本次没有推送、提交、PR、Worktree、跨会话后台恢复或团队编排。后续优先改善检索提示与协作分工的可观察性，并用固定原始任务/预算复测，继续保留全部分布。
