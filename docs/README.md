# OrbitCode 文档目录

使用与配置以 [项目 README](../README.md) 和当前源码为准。项目约束见根目录 [AGENTS.md](../AGENTS.md)。

| 目的 | 入口 |
| --- | --- |
| 安装、Web/CLI、模型、Workspace、MCP、Skills、记忆 | [项目 README](../README.md) |
| 仓库文档与源码检索 | [RAG 使用与配置](specs/repository-rag/README.md)、[实际验证](evals/repository-rag-real-model-2026-10-25.md) |
| 自动化检查与本地数据维护 | [开发与验证](../README.md#开发与验证)、[本地数据与维护](../README.md#本地数据与维护) |
| 定位运行记录、导出证据与诊断 | [运行评估工作流](evals/README.md) |
| 单次 CLI 与真实模型评测 | [Agent 评测用法](evals/agent-evaluation.md) |
| 功能设计及各阶段验收 | [规格目录](specs/README.md) |
| 子 Agent 范围与限制 | [子 Agent 交付状态](specs/sub-agents/delivery-status.md) |
| 本次清理及检查结果 | [收尾整理记录](evals/repository-closeout-2026-10-22.md) |
| 早期项目基线及考核交付 | [历史基线](project-baseline-2026-09-16.md)、[归档目录](archive/README.md) |

规格、阶段评测和归档保留原始设计、失败分布与版本背景，其中旧审批流程、完成报告工具和测试数字可能已经被后续实现替代。阅读历史材料时先检查日期及后续条款；历史未勾选项不能直接视为当前功能缺失，历史通过项也不能代替当前版本的验证。

`npm test` 中使用本地 Provider 替身的端到端测试与真实模型评测分别记录。真实模型结果只覆盖报告中的模型、版本和场景，不作普遍成功率或加速保证。
