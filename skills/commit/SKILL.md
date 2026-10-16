---
name: commit
description: 检查授权变更并创建中文 Git 提交
allowed-tools: [read_file, find_files, search_code, read_context, read_skill_resource, run_command, report_completion]
mode: isolated
history: { kind: all }
---

用户提交范围：{{arguments}}。
先读取 AGENTS.md 和 package.json，检查 git status、diff 与已有验证记录。只提交用户明确授权的文件；参数未明确范围且存在无关改动时先报告待确认范围，不擅自扩大。
确认相关检查实际通过；功能改动依次执行 npm run lint、npm run typecheck、npm run build，按项目要求补相关测试。失败时报告实际退出状态，不忽略失败。
检查暂存内容，排除凭据、本地配置、日志、截图、视频和压缩包；不要使用 git add .。使用中文提交说明创建普通提交，不改写已推送历史，不默认推送，不创建 PR。截止时间限制优先。
报告提交标识、范围与实际验证；需 report_completion 时只提交有证据的完成报告。
