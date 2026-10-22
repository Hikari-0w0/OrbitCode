# 子 Agent 源码探索故障修复与复测（2026-10-20）

本轮由用户授权“修复问题，并继续进行这样的测试”。基线是北京时间14:09—14:10的真实Web运行327a7e7d-41c1-4898-bc40-ae5f7a19d08b：explorer子执行ec961cbd-9dd9-4cba-ad80-955aa93ae52d达到16轮上限，37次工具调用中28成功、7次search_code边界失败、2次上限取消，最终回复为空。历史失败没有足够原参数，不能把“文件当目录”当成已证实的历史根因。

**运行时缺陷已修复并回归：现行686项测试通过，lint/typecheck/build依次退出0。真实模型22个有效场景16通过/6失败；另保留1次启动失败、1次无效验收夹具。父级重复探索仍未完全解决，不宣称全部通过。**

## 实施内容

1. search_code.path明确只接受目录，file_pattern相对Workspace根匹配；文件当目录、目录当文件改为可恢复invalid-arguments并给出纠正方式，缺失目标仍not-found，真实越界/非法路径和保护路径继续拒绝。增加固定targetFailureReason原因码，不落盘原始异常文本、查询词或调用参数。
2. ChildHandoff从实际成功工具结果收集最多16个read_file路径、16个search_code命中位置（path/line/callId；路径最多512 UTF-8字节）。去重、长度/数量省略可见；不复制源码或命中正文，不把模型文本推断成实际读取。超长投递压缩为各4条，省略数保留。异常停止不再只交回空回复和错误类别；即使finalReply为空，读取定位事实仍可用。
3. 子请求最后3轮在末尾附运行时预算提示，纳入ContextManager估算与压缩预算，不持久化进历史；保留前面的角色/父历史请求前缀。工具不隐藏、不增加请求预算、不延长截止；若模型最后一轮仍请求工具，沿用原取消与max-iterations语义。
4. 子失败新增callId、iteration、固定目标原因，原生日志同样保存iteration/targetFailureReason；旧日志和旧交接可缺字段。日志不保存完整子快照或原参数，仍不能复原任意查询；这是有界诊断，而非完整持久化子会话。
5. 主提示明确尊重用户禁止父读取、修改或代做的分工。实测仍有违规重复读取，不能把Prompt当成硬执行策略。尝试再加一段重复提示后2例仍1失败，已撤去重复段落，未继续堆提示或恢复report_completion。
6. 新增可复用源码评测脚本，Web夹具可选择独立生产服务模式，避免与用户dev服务竞争锁。评测副本放在已忽略tmp/内后，发现TypeScript/ESLint也扫描副本，因此排除tmp/；src、tests、scripts仍检查，未放宽产品类型约束或安全限制。

## 验收方法与边界

使用现有deepseek-flash/OpenAI兼容Provider，凭据只在进程环境中使用。每例新会话、隔离数据和源码副本；复制当前src、README、package及明确测试角色，不复制真实配置、node_modules、.next、tmp或先前日志。模型面对真实项目源码复杂度，但不是原工作区全部文件初态；初始历史缺少源码哈希，不作严格性能A/B或通用加速比例推断。

原始defined请求直接复用用户测试文案；另覆盖Fork、首次故意文件当目录后恢复、4轮预算。父不能代做，断言依原生日志检查父是否搜索/读取；子必须真实读到主循环和runtime调用方，确认来源存在、已读源码未修改，正常场景要求final-response和有来源的回复；4轮场景允许有事实交接的max-iterations。错误恢复要求实际not-directory及原生日志对应原因。没有因为父违约而降低验收标准。

工具成功read_file只说明工具读取了文件，不表示卸载正文已被模型完整消费。自动断言覆盖入口与调用方路径、读取/定位事实、角色边界和终止，不等于完整架构语义认证。人工抽查确认主入口AgentLoop.streamTurn及createAgentSession/runAgentTurn调用方向正确，但部分回答猜测行号（如一例声称streamTurn在140行，固定副本实际120行），tmux子任务也明确未逐行核实整个循环体。精确行号、全部异常分支解释和任意源码分析质量仍不能称全部验收通过。

## 完整分布

| 批次（tmp/agent-evals下） | 有效场景 | 通过/失败 | 说明 |
| --- | ---: | --- | --- |
| explorer-recovery-20261020 | 8 | 5/3 | 3例均有父重复探索，其中recovery-1子也达到16轮上限；所有子保留读取事实 |
| explorer-recovery-final-20261020 | 8 | 7/1 | 原defined、Fork和错误恢复各2例通过；4轮第1例父重复探索 |
| explorer-parent-summary-20261020 | 2 | 1/1 | 冗余提示试验，无稳定收益，不保留重复提示 |
| explorer-recovery-web-recheck-20261020 | 1 | 0/1 | 子正常完成，但父重复探索 |
| explorer-recovery-web-closeout-20261020 | 2 | 2/0 | 最终独立生产服务HTTP/SSE原任务，两例通过 |
| explorer-recovery-terminal-20261020 | 1 | 1/0 | tmux真实输入，父4轮、子14轮；父agent漏operation后正常纠正 |
| 合计 | 22 | 16/6 | 有限混合批次，不是产品一般成功率 |

另有两次独立保留的异常：

- explorer-recovery-web-20261020：已有用户dev服务锁，隔离dev夹具启动失败，未发模型请求；未关闭用户服务，改用start生产模式。
- explorer-recovery-web-final-20261020：实际Web/子模型完成，但评测器只允许源码文件，错误拒绝夹具生成的AGENTS.md引用。修正为显式允许夹具指令文件、并实际读取/核对源码内容后重测。保留为无效验收夹具，不擅自改写原failed结果，也不算产品通过。

所有原始行如下：

| 批次 | 样本 | 原状态 | 错误 |
| --- | --- | --- | --- |
| recovery-20261020 | cli-defined-1 | 通过 | — |
| recovery-20261020 | cli-fork-1 | 通过 | — |
| recovery-20261020 | cli-recovery-1 | 失败 | 父未代做探索 |
| recovery-20261020 | cli-budget-1 | 失败 | 父未代做探索 |
| recovery-20261020 | cli-defined-2 | 通过 | — |
| recovery-20261020 | cli-fork-2 | 通过 | — |
| recovery-20261020 | cli-recovery-2 | 失败 | 父未代做探索 |
| recovery-20261020 | cli-budget-2 | 通过 | — |
| recovery-final-20261020 | cli-defined-1 | 通过 | — |
| recovery-final-20261020 | cli-fork-1 | 通过 | — |
| recovery-final-20261020 | cli-recovery-1 | 通过 | — |
| recovery-final-20261020 | cli-budget-1 | 失败 | 父未代做探索 |
| recovery-final-20261020 | cli-defined-2 | 通过 | — |
| recovery-final-20261020 | cli-fork-2 | 通过 | — |
| recovery-final-20261020 | cli-recovery-2 | 通过 | — |
| recovery-final-20261020 | cli-budget-2 | 通过 | — |
| parent-summary-20261020 | cli-budget-1 | 失败 | 父未代做探索 |
| parent-summary-20261020 | cli-budget-2 | 通过 | — |
| recovery-web-20261020 | web-defined-1 | 失败 | 评测Web启动失败。 |
| recovery-web-final-20261020 | web-defined-1 | 失败 | 引用存在于固定源码副本 |
| recovery-web-recheck-20261020 | web-defined-1 | 失败 | 父未代做探索 |
| recovery-web-closeout-20261020 | web-defined-1 | 通过 | — |
| recovery-web-closeout-20261020 | web-defined-2 | 通过 | — |
| recovery-terminal-20261020 | tmux-defined | 通过 | — |

46条原生日志runId无重复，覆盖23个实际模型场景（含1个无效验收夹具），子终态22个final-response、1个max-iterations。有效场景中21/22子正常结束，另1个上限停止也有读取事实；不能用这个数字替代整体验收。所有记录report_completion调用0。

scope=self的主、子和各用途统计共309次Provider调用，309次报告usage、0次失败请求用量；输入4,938,435、输出93,150、总计5,031,585 tokens，包含开发/失败/夹具样本。不是纯最终版本成本，也不等于底层HTTP尝试数或未缓存计费量。父子按自身范围相加，不叠加父聚合统计。完整本地数据见[汇总](../../tmp/agent-evals/explorer-recovery-closeout-20261020/summary.json)。

## 工程验证与清理

686项自动测试通过，0失败/跳过。新增/增强目标类型错误、越界符号链接、只读事实有界去重、长路径省略、投递裁剪、日志兼容和原因保存；真实AgentLoop的4轮强制上限场景证明工具仍暴露、无额外模型请求，并保留读取定位和取消事实。ContextManager测试确认末尾提示保持原前缀、参与token预算且不写入会话。

lint、typecheck、build顺序退出0；git diff --check通过。开发阶段发现并修正过测试语法、日志构建遗漏新增字段、旧断言期待日志无iteration、通用路径描述断言、tmp副本参与检查及评测脚本类型推断问题；未通过减少安全测试或放宽窗口预算修复。最终输出保存在本地closeout目录tests/lint/typecheck/build.txt。

精确扫描本轮全部指定证据根，当前Provider凭据零匹配；这不是任意秘密扫描。源码哈希、端口和PID释放见同目录source-hashes.json、credential-scan.json和summary.json。5个隔离Web进程/端口已释放，tmux正常退出0、缓冲清理；保留现有用户开发服务。原始对话、配置、源码副本和终端记录均忽略不入库，未新增依赖、提交、推送或创建PR。

## 后续重点

原故障的错误反馈、预算提示、只读事实交接及诊断链已落地。剩余主要问题是父模型有时仍把汇总变成重新探索；继续追加提示未证明有效，不应仅增加轮数或恢复模型自报门禁。若要保证严格只委派，需要可明确表达的父级执行策略，同时保留正常并行工作、接管与集成验收能力；本轮没有把所有父级读工具一律禁用。另需继续检查引用行号和解释完整性，不能只看stopReason或入口字符串断言。

## 复现入口

```bash
npx tsx --tsconfig tsconfig.json scripts/run-explorer-real-evals.ts \
  --root=tmp/agent-evals/explorer-<新目录> --repeat=2 \
  --allow-real-model --provider=<现有Provider名>

# 先构建，再用独立生产服务；不占用现有dev锁
npm run build
npx tsx --tsconfig tsconfig.json scripts/run-explorer-real-evals.ts \
  --root=tmp/agent-evals/explorer-web-<新目录> --transport=web \
  --cases=defined --repeat=2 --allow-real-model --provider=<现有Provider名>
```

目录拒绝覆盖；全部失败保留，失败退出1。Web本入口只支持defined；不要在Web评测运行时重建其生产包。
