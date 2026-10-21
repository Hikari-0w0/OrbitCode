# 子 Agent 共享工作区协调与复测（2026-10-21）

## 结论与范围

用户要求“进行测试，然后继续改善”。基线完整回归721/721通过；继续落实[架构路线](../specs/sub-agents/architecture-roadmap.md)中任务级工作区所有权。最终733/733回归通过，lint/typecheck/build退出0，无新增依赖，无提交或推送，保留已有未提交变更。

原来的写许可仅覆盖单次工具调用，无法保护完整的读—推理—写回过程。同一运行时中，具备修改能力的子任务现在从模型循环开始前取得独占权，直到清理结束；只读子任务共享读许可。父文件工具、独立 Skill、MCP初始化与后台子任务使用相同协调器。

这完成了路线 D 的共享工作区协调部分。完整内部任务契约、上下文清单、组预算、Worktree和单 Agent质量/成本对照仍未完成。

## 设计与边界

- 访问模式根据接纳时父工具、角色允许/禁止列表与实际 ToolDescriptor.mutability 计算。命令、外部工具、缺失元数据保守独占；不能根据角色名或模型文字自称只读。新任务在 TaskView 和 agent start/status 中输出 workspaceAccess。
- WorkspaceExecutionCoordinator 采用公平读写队列，连续头部读者可并发，后来的读者不能越过排队写者。等待支持任务取消及既有 deadline；不同规范化工作区根互不阻塞。
- 使用 Node标准库 AsyncLocalStorage 传递私有任务所有权，使同一任务中的工具和MCP初始化复用许可。只读不能升级写入，不能跨根沿用所有权；任务结束后失效，迟到异步回调拒绝访问。
- 父文件工具取得单次读/写许可。agent控制、进程状态和停止不持锁等待；load_skill只在定义读取时持读许可，启动独立循环前释放，独立Skill的整个执行和清理再取得任务许可，避免父子自己等待自己。
- 许可持续至子会话/受管进程、权限、MCP租约与临时上下文清理结束。清理失败无法确认资源停止时，该协调器拒绝该根的新许可；其他根与控制操作仍可用。已经观察到的任务结果保留，后续文件工具返回明确 conflict，任务交接也保留结构化冲突原因。正常取消等待许可不追加执行失败。
- 这是当前运行时内协作工具的所有权协议，不是文件系统事务或权限沙箱。不能隔离用户编辑、另一运行时、绕过工具的外部进程或MCP服务端行为。父整个多轮推理不是事务，子任务启动前读到的旧内容仍需重新读取并复验；不保证模型在新文件内容上一定推理正确。
- 无角色Fork通常继承命令能力，按独占处理。共享目录写任务的吞吐会下降；长时间持有写许可的受管进程也会阻塞文件访问，仍可通过进程状态/停止操作控制。本次未测量相对单Agent的性能收益。

核心改动在 `runtime/workspace-execution-coordinator.ts`、`runtime/child-execution/workspace-policy.ts`、`core/tool-scheduler.ts`、`runtime/agents/delegation.ts`、`runtime/agent-runtime.ts` 与 `runtime/skills/isolated-runner.ts`；复用既有任务管理器与生命周期，没有建立第二个调度平台。

## 确定性证据

| 项目 | 结果 |
| --- | --- |
| 开始前完整回归 | 721/721，退出0 |
| 新功能首轮完整回归 | 726/726，随后补充端到端及异常断言 |
| 最终完整回归 | 733/733，退出0；比基线新增12项 |
| 最后拒绝/取消路径定向回归 | 20/20，退出0 |
| lint、typecheck、build | 最终均退出0；build仍有9条动态路径文件跟踪范围过宽警告 |
| git diff --check | 退出0 |

新增覆盖：

1. 实际 Runtime/Provider替身/AgentLoop/文件工具的两个写子任务分别观察0、1，最终文件2；父读取等待最终版本，同时能够调用 agent status。
2. 两个只读子循环同时进入模型请求；写能力、未知元数据、角色禁止列表与父级限制的交集正确影响访问模式。
3. 等待工作区独占权时取消不请求子模型，ID可查询、cleanup完整，不产生额外执行失败。
4. 同任务工具重入不死锁；只读升级、跨根访问、任务结束后的异步回调拒绝。
5. 清理失败保留任务产物，后续同根操作返回冲突，其他根继续工作。
6. 20个固定种子×40次任务申请，混合读写、取消和三个工作区：没有读写重叠、丢失递增、重复清理或许可泄漏。这里是800次申请，不是800个真实模型任务。

`transaction-reproduction.json`另外保存受控对比：只在单次读/写时加锁，两个递增最终为1；任务级持锁最终为2。它使用当前协调器模拟两种调用模式，不冒充旧构建的端到端测试。

一次中间typecheck发现工具元数据Map键类型和JSON可选字段的undefined问题，已以明确字符串键及null表示未知修正；没有添加类型断言绕过检查。原来“读与写应重叠”的调度断言随新契约改为“同根读写不重叠”，原有只读并发测试继续保留。

## 真实模型完整分布

使用项目当前deepseek-flash配置，在独立Workspace与数据目录中运行真实SessionController、Provider、AgentLoop、文件工具和沙箱。评测在tmux中启动；不是人工键入CLI交互，也没有重新进行真实浏览器检查。本轮没有页面组件改动。

| 批次 | 样本 | 原始结果 |
| --- | --- | --- |
| real | counter-1、readers-1、counter-2、readers-2 | 3通过、1不通过 |
| real-recheck | counter-1、readers-1 | 2通过 |
| lifecycle | 显式取消、运行时关闭 | 2通过 |
| 总计 | 8个样本 | 原始7通过、1不通过；下述评测误判单独解释，不改写历史 |

counter场景由父模型仅委派两个defined builder，子任务实际read_file读取count.txt并write_file递增一次。父没有本地工具接管。三个计数样本的独立沙箱断言均确认最终值2，子执行区间均不重叠，交接保留实际读写事实。

readers场景由两个defined reader读取evidence.txt并原样返回标记。三组子执行区间都相交，确定性测试还观察到两个模型请求同时在途。这不证明厂商服务端处理必然并行，也不是性能A/B。

### 保留的评测误判

`real/readers-2-bjBvlC`的两个任务均正常结束并返回正确标记，未观察到写入或文件改变，但一名子Agent再次读取文件，总read_file调用数为3。初版评测器要求全场景“恰好2次读取”，因此输出3≠2。

只读任务并未禁止复读，该固定次数断言不符合工作区隔离和正确产物的验收目标。`oracle-review.json`保留七项只读复核：任务数、正常结束、标记、成功读取证据、无文件工具写入、计数文件及证据文件未变，全部成立。原始results.json仍为failed，没有转写为产品通过。

修正后的评测要求每个任务有真实读取事实、返回正确标记、只调用允许工具、没有写入且独立文件断言通过；计数任务仍严格要求总共两次写入以及最终值2。用新root重跑counter/readers均通过。不是放宽权限、写入次数或制品正确性。

### 生命周期复测

新任务级许可下，真实命令启动后分别取消任务和关闭运行时，均确认已知PID退出、计划的late.txt未创建、cleanup完整、停止来源分别为user/runtime-close，handoff仍保留cancelled=true。

真实样本之后仅补齐了拒绝路径中结构化conflict与正常取消诊断的交接；新增路径由最终自动回归覆盖，没有为此重复调用真实模型。

## 复现与产物

本轮原始证据在已忽略的 `tmp/agent-evals/subagent-workspace-20261021/`：

- baseline-tests.txt、tests-final.txt、denial-tests.txt：基线、最终完整回归和最后定向检查。
- lint-verified.txt、typecheck-verified.txt、build-verified.txt：最终工程门禁。
- real/、real-recheck/、lifecycle/：原始模型请求、事件、任务、检查点、工作区、独立验收和原始结果；每批.exit保留原退出码，首次real为1，复核和生命周期为0。
- summary.json：分批结果、最终源码哈希及当前配置密钥精确扫描。范围为本轮证据及src/scripts/docs，不含构建缓存、其他凭据或用户全部数据目录。

可维护脚本（root必须是新目录，其父目录须存在）：

```bash
npx tsx scripts/run-sub-agent-workspace-evals.ts --allow-real-model --repeat=2 --root=tmp/agent-evals/workspace-new
npx tsx scripts/run-sub-agent-lifecycle-evals.ts --allow-real-model --root=tmp/agent-evals/workspace-lifecycle-new
```

本轮评测进程均已退出，未停止用户服务。没有新增依赖或修改用户凭据。模型历史召回失败的既有证据仍有效，本轮没有重测全部历史场景或证明已解决语义质量问题。
