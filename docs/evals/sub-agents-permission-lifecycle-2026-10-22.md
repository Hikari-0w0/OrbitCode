# 子 Agent 默认权限与审批生命周期改善（2026-10-22）

> 历史阶段记录：本文审批交互方案随后被用户要求移除，由[全运行时移除人工审批](approval-removal-2026-10-22.md)替代。旧脚本run-sub-agent-permission-real-evals.ts已退役；原始证据保留，当前行为以新记录为准。

## 问题与结果

用户实际Web验收暴露了此前矩阵遗漏的配置组合：内置general使用default权限，写入与命令需审批；默认30秒自动转后台却撤销审批，后续操作又因后台禁止审批而被拒绝。购物车任务最终由父接管，不能算子开发成功；后台取消样本没有启动命令，不能算运行中取消通过。原始诊断见本地忽略目录 `tmp/agent-evals/subagent-permission-diagnosis-20261022.md`。

本次将审批所有权留在任务，前后台仅控制父等待和投递。保留角色/父权限交集、显式deny、Plan、路径边界与执行前复检，不把内置角色改成permissive，不继承父或兄弟的单次授权。非交互执行仍拒绝需要审批的操作。

## 实现

- `BackgroundTaskManager`删除执行器的detach回调；准备阶段、等待超时、手动转后台不再操作权限。取消和关闭继续通过任务停止信号结束执行并清理权限资源。
- `createChildPermissions`不接收background：有交互入口即可请求单次审批；请求由原PermissionSessionManager及PermissionGateway处理，决定、TTL、停止或关闭结束等待。批准恢复原工具授权流程，不重建任务或重新请求模型。
- 审批管理入口检查任务scope、当前requestId及stopping/terminal，拒绝错误归属、重复和迟到决定；停止中的任务不再展示可操作审批。
- Web入口显示待审批数量，面板明确后台审批、过期时间及原截止时间；CLI复用 `/task approve <task-id> <request-id> once|deny`。模型status/wait提供有界的awaitingApproval事实，并提示父交回用户控制权，不绕过审批接管工作区。
- 审批是与执行阶段正交的实时prompt，不另增互相冲突的TaskState；任务原始deadline和并发/工作区租约约束保持。等待审批期间仍可能占有工作区独占许可，其他写任务排队，不提供文件回滚或跨进程隔离。

## 自动验证

先加入内置general、父default、角色default的真实Runtime端到端测试：自动后台、显式后台、手动后台、wait超时四项在旧实现下4/4失败，原因分别为审批取消或后台无法产生审批。修改后四项均通过，两端决定入口可继续原工具流程，父结束后仍可批准；文件在批准前不存在，批准后写入并执行真实本地命令。

同时覆盖拒绝、取消、运行时关闭、非交互拒绝，错会话/请求ID/重复/迟到批准，待审批时新增deny或进入Plan后的执行前复检，以及原始deadline取消等待。

- 全量最终 **802/802通过**，0失败/取消/跳过。
- 首次全量 **801/802**，新增deadline测试在计时后动态加载较重测试模块，审批观察窗口被模块加载耗尽。将模块加载移到计时前，保留真实截止与取消断言，完整重跑通过；首次输出未覆盖。
- lint、typecheck、build通过。生产构建仍有9条已有的动态文件跟踪警告，不归为零警告。

自动测试的模型协议使用本地替身；文件、命令、审批、HTTP控制适配与共享Runtime真实执行。它们不等于真实模型验收。

## 真实模型与浏览器

使用项目配置 `deepseek-flash`、独立Workspace和数据目录，未修改用户配置、既有会话或原有3000端口服务。脚本与浏览器服务在独立tmux会话中运行。

| 场景 | 结果与独立依据 |
| --- | --- |
| 默认前台审批跨30秒自动后台 | 通过；首次决定在接纳后35030毫秒；同一任务general/default/default；实际写cart.mjs和测试文件、执行测试；额外独立运行Node断言及测试退出0，父工具只有agent |
| 显式后台general开发 | 通过；文件与命令分别审批；子完成，独立购物车断言和node:test退出0，父无接管 |
| 后台用户拒绝 | 通过；实际user-denied，无blocked.txt，子如实停止 |
| 后台等待审批时取消 | 通过；终态cancelled、清理complete，无blocked.txt；本项验证审批等待取消，不冒充进程运行中取消 |
| 开发服务器实际浏览器 | 通过；内置general/default/default；入口显示1个待审批；面板手动转后台后仍可批准同一次写入，随后独立批准命令；ui-approved.txt标记精确一致，命令exitCode0，failureCount0，正文可读取；页面errors为空，console仅React DevTools/HMR信息 |

这5个调用真实模型的样本全部通过。另保留1次浏览器夹具准备失败：复制不存在的public目录，在加载模型配置及调用模型之前退出。新目录中修正夹具后完成浏览器样本；按全部尝试计，原始分布为5通过/1准备失败。

浏览器操作另保留两项编排偏差：CLI的find不支持select，故父级UI实际保持“协作与接管”，未宣称选择了“仅委派汇总”；原生父日志确认仅调用agent。一次等待选择器匹配到页面其他article导致超时，随后任务面板快照确认后台及审批仍在，继续完成同一样本。这些不当作运行时权限失败，也不隐藏。

浏览器服务使用隔离源码副本的next dev，避免与用户的开发锁冲突；四项HTTP/SSE场景使用生产构建。均未采用宽松general或预先允许写入规则。

## 复现与证据

```bash
node --import tsx --test tests/sub-agents-permissions.e2e.test.ts src/runtime/child-permissions.test.ts src/runtime/background-task-manager.test.ts
node --import tsx scripts/run-sub-agent-permission-real-evals.ts --allow-real-model --root=tmp/agent-evals/permission-real-new
```

真实模型命令需要可用的项目模型配置及当前生产构建，root必须是新目录；可用 `--cases=delayed,background,deny,cancel` 缩小矩阵。自动决定逻辑仅在显式授权的隔离评测脚本里，不属于产品自动批准机制。

本地忽略证据根目录：`tmp/agent-evals/subagent-permission-20261022/`。包含real/results.json、每样本tasks/decisions/独立验收及原生日志，浏览器快照/控制台，失败的准备样本，以及cleanup-verification.json。此前4项失败基线和首次全量失败分别保留在 `tmp/agent-evals/permission-before-20261022.txt`、`permission-tests-20261022.txt`；最终全量为 `permission-tests-final-20261022.txt`。

5个自有Web服务的PID均退出、端口均关闭，测试浏览器已关闭；没有停止用户原有服务。未增加运行时依赖，未提交、推送或部署。

这些证据覆盖已识别的默认权限审批故障；不能推广为所有模型、权限配置及自然语言任务均正确。后台审批不会延长原任务deadline；服务重启不能恢复运行中的任务。用户复测应重启服务后新建任务，旧任务闭包不保证自动切换到新实现。
