# 仓库收尾整理（2026-10-22）

本次仅清理有引用证据的冗余代码、修正文档及本地数据忽略规则，没有新增功能或运行时依赖。

## 清理依据

- 使用 TypeScript 解析静态导入和重导出，并在源码、测试、脚本与文档中复查引用。
- `src/core/conversation.ts` 是早期纯文本会话实现，仅其专属测试引用；现有 Web/CLI 使用共享 Agent Runtime 与 Agent Loop。删除该实现及对应的 8 项专属测试，保留现行 Agent Loop、会话持久化、取消和恢复测试。
- `src/core/errors.ts` 中的 `RecoverableChatError` 与 `toRecoverableChatError` 仅供上述旧实现使用，一并删除；现行循环仍使用的两种错误类保留。
- `src/components/ui/field.tsx`、`status-notice.tsx` 没有调用方，删除组件及专属 `.statusNotice` 样式；其他组件使用的 `.field`、`.fieldHint` 样式保留。
- `src/web/prompt-environment.ts` 仅是共享运行层的转发，且只有测试引用。删除转发，将两项测试移到 `src/runtime/prompt-environment.test.ts` 并直接测试实际实现。
- 历史评测、规格、兼容读取和验收辅助代码保留；没有把“未被产品代码调用”一概当作无用文件。原有 `.orbitcode/memory-v1/` 保留，新增 Git 忽略规则。

## 文档整理

README 补充锁定依赖安装、生产启动、自动化与真实模型测试的区别、平台限制、本地数据及备份说明；校正移动端、Plan 工具列表、已撤下完成报告和外部调用观察语义。AGENTS 的 CLI 简介与自主执行行为对齐，环境变量示例注明 Web/CLI 共用。

新增 [文档目录](../README.md)，规格目录改用项目 README 作为现行能力入口，九月基线明确标记为历史。历史测试数字和旧策略不追溯改写。

## 本次验证

| 检查 | 结果 |
| --- | --- |
| `npm test` | 796/796 通过，失败/取消/跳过均为 0；删除的旧模块专属测试共 8 项 |
| `npm run lint` | 通过 |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过，本次构建日志未出现 warning/error |
| 额外未使用局部变量/参数检查 | TypeScript `--noUnusedLocals --noUnusedParameters` 通过 |
| 实际浏览器 | agent-browser 检查工作台、工具结果、最终回复、保存状态与设置页；未记录页面或控制台错误 |
| tmux CLI | 隔离 Provider/Workspace 下完成 `read_file` → 第二轮最终回复 → revision 1 保存，停止原因为 `final-response` |
| 文档本地链接与 Git 差异 | 检查现行文档本地目标及 `git diff --check` |

浏览器使用开发服务、隔离用户数据与隔离 Workspace，本地 HTTP Provider 替身只执行真实本地文件读取；截图、服务日志与替身请求保存在仓库外临时目录。页面截图已人工查看，工作台布局与回复可读。本次没有调用真实模型，没有重新评估模型质量、性能或费用；替身闭环仅验证运行链路。自动化测试仍覆盖现行权限、工具异常、时限及运行上限路径。

验证结束关闭本次浏览器、tmux CLI、开发服务和本地 Provider；没有提交、推送或部署。
