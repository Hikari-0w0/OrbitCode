# 子 Agent 生命周期内核收敛交付（2026-10-20）

## 本轮范围

用户在阅读[架构改善规划](../specs/sub-agents/architecture-roadmap.md)后要求开始改善。本轮交付路线 A—C 中的生命周期、资源所有权和结果交付基础，采用共享 Agent Loop、权限网关、上下文存储及会话回执；没有引入运行时依赖，也没有提交或推送。现有大量未提交变更继续保留。

本轮没有完成全部路线：内部任务输入/输出契约、上下文清单、共享目录任务级独占、组预算、Worktree 和质量/成本对照仍在后续阶段。当前命令级写入协调不能保证并行编码的逻辑一致性。

## 已实施的契约

1. **稳定接纳。** 输入校验与容量预留后的任务记录登记是接纳点，立即返回稳定 ID；任务显式经历 preparing、queued、running、stopping、terminal。准备失败也成为可查询的终态，不再删除已经可见的任务或自动重跑。
2. **统一执行所有权。** 准备和运行共用任务级取消信号与绝对 deadline；后台任务在接纳后不再受父请求信号控制。准备和执行分别计数并受并发上限控制。取消尚未取得准备名额的任务不会初始化资源。
3. **一次终结。** 任务管理器在异步清理前建立唯一终结 Promise，重复取消/关闭共享它；清理后发布一次终态、释放一次执行名额。清理先关闭子会话，再释放权限/租约，最后删除上下文目录；失败明确保留。终态释放准备与执行闭包，避免继续持有父上下文。
4. **明确去重。** key 包含会话、世代、父轮和调用 ID，匹配调用返回同一 ID；改变任务输入拒绝。已退休调用有最多1024轮的进程内防重放窗口，活跃轮次不被淘汰；不承诺跨进程或永久 exactly-once。
5. **快照与事实。** 接纳前固定 Fork 逻辑历史及 Skill 快照，引用复制在 preparing 阶段完成。ToolRegistry 使用首个停止原因规范化返回结果，保留已经观察到的 output/meta/sideEffect；未观察输出保持未知。停止来源和执行器输出中的 cancelled/timedOut 可以分别表达控制事件和执行观察。
6. **可重试投递。** staged 表示尚未持久确认，父检查点保存前中断后下一轮可重新领取；保存回执后不重复投递。压缩保留 terminationSource；失效结果不能被迟到 commit 激活，清空也不会追溯改写已经发布的执行终态。

主要源码为 `core/sub-agents/types.ts`、`runtime/background-task-manager.ts`、`runtime/task-transitions.ts`、`runtime/agents/delegation.ts`、`runtime/child-result-delivery.ts`、`tools/registry.ts` 和 `tools/tool-termination.ts`。Web/CLI 继续读取统一状态，无页面组件改动。

## 工程验证

| 检查 | 最终结果 |
| --- | --- |
| 完整 `npm test` | 721/721，通过，退出0 |
| `npm run lint` | 退出0 |
| `npm run typecheck` | 退出0 |
| `npm run build` | 退出0；仍有9条动态路径跟踪范围过宽警告 |
| `git diff --check` | 退出0 |

新增9项测试，并更新与新接纳语义冲突的旧断言。覆盖慢 Fork 复制期间真实 Runtime/HTTP handler 的查询/取消/后续查询均200、子请求0，重复调用一次准备、任务输入冲突、跨 scope 隔离、准备并发、准备超时/关闭、清理失败、父取消不撤销接纳任务、输出与副作用保留、首个停止原因、未保存结果重新投递以及终态不可追溯改写。

初轮定向测试暴露旧测试依赖“start 等 prepare 完成”“准备失败删除 ID”的语义，已改为核对新契约，同时新增原始竞态复现。中间 typecheck/build 因测试动态导入类型引用及收窄后的重复状态比较失败；修正后重新依次执行 lint、typecheck、build，以上为最终结果。没有放宽权限、超时或业务验收标准。

原始工程输出位于 `tmp/agent-evals/subagent-architecture-20261020/`。`tests-verified.txt` 为721项回归；`lint-verified.txt`、`typecheck-verified.txt`、`build-verified.txt` 为最终工程检查。初轮失败日志保留，不以覆盖失败产物伪装首次通过。

## 真实模型与独立观察

复用项目当前配置的 deepseek-flash，独立 Workspace/数据目录，真实 SessionController、Provider、Agent Loop、命令工具和本地沙箱。新增 `scripts/run-sub-agent-lifecycle-evals.ts`，显式要求 `--allow-real-model` 和新的 `--root`，由 tmux 启动执行。本次不是人工键入 CLI 的完整交互测试，也没有重新执行真实浏览器；Web 新证据为 Runtime/HTTP handler 集成测试。

任务由父模型创建一个 defined builder 后台任务，子模型执行实际命令：先写入启动标记及自身 PID，20秒后计划写入 late.txt。观察启动文件后分别取消任务和关闭运行时，独立核对已知进程、制品和结构化结果。

| 批次 | 显式取消 | 运行时关闭 | 代码边界 |
| --- | --- | --- | --- |
| lifecycle | 通过 | 通过 | 首轮生命周期改造后；后续仍有停止归因与终态不可变收敛 |
| lifecycle-final | 通过 | 通过 | 最终行为代码复测 |
| 合计 | 2/2 | 2/2 | 四个有限样本，不是通用成功率 |

四例都观察到：子命令已启动；操作完成后已知 PID 不存活；late.txt 不存在；任务 stopReason=cancelled、cleanup=complete；来源分别为 user/runtime-close；handoff 保留 exitCode=null、timedOut=false、cancelled=true。这修复了上一轮相同场景中字段丢失的失败，历史失败证据保持原样。

最终两条子任务 ID：

- cancel：`ad8073de-7077-4fcc-b6b4-39446841ce56`。
- runtime-close：`012b3405-1a6c-4bbe-b974-8dffa8b38fee`。

取消前 stdout/stderr、终止信号、截断标志和 applied 副作用的保留由确定性注册中心测试覆盖；真实命令样本主要核对取消字段及进程/制品，不夸大为覆盖所有输出情况。两个 tmux 评测进程都退出0，未操作用户已有服务。

复现命令（父目录须存在，root须是新目录）：

```bash
npx tsx scripts/run-sub-agent-lifecycle-evals.ts --allow-real-model --root=tmp/agent-evals/subagent-lifecycle-new
```

`summary.json` 保存分批结果、最终行为源码哈希和凭据扫描范围。当前配置密钥对本轮产物及 src/scripts/docs 的精确匹配为0；不包含对构建缓存或其他凭据的审计。未把密钥写入配置产物或终端记录。

## 剩余边界

- 任意工具在 deadline 后迟到返回的结果尚无统一追加持久化协议；未返回时保留未知，不据此宣称进程已停止。对于不响应取消的准备/执行，不能凭空保证立即清理或强制停止所有外部行为。
- 运行中任务仍只存在于当前进程，没有跨进程恢复。去重与一次终结的保证限定在当前运行时和保留窗口。
- 先前已观察到的模型历史召回/完整引用失败仍有效，本轮没有通过提示词或特例提取掩盖，也未重新运行全部36项历史真实评测。
- 完整任务契约、工作区任务级独占、组预算及单 Agent 对照是下一阶段架构交付内容，不能将本次721项通过解读为整个路线已经完成。
