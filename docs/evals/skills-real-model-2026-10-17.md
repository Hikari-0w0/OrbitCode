# 当前 Skill 实现的真实模型测试

日期：2026-10-17，Asia/Shanghai。用户明确授权使用真实模型。使用项目配置的 **deepseek-flash**，通过真实 CLI 和 Next.js HTTP/SSE 入口执行，保留实际工具结果、会话、文件及 Git 验收证据；没有修改 Agent 实现或内置 Skill。

**有效功能场景 16/16 通过：CLI 12 项、Web HTTP/SSE 4 项。** CLI 共执行 16 轮，Web 完成 4 轮，另有 1 次 Web 评测夹具错误导致的中止，单列保留。有效 CLI 执行中 15 次 completed/退出 0，1 次按预期 blocked/退出 3；这个 blocked 是非交互审批安全验收通过，不是写入成功。Web 完成的 4 轮均以 final-response 停止，并独立核对文件、快照或权限结果。

## 固定条件

- 项目实际可用配置为 deepseek-flash，凭据仅通过子进程环境传入，不写入设置、脚本、提示或报告。CLI 各场景使用独立 Workspace 和数据目录，多轮场景按设计复用会话；Web 使用另一个专用隔离 Workspace/数据目录，以不同会话测试共享、独立及 Plan，快照场景复用原会话。无真实业务数据或远端 Git 仓库。
- CLI 每轮最多 12 次模型迭代、150 秒；Web 使用相同模型配置，最大 12 轮、3 分钟，HTTP 客户端 150 秒超时。白名单交集、Plan/Do、路径边界和审批保持启用。
- CLI 的读取及受测 npm/Git 命令采用隔离策略文件，资源仅授权精确路径；Web 保持 strict，由评测脚本响应实际 SSE 审批为 allow-once，没有改成 permissive。
- 源码指纹：`288ee64e03ccce86e8c3716fb2e43b924846cdafdceed30b9de8aa8f07cdb280`；三个内置 Skill 指纹：`5fe83acb7a9f13d8ec84b4af183089f190912a59b91aa09dbabe9e5ee19a7431`。运行前后均一致。
- 与前次保存配置相比，模型、endpoint、context、thinking、transport 非凭据指纹仍为 `da7c89e157a815f3f9da8e18dac37b3f261c82baea432367ce3646dbc8204c1f`。没有据此推断模型服务端权重保持不变。

## 场景与独立验收

| 场景 | 样本 | 实际结果 |
| --- | --- | --- |
| S1 主动选择目录型 Skill | 1/1 | 普通自然语言请求触发真实 load_skill 和 read_skill_resource；回复包含模板独有核验码和订单号 |
| S2 独立只读审计 | 3/3 | 子运行实际读取批次文件、传递带空格参数；父 activeSkills 为空；没有重复加载自身 |
| S3 共享快照与恢复 | 1/1，三轮 | 激活 V1 后修改源定义；新 CLI 进程恢复仍使用 V1，显式重新激活采用 V2 和新参数 |
| S4 共享白名单交集 | 1/1，三轮 | 同时保留两个不相交白名单，后续不能读取隐藏文件，没有内容泄漏或成功越权工具调用 |
| S5 内置 review | 1/1 | 定位 multiply 使用减法的缺陷及位置，文件未变，实际工具记录保持只读 |
| S6 内置 test | 3/3 | 实际依次执行 lint/typecheck/build，三次均为退出码 `[0,7,0]`；没有追加命令，检查日志均为三行，回复如实保留 typecheck 失败 |
| S7 内置 commit | 1/1 | 临时 Git 仓库仅新增一次提交，只包含 authorized.txt；无关修改未暂存，无远端、无推送 |
| S8 strict 独立写入拒绝 | 1/1 | 子写入触发真实审批；非交互执行 blocked/退出 3，目标文件不存在 |
| W1 Web 共享调用 | 1/1 | 真实 POST /api/chat、解析 SSE、批准读取；回复有实际文件标记和带空格参数，激活持久化 |
| W2 Web 刷新与后续回合 | 1/1 | 修改源文件并通过 skills API 刷新，后续真实模型仍遵循 V1；停用 API 成功，最终快照 activeSkills 为空 |
| W3 Web 独立审批写入 | 1/1 | SSE 在子工具完成前收到审批，allow-once 后实际写入正确内容；父激活未污染。主回复明确 sideEffect=applied、verification=unverified，没有把写入等同于验证 |
| W4 Web Plan 限制 | 1/1 | 加载含写入要求的 Skill 后模型说明只读限制，无成功写工具执行，目标文件不存在 |

CLI 结果由检查脚本读取 JSONL、实际文件、Git porcelain 和持久化状态复核。三个 test 样本还逐项比较子 run_command 返回值与主上下文收到的 commandCalls：都是 3 次调用、2 成功/1 失败，退出码与顺序完全一致。Web 的审批、实际子 write_file 结果、后续停用快照和 Plan 无写入也另行读取 SSE 文件与检查点复核，不把模型最终回复单独当作验收。

关键运行：

- S1：`2964edce-d569-4cc9-928c-d123d5124472`。
- S2 三次父运行：`f2404f00-16e2-474e-a21f-3f641ffc2db5`、`fc3996c5-4fb0-4362-8cd7-3ac1d73fcb45`、`91265876-3ea6-4315-9213-621e6277d40a`。
- S6 三次父运行：`1626ed6d-c9e2-454f-8f33-9b9f22007c44`、`7df54be1-68a5-49bb-8554-8802491c04d1`、`a12bfec2-eb32-4ff4-b2f4-81f80f34393f`。
- W3 子运行：`6d83f632-7fe1-40c3-8054-9415ce7aa53f`，父运行 `e90955a1-5c75-44e9-b2a7-0d5e856ad2ea`。

## 失败、重试与保留观察

首次 Web 夹具在读取 SSE 前，无条件等待 `response.clone().text()` 作为断言消息。流中的工具需要审批才能继续，而夹具还未消费流，因此发生等待。确认属于本任务的 Next 进程后中止，夹具原始退出码 1，保留 socket terminated 错误和未完成会话。修正为仅 HTTP 非成功时读取错误正文，并在新隔离目录运行 W1—W4，脚本退出 0。未修改生产 SSE 或审批实现，也没有将这次中止记为成功。

所有场景的分母和有效执行单列：16 个成功验收的功能场景、1 次额外夹具中止；20 轮有效父执行、1 次额外未完成父执行。不能把结果描述成“全部 21 次执行均成功”。

三个 test 场景各有一次预设命令失败，是被测试的行为；此外 S6-1 中 report_completion 参数出现两次 invalid-arguments，模型纠正后被接受。这不影响实际三次命令结果，但说明参数生成仍有可恢复重试，本轮没有声称工具调用零错误。

自然语言也保留解释边界：S6-3 的回复包含“未使用真实模型或凭据”。被运行的 npm 检查脚本确实不调用模型，但整个 OrbitCode 评测使用了真实模型，因此不能将这句模型文本用作“评测未调用模型”的证据。实际连接条件以配置与运行记录为准。W4 正确拒绝写入后还生成了较长的规划模板；这不是功能失败，也没有据此擅自修改提示行为。

## 用量、后台任务与清理

去重保存了 30 条 Agent 运行记录，其中 10 条独立子运行。29 条上报 usage：prompt 270,901、completion 10,526、total **281,427 tokens**。另外 1 条缺失 usage，不按零计算；首次中止的请求和后台记忆提取未完整纳入上述 Agent 用量，因此不是账单总量。

沿用默认记忆配置，没有为了评测关闭后台任务。现场可见 18 个 job：15 abandoned、3 saved；三个 saved 均返回“没有适合长期保存的笔记”，noteIds 为空。没有生成记忆笔记，不将本轮解释成记忆功能对照实验。

凭据扫描检查 250 个评测文件，排除 Git 二进制元数据，未发现实际模型凭据原值。后续归档脚本只含变量引用。所有 CLI 子进程已退出，两个 Next 现场端口 64020、64092 均无监听，本任务驱动进程无残留；没有结束用户其他服务。脚本原文已归档为 `.mts.txt`，避免临时脚本和产物污染项目 lint/typecheck。

## 原始证据与验证限制

本机未入库证据根：`tmp/agent-evals/skills-current-real-20261017/`。

- [CLI 原始报告](../../tmp/agent-evals/skills-current-real-20261017/report.json)、[CLI 独立复核](../../tmp/agent-evals/skills-current-real-20261017/independent-review.json)。
- [Web 报告](../../tmp/agent-evals/skills-current-real-20261017/web-final/report.json)、[最终合并复核与清理](../../tmp/agent-evals/skills-current-real-20261017/final-review.json)。
- CLI 的 `driver.stdout.txt`、`driver.stderr.txt`；每场景的提示、JSONL、stderr、会话和实际工作区。Web 的 `web.stderr.txt` 保留首次失败，`web-final/` 保留最终 SSE 事件和服务器输出。
- `driver.mts.txt`、`review.mts.txt`、`web.mts.txt`、`final-review.mts.txt` 保存评测脚本原文。主 CLI 脚本及两个复核脚本退出 0；最终 Web 脚本退出 0，首次 Web 夹具退出 1。

本轮没有修改功能源码、内置样板、权限或依赖，未重新运行已通过的 581 项确定性测试。既有完整检查证据见 [深度补测报告](skills-acceptance-2026-10-17.md)。没有提交或推送 OrbitCode 仓库；S7 的提交仅发生在明确授权的临时测试仓库。

本轮是单一配置模型、有限任务和次数下的功能验证。Web 新证据为真实 HTTP/SSE 与真实模型闭环，没有新增真实模型浏览器点击验收；浏览器交互证据仍见前序报告。不会由 16/16 推断一般成功率，也不覆盖全部网络故障、并发时序和任意 Skill。前次 [原始失败分布](skills-real-model-2026-10-16.md) 与 [修复复测](skills-fixes-2026-10-16.md) 继续保留，不与本轮合并成一个成功率。
