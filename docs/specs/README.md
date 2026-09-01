# 功能规格目录

本目录保存 OrbitCode 非平凡功能和跨模块改动的规划与验收文档。每项功能使用独立的 kebab-case 子目录：

```text
docs/specs/<feature-slug>/
├── spec.md       # 需求、边界和验收标准
├── plan.md       # TypeScript 架构、接口和技术决策
├── task.md       # 实施顺序、文件与任务验证
└── checklist.md  # 行为、集成和端到端验收
```

## 使用方式

开始一项需要完整设计的新功能时，在 Codex 中调用项目级 skill：

```text
$orbitcode-spec 为 <功能描述> 创建规格并推进开发
```

skill 会按 `spec.md → plan.md → task.md → checklist.md` 的顺序推进，并在每份文档完成后等待明确批准。四份文档全部批准前，不编写该功能的实现代码。

如果四份文档已经存在，直接提供目录并说明审批状态：

```text
$orbitcode-spec 使用 docs/specs/<feature-slug>/ 中已有的四份文档继续开发。
这些文档已经批准；请先检查一致性，不要重写，检查通过后按 task.md 实现。
```

## 维护规则

- 只为实际功能创建子目录，不预先生成空文档或占位目录。
- 每份文档标明 `状态：草案` 或 `状态：已批准`。
- 上游文档发生范围或架构变化时，复查并重新批准受影响的下游文档。
- 文档不得覆盖仓库根目录 `AGENTS.md` 中的技术、安全和交付约束。
- 不在文档、日志、截图或示例中记录 API Key、完整环境变量或其他凭据。
