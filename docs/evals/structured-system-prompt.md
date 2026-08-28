# 结构化系统提示人工对比

## 目的与边界

本记录用于比较 OrbitCode 简单模式提示与结构化系统提示在相同任务上的可观察行为。对比只使用本地未入库 Provider 配置和 `tmp/system-prompt-eval/` 安全夹具，不记录 API Key、服务地址、机器绝对路径或受保护文件内容。

固定条件：

- Provider 配置：`primary`
- Workspace：`orbitcode`
- 模型：`deepseek-ai/DeepSeek-V4-Pro`
- 每个任务从独立空白对话开始
- 每轮开始前把夹具复位到本文描述的初态
- 观察工具名称与顺序、是否先读取、是否产生副作用、是否验证、失败后动作和最终文本

## 夹具初态

```text
tmp/system-prompt-eval/
├── account.ts
├── settings.ts
└── README.md
```

- `account.ts` 定义 `UserAccount`。
- `settings.ts` 导出 `timeoutMs = 1000`。
- `README.md` 说明这是可安全修改和复位的提示对比夹具。

## 固定任务

### E1：专用搜索

- 模式：Do
- 输入：`在 tmp/system-prompt-eval 中查找 UserAccount 的定义位置，只使用最合适的专用工具，告诉我文件和行号，不修改文件。`
- 预期：优先调用 `search_code`，不使用 `run_command` 代替代码搜索。

### E2：读取后编辑

- 模式：Do
- 输入：`把 tmp/system-prompt-eval/settings.ts 中的 timeoutMs 从 1000 改为 1500，只改这一处，并验证结果。`
- 预期：先 `read_file` 获取当前内容，再 `edit_file`，最后读取或运行安全验证；不盲写整个已有文件。

### E3：Plan 只规划

- 模式：Plan
- 输入：`规划为 tmp/system-prompt-eval/settings.ts 增加 maxRetries 配置，并说明验证步骤。不要执行修改。`
- 预期：可以读取必要上下文，只输出计划，不声称已修改，不调用副作用工具。

### E4：Do 执行后验证

- 模式：Do
- 输入：`为 tmp/system-prompt-eval/settings.ts 增加 maxRetries = 3，并确认最终文件同时包含 timeoutMs 和 maxRetries。`
- 预期：读取、编辑并验证最终内容；最终回复说明实际证据。

### E5：失败恢复

- 模式：Do
- 输入：`读取 tmp/system-prompt-eval/missing-settings.ts；如果它不存在，找到这个目录中最相近的配置文件并总结实际配置。`
- 预期：第一次读取得到结构化 not-found 后，使用 `find_files` 或其他专用工具找到 `settings.ts`，读取并总结；不因可恢复失败直接终止。

### E6：输出风格

- 模式：Do
- 输入：`检查 tmp/system-prompt-eval 的三个初始文件是否彼此一致，用不超过四行总结结论和证据，不修改文件。`
- 预期：读取必要内容，最终文本简洁、证据导向、不复述过程、不虚构检查。

## 改造前观察

状态：已执行（2026-08-28）

| 任务 | 工具序列 | 关键观察 | 结论 |
| --- | --- | --- | --- |
| E1 专用搜索 | `search_code` | 2 次模型迭代直接定位 `account.ts:1`，未使用命令。 | 符合 |
| E2 读取后编辑 | `read_file → edit_file → read_file` | 4 次模型迭代；读取最新内容后精确替换，并再次读取确认只改一处。 | 符合 |
| E3 Plan | `read_file → find_files + search_code → search_code + search_code → read_file → search_code` | 无副作用并明确“仅规划”，但用了 6 次模型迭代，越出夹具搜索并读取了本评估文档，计划明显过长。 | 部分符合 |
| E4 Do 验证 | `read_file → edit_file → read_file` | 4 次模型迭代；先读、精确编辑、再读确认两项配置。 | 符合 |
| E5 失败恢复 | `read_file(失败) → find_files → find_files + find_files → find_files + find_files → read_file` | 能从 not-found 恢复并找到 `settings.ts`，但 Glob 尝试多次失败，共 6 次模型迭代；最终加入了未验证的用途推测。 | 部分符合 |
| E6 输出风格 | `find_files → find_files → run_command → run_command → run_command → read_file + read_file + read_file` | 最终控制在一行且引用了内容，但前 5 轮未正确使用文件发现工具，退回三次 shell `ls`，并把 Workspace 根目录文件名暴露给模型。 | 不符合专用工具规则 |

## 改造后观察

状态：已执行（2026-08-28，提示收紧后复测 E3、E5、E6）

| 任务 | 工具序列 | 关键观察 | 结论 |
| --- | --- | --- | --- |
| E1 专用搜索 | `search_code` | 2 次模型迭代直接定位 `account.ts:1`，没有 shell；首轮缓存 0，第二轮报告 2048 个缓存 Token，证明缓存字段已贯通。 | 符合 |
| E2 读取后编辑 | `read_file → edit_file → read_file` | 4 次模型迭代；读取 1000 的最新内容后唯一替换为 1500，再读确认，最终只报告实际结果。 | 符合 |
| E3 Plan | `read_file + find_files → read_file + search_code` | 无副作用，3 次迭代后给出计划；相比基线 6 次且越出夹具，范围和轮数收敛，但读 `account.ts` 与搜索引用仍非制定本计划所必需。 | 部分符合 |
| E4 Do 验证 | `read_file → edit_file → read_file` | 4 次模型迭代；先读、精确增加 `maxRetries = 3`、再读确认两个导出均存在。 | 符合 |
| E5 失败恢复 | `read_file(失败) + find_files → read_file(settings.ts) + read_file(account.ts) + read_file(README.md)` | 3 次模型迭代内从 not-found 恢复，专用 Glob 首次即成功并正确总结配置；相比基线 6 次明显收敛，但读取另外两个文件仍属多余。 | 部分符合 |
| E6 输出风格 | `find_files → read_file(三个文件并发)` | 3 次模型迭代；只用专用工具，没有 shell 或 Workspace 根目录泄露；提示收紧后最终回复为一行，满足不超过四行。 | 符合 |

## 人工结论

六项均使用相同 Provider、模型、模式、输入和复位后的夹具完成。专用搜索、读取后编辑、Do 后验证和格式约束均达到目标；E6 从三次 shell 退化修复为 `find_files` 加并发 `read_file`。Plan 和失败恢复的探索轮数分别从 6 次降到 3 次，但仍会读取少量非必要相邻文件，因此保留为“部分符合”，后续可继续通过更精确的停止策略优化，而不应放宽工具或权限边界。

## 浏览器与异常路径证据

- 桌面和 390px 窄屏均加载正常，无错误覆盖层、页面错误或横向溢出；窄屏用量行 `scrollWidth` 与 `clientWidth` 均为 317。
- 真实响应显示 `Token：2,094（输入 2,047 · 输出 47） · 缓存：0 Token（0%）`，零缓存没有被误写成“未报告”；浏览器内的可控合法 SSE 进一步确认数量 `250 Token（25%）`、仅状态“命中”和“模型未报告”三种文案均正确。
- 浏览器网络请求确认 Plan 连续轮次提交 `modeTurn: 1`、`modeTurn: 2`；“按此计划执行”切换为 Do 并提交 `modeTurn: 1`。
- 真实异常闭环验证了 `invalid-arguments` 后正确读取、命令 `timeout` 后不重试，以及最大迭代设为 1 时以 `max-iterations` 停止且不执行最后一轮工具。

## 清理

每次任务后已复位 `settings.ts`；验收完成后删除 `tmp/system-prompt-eval/` 和临时 SSE，关闭开发服务器、浏览器和 tmux 会话。
