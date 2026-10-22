# Agent 调优 PR 提交前验证

本次从 `main` 的 `16aa57d` 建立独立工作树和 `codex/agent-tuning-reliability` 分支，收集本轮 Agent 产品改动及评测文档。范围为检索剪枝/按行读取、交接范围事实、Web 共享轮询与低高度侧栏、托管 unlimited 配置、失败定位/验收覆盖及进度复核、构建动态路径追踪和测试配置隔离。

日志分析 CLI 是用户在测试 Agent 时生成的验收项目，本 PR 不包含 `src/cli.ts`、`src/log-analysis/`、`src/package.json` 及对应 package.json/tsconfig 修改。原目录保留这些文件；其 spawn 测试参数错误已做最小修复，原目录 typecheck 通过。没有提交用户记忆、全局设置、环境文件、原始对话、日志、截图或临时评测项目。

## 当前 PR 内容的最终检查

| 检查 | 结果 |
| --- | --- |
| 按原 package-lock 安装 | npm ci 成功，未添加或更新依赖 |
| 全量自动测试 | 804/804 通过，无跳过或取消 |
| lint → typecheck → build | 依次通过，构建无警告 |
| git diff --check | 通过 |
| 凭据扫描 | 暂存产品文件没有已配置密钥，未夹带本地配置和评测产物 |

## 本次重新执行的真实入口检查

使用配置中的 DeepSeek 官方 deepseek-flash，凭据仅在进程环境中传入；数据目录与 Workspace 独立，没有修改用户实际项目。

- tmux 交互 CLI：读取 actual.txt，写入 terminal-result.txt，独立比较完整字节相同，final-response、revision 1。
- 同一 CLI：设置 maxIterations=1 后请求写入，max-iterations、revision 2，独立确认目标文件未生成。
- 开发浏览器：真实读取 evidence.txt、写入 pr-browser-result.txt 并复读，独立比较完整内容相同，页面显示保存成功。任务面板展示内置 explorer/general/reviewer，空任务计数正确，页面错误列表和控制台无错误。
- 设置页展示已保存的 unlimited 与 180 分钟；1280×577 页面中会话操作区底部 398.19px、工具区顶部 414.19px，没有交叠。

浏览器、独立开发服务和 tmux 已清理，用户原有服务保持运行。原始证据保存在本工作树忽略目录 `tmp/agent-evals/pr-delivery/`，工程检查日志为 `/tmp/orbitcode-pr-{tests,lint,typecheck,build}.log`。

## 提交判断与保留边界

达到可提交、可评审的工程条件。既有分阶段真实模型分布与限制继续以 [首批调优](system-tuning-delivery-2026-10-22.md)、[运行预算](runtime-limits-2026-10-22.md)、[失败恢复改善](failure-recovery-improvements-2026-10-22.md) 为准。特定大文件任务的请求/token 改善不是通用性能承诺；未知原断言的恢复、reviewer 语义与长任务效率仍有部分通过样本，不声明这些问题已全面解决。

本次不合并 PR，不重写已推送历史，不重置原工作目录中的变更。
