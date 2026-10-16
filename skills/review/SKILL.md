---
name: review
description: 只读审查变更，报告可定位问题与证据
allowed-tools: [read_file, find_files, search_code, read_context, read_skill_resource]
mode: isolated
history: { kind: all }
---

根据用户范围 {{arguments}} 审查工作区。先读 AGENTS.md、项目说明和相关源文件，再识别影响正确性、安全性或兼容性的问题。
只读审查，不修改文件，不运行命令、不提交。每个问题标注优先级、文件与位置、触发条件及证据；区分已确认问题与尚未验证的推断。没有发现问题时明确说明，并列出未覆盖范围。审查结论不是功能验收通过证明。
