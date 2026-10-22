# 子 Agent 委派验收记录

日期：2026-10-19。规格基线：[已批准规格](../specs/sub-agents/spec.md)、[技术计划](../specs/sub-agents/plan.md)、[实施任务](../specs/sub-agents/task.md)、[逐项验收](../specs/sub-agents/checklist.md)。

## 实施范围

已接入统一 `agent` 工具、三层角色定义、定义式空历史、Fork 完整消息组与 Skill 快照、独立子会话和权限、运行时后台管理、共享写入协调、结果队列/去重回执、父子用量、Web 面板及 CLI 控制。共享子执行沿用 AgentLoop、createAgentSession、原独立 Skill 的历史迁移和结果汇总适配；没有新运行时依赖。

创建立即返回任务 ID，前台等待与后台执行分离；Fork 固定后台。父正常结束后任务继续，运行时关闭取消任务，不跨重启恢复。结果有停止原因、模型文本、失败、副作用、清理和验证状态；最终回复不代表独立验收通过。操作和角色格式见 [README](../../README.md#子-agent-与后台任务)。

## 证据范围

本轮全部模型请求使用 loopback OpenAI 兼容替身，MCP 使用本地替身；文件与进程检查在临时 Workspace 和隔离数据目录执行。没有调用真实模型或使用真实凭据，不能据此声称实际模型委派质量、缓存收益、真实服务兼容矩阵或生产环境稳定性。

脱敏本地证据位于未入库的 `tmp/agent-evals/sub-agents-20261019/`。日志、浏览器快照和临时配置不加入提交。最终清单为 44/44 通过；完整测试数字和退出状态以 checklist 的 Q1—Q5 实际记录为准。

| 证据 | 方法与观察 | 本地文件 / 可重跑入口 |
| --- | --- | --- |
| 定义式 / Fork 闭环 | 实际 HTTP、主/子 AgentLoop、真实 read_file；定义式无父标记，Fork 有父当轮已完成工具交换，排除当前委派组；父结束不取消子；下一轮只投递一次 | `tests/sub-agents-runtime.e2e.test.ts` |
| Fork 排队快照 | 用两个独立执行占满共享池；父停用 Skill 后释放槽位，子请求仍携带接纳时的激活指令 | 同上 |
| 重量压缩 | 出站请求保持角色指令，历史摘要存在；摘要与普通请求分别计量 | `src/runtime/child-execution/session-factory.test.ts` |
| MCP 独立寿命 | 父轮次清理后子自己的租约继续调用 MCP，连接只初始化一次 | `tests/sub-agents-mcp.e2e.test.ts` |
| 保存重试 | 注入第一次保存失败；retry-save 后仅一份 child-result 和回执，无子模型重跑；另注入保存成功后的 ack 失败 | `tests/sub-agents-persistence.e2e.test.ts`、`src/runtime/child-result-delivery.test.ts` |
| 权限 | 后台 ask 拒绝；前台批准只属于该子一次；转后台撤销待审批；父切 Plan/收紧后 revalidate 拒绝；扩大权限不能越过快照 | `src/runtime/child-permissions.test.ts` |
| 生命周期 | 排队取消/到期不启动，等待/转后台不重跑不续期，清理失败保留事实，关闭竞争不启动迟到执行；退休调用拒绝重放 | `src/runtime/background-task-manager.test.ts` |
| 写入与长进程 | 四个独立调度器共享许可时写入无重叠、读可并发；排队取消不执行；受管进程退出才释放许可，status/stop 可用 | `src/core/tool-scheduler.test.ts`、`src/tools/managed-process.test.ts` |
| Web / CLI 接口 | 作用域、外域拒绝、严格参数、wait 期间 detach/cancel 控制可用 | `tests/sub-agents-web.e2e.test.ts`、`tests/sub-agents-cli.e2e.test.ts`、接口单测 |
| 用量与缓存 | tokens、status hit/miss、unavailable、无 usage 分开计数；摘要失败保留，兄弟按 ID 去重，父 self 不混入子用量 | `src/runtime/sub-agent-usage.test.ts` |
| 真实浏览器 | agent-browser 独立会话，角色与任务、审批转后台、Fork 等待/取消、切换会话、非法预算、控制台 | `browser-closeout-*.txt`、`browser-closeout-tasks.json` |
| 真实 tmux | 主请求→委派→本地执行→最终回复；工具失败、无效参数、真实命令超时、最大轮次 | `tmux-initial.txt`、`tmux-final.txt` |
| 单次 CLI | tmux 中 run-once JSON 退出 0，父完成，未完成子取消、terminationSource=runtime-close、cleanup=complete、verification=unverified | `run-once.txt`；父 runId `d97b8812-c514-4b88-b765-9711488e99cc` |

## 浏览器补测

使用 `/tmp/orbitcode-subagents-20261019-c` 的隔离配置，Web 端口 3109，本地替身端口 57503。主会话 `a887f7f1-cce8-49c4-94f0-6493b4d4a114`：

- 定义式 `480003fa-2b01-488e-9c34-c2d983fad4a1`：实际读文件，terminal/final-response/unverified，下一主轮次由 pending 变为 committed。
- 前台写入 `5d0610e3-a6f3-43ed-80c0-f4884b3a429f`：出现携带 taskId 的审批，点击转后台后审批消失，写入被拒绝，文件不存在。
- 第二次前台写入 `f0676060-a006-44f2-9ac6-05471a3b16cc`：保存审批 requestId 后点击转后台，再向实际 decide 接口提交同一批准，返回 400；`child-output.txt` 仍不存在。该预期 HTTP 400 已保留在接口记录；浏览器 errors 为空，console 仅有 DevTools/HMR 信息。
- 首个 Fork 慢任务在取消前已完成（`browser-closeout-tasks.json` 中为 final-response，不能算取消通过）。随后用“Fork 慢任务 最大轮次”保持执行：任务 `c6ccbc17-bdca-4065-b5ca-d5c8ddb7d021` 点击等待、转后台和取消后为 terminal/cancelled/unverified，证据 `browser-closeout-cancel-running.json`；从创建即后台。
- 新建另一个会话，任务面板为空，不显示原会话任务。预算“每轮子任务数量”填 0 时浏览器约束拒绝提交，恢复为 4；未更改实际配置。

先前 a/b 两组夹具调试还保留了初始快照和终端输出；初始共享测试数据产生过 revision 409，随后已改用新隔离目录。开发热更新曾重建运行时、清空内存任务；这符合运行时关闭边界，不能当作后台恢复成功。最终补测不在操作中修改代码。

## 可重复执行

```bash
npm test -- tests/sub-agents-runtime.e2e.test.ts tests/sub-agents-web.e2e.test.ts tests/sub-agents-cli.e2e.test.ts tests/sub-agents-mcp.e2e.test.ts tests/sub-agents-persistence.e2e.test.ts
npx tsx --tsconfig tsconfig.json scripts/run-sub-agent-fixture.ts --root /tmp/orbitcode-subagents-new-run
```

第二条必须指定新的隔离目录；脚本拒绝覆盖已有配置，输出本地 URL、Web/CLI 启动命令。用 agent-browser 的独立命名会话访问该 Web，按输出提示输入定义式、Fork、审批写入、工具失败、无效参数、命令超时或最大轮次任务。tmux 使用同样的 CLI 命令；不同同时运行的前端应使用不同数据目录，避免相互修改同一测试会话。结束后关闭本次浏览器、CLI、开发服务器和替身。

## 验收限制

逐项 checklist 的有限场景已补齐，不能把全量测试通过解释为任意故障组合或真实模型任务均能通过。新增 boundaries e2e 覆盖同批 Fork 的稳定完整请求、角色更新、流式和未配对批次期间完成、忙碌/旧 revision 清空与失败恢复；delegation 故障注入覆盖启动各阶段、父上下文释放后读取子引用，并保留失败证据。

运行时任务活动有界保留创建、启动、等待、转后台、停止、投递等事件，并在结果消费时进入会话；父结束日志保持不变，子运行日志通过 parentRunId/parentCallId 关联。启动前失败可能没有完整子运行日志，evidenceLog=unavailable；执行日志写入失败时 evidenceLog=failed。不声称存在完整的持久化生命周期审计流。聚合用量限于当前运行时保留记录，退休记录不包含在实时聚合中。

工作区写入协调只覆盖本运行时受管工具，对其他进程、外部编辑器及服务自身行为不提供全局隔离。没有 Worktree 或自动回滚。运行时关闭后未保存结果可能丢失，重启不会恢复后台执行。


## tmux 收尾与最终检查

补测任务 `13956b18-b4b6-406b-8296-5423d4e18703`：`/agents`、`/tasks`、`/task wait` 后 Ctrl+C，等待返回 reason=cancelled，但 show 仍为 running，原截止不变；随后 background/cancel 才使子任务 terminal/cancelled，terminationSource=user。证据为 `tmux-ctrlc-*.txt`。

退出任务 `0d250637-6d2b-43fc-a236-9693924331c6` 在 `/exit` 时仍在执行，子日志 stopReason=cancelled，保留 parentRunId/parentCallId（`tmux-exit-result.json`）。重启相同数据目录并 `/resume 91f2d542-1532-48f3-8e15-2be4c9ac2bf3` 后 `/tasks` 为空（`tmux-restart-same-conversation.txt`），没有恢复旧子任务。

最终门禁按 `npm test` → `npm run lint` → `npm run typecheck` → `npm run build` 执行，四条命令均退出 0；测试为 687 通过、0 失败、0 跳过。`git diff --check` 退出 0，package.json/package-lock.json 无改动，新增文件清单无日志、截图、环境文件或临时配置。浏览器已关闭，本次 tmux 会话不存在；端口 3109、57503、50322、51325 已释放，见 `cleanup-final.json`。


最后一轮补测新增 `tests/sub-agents-boundaries.e2e.test.ts` 与 `src/runtime/agents/delegation.test.ts`。修复包括：每次创建重新读取角色且冻结已接纳快照；同创建调用先命中原任务，避免角色后来失效破坏幂等；日志写入失败在子结果中显式标记。全量回归已纳入这些测试，不沿用补测前的测试数字。


后续用户授权真实模型测试后，执行了跨午夜的38个样本，完整分布与修复见 [2026-10-20 真实模型验收](sub-agents-real-model-2026-10-20.md)。本文44项结论仍指本地替身和有限边界验证，不扩展为真实模型全部通过。
