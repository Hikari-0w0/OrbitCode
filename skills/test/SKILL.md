---
name: test
description: 按改动选择测试并如实报告 npm 检查结果
allowed-tools: [read_file, find_files, search_code, read_context, read_skill_resource, run_command, start_process, process_status, stop_process]
mode: isolated
history: { kind: all }
---

测试范围：{{arguments}}。
先读取 AGENTS.md、package.json、相关改动和测试说明，选择有意义的相关测试。默认只验证，不修改产品或测试来消除失败。
功能完成检查依次执行 npm run lint、npm run typecheck、npm run build；保留 stdout、stderr、退出码、超时和取消状态。不要用 || true 等方式掩盖失败。
涉及页面时按仓库要求启动开发服务器，用 agent-browser 检查页面、错误覆盖层和控制台；结束后关闭本次浏览器和服务器。Agent 主流程需在 tmux 中验证成功、工具失败、无效参数、超时和最大循环路径。
未经用户明确授权不调用真实模型，不显示真实凭据；可用安全本地替身测试程序闭环并注明证据边界。缺环境时标为未验证。
报告各项通过、失败、未验证及证据，区分首次检查与追加复验，保留每次真实退出码；不得把复验算作没有发生，也不要为凑次数省略有必要的验证。最终汇总前核对最新工具记录与已引用文件；未重新读取最新内容时，不声称日志或文件只有特定行数。子结果摘要中的 commandCalls 是运行时记录的 run_command 调用结果，不等于 Shell 内部子命令次数。任务回复不替代验收，最终总结不得夸大覆盖。
