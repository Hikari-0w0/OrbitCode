# 结构化系统提示与缓存可观测性 Tasks

状态：已批准
实现状态：已完成（2026-08-28，详见 `checklist.md` 与人工对比记录）
依据：已批准的 `spec.md` 与 `plan.md`

## 文件清单

| 操作 | 文件 | 职责 | 对应需求 |
| --- | --- | --- | --- |
| 新建 | `docs/evals/structured-system-prompt.md` | 保存固定人工任务集、基线、改造后观察和结论 | F13 |
| 新建 | `src/core/system-prompt/types.ts` | 定义固定模块、环境、可选上下文与 session 输入 | F1、F3、F5、F6 |
| 新建 | `src/core/system-prompt/identity.ts` | 身份模块 | F1、F2 |
| 新建 | `src/core/system-prompt/system-constraints.ts` | 系统约束模块 | F1、F2 |
| 新建 | `src/core/system-prompt/task-mode.ts` | 任务模式固定规则 | F1、F2、F7 |
| 新建 | `src/core/system-prompt/action-execution.ts` | 动作执行规则 | F1、F2 |
| 新建 | `src/core/system-prompt/tool-use.ts` | 全局工具选择与编辑规则 | F1、F2、F8 |
| 新建 | `src/core/system-prompt/tone-style.ts` | 语气风格规则 | F1、F2 |
| 新建 | `src/core/system-prompt/text-output.ts` | 文本输出规则 | F1、F2 |
| 新建 | `src/core/system-prompt/fixed-prompt.ts` | 校验并确定性拼装七模块 | F1、F2、F9 |
| 新建 | `src/core/system-prompt/dynamic-context.ts` | 构造、校验与转义动态标签消息 | F3、F4、F5 |
| 新建 | `src/core/system-prompt/session-instructions.ts` | 选择完整或精简模式提醒 | F6、F7 |
| 新建 | `src/core/system-prompt/assemble.ts` | 统一输出有序 system 消息 | F3、F4、F9 |
| 新建 | `src/core/system-prompt/system-prompt.test.ts` | 覆盖固定、动态、标签与轮次策略 | F1–F7、F9 |
| 修改 | `src/core/agent-loop.ts` | 在循环前组装一次提示并累计缓存用量 | F3、F6、F7、F9、F11 |
| 修改 | `src/core/agent-loop.test.ts` | 验证多迭代前缀、提示失败和缓存累计 | F3、F6、F9、F11 |
| 修改 | `src/core/agent-events.ts` | 扩展核心 Token 与缓存事件类型 | F11、F12 |
| 修改 | `src/tools/read-file.ts` | 强化专用读取使用说明 | F8 |
| 修改 | `src/tools/write-file.ts` | 强化覆盖已有文件前读取说明 | F8 |
| 修改 | `src/tools/edit-file.ts` | 强化编辑前读取与唯一替换说明 | F8 |
| 修改 | `src/tools/run-command.ts` | 声明不得替代专用文件工具 | F8 |
| 修改 | `src/tools/find-files.ts` | 强化专用文件发现说明 | F8 |
| 修改 | `src/tools/search-code.ts` | 强化专用代码搜索说明 | F8 |
| 修改 | `src/tools/registry.test.ts` | 验证工具顺序和描述稳定规则 | F8、F9 |
| 修改 | `src/models/provider.ts` | 增加 PromptCacheUsage 与 Provider 用量契约 | F10、F11 |
| 修改 | `src/models/openai-provider.ts` | 解析并降级缓存字段 | F10 |
| 修改 | `src/models/openai-provider.test.ts` | 覆盖标准、兼容、缺失与异常缓存数据 | F10 |
| 修改 | `tests/helpers/openai-mock.ts` | 生成各类缓存 usage 流事件 | F10、F11 |
| 新建 | `src/web/prompt-environment.ts` | 构造不含绝对路径和凭据的运行环境 | F3、F5 |
| 新建 | `src/web/prompt-environment.test.ts` | 验证环境白名单、日期、时区和边界 | F5 |
| 修改 | `src/web/chat-contract.ts` | 校验 modeTurn 与新增缓存用量结构 | F6、F11、F12 |
| 修改 | `src/web/chat-contract.test.ts` | 覆盖 Web 请求和 SSE 用量分支 | F6、F12 |
| 修改 | `src/app/api/chat/route.ts` | 提供安全环境、可选扩展空缺和 modeTurn | F3、F5、F6 |
| 修改 | `src/components/chat-session-state.ts` | 维护连续模式轮次和缓存展示状态 | F6、F12 |
| 修改 | `src/components/chat-session-state.test.ts` | 覆盖计数、重置、失败和缓存 reducer | F6、F12 |
| 修改 | `src/components/chat-workspace.tsx` | 计算并提交本轮 modeTurn | F6 |
| 修改 | `src/components/chat-workspace.test.tsx` | 验证模式切换与请求字段 | F6 |
| 修改 | `src/components/message-list.tsx` | 展示缓存 Token、比例、命中或不可用 | F12 |
| 新建 | `src/components/message-list.test.tsx` | 验证缓存展示文案与安全渲染 | F12 |
| 修改 | `src/app/globals.css` | 保证新增用量文案响应式可读 | F12 |
| 修改 | `tests/web-tool-agent.e2e.test.ts` | 验证完整消息顺序、工具闭环和缓存事件 | F3、F8、F9、F11、F12 |

## T1：建立人工对比基线

- 对应：F13，`plan.md` 的「人工对比文档」与「验证策略」
- 文件：`docs/evals/structured-system-prompt.md`
- 依赖：无

步骤：

1. 定义六个固定任务：专用搜索、读取后编辑、Plan 只规划、Do 执行后验证、工具失败恢复、简洁证据化输出。
2. 为每项写明安全临时 Workspace 的初始文件、精确用户输入、模式、Provider/模型记录位置、预期观察维度和禁止记录项。
3. 在修改提示代码前，使用同一未入库本地配置逐项执行；记录模型可见工具、实际工具调用顺序、最终文本和未通过原因。若模型环境不可用，明确标为“基线未验证”，不补造结果。
4. 保留可复位的 Workspace 准备与清理步骤，使改造后能以相同初态重跑。

验证：

- 运行：`test -s docs/evals/structured-system-prompt.md && rg -n "专用搜索|读取后编辑|Plan|Do|失败恢复|输出风格|改造前|改造后" docs/evals/structured-system-prompt.md`
- 期望：退出码 0；六类任务和前后观察栏齐全，不包含 API Key、绝对 Workspace 路径或预填通过结论。

## T2：实现七模块固定系统提示

- 对应：F1、F2、F9，`plan.md` 的「七个固定提示模块」与「固定与动态提示组装」
- 文件：`src/core/system-prompt/types.ts`、七个固定模块文件、`src/core/system-prompt/fixed-prompt.ts`、`src/core/system-prompt/system-prompt.test.ts`
- 依赖：无

步骤：

1. 定义固定模块 ID、优先级与只读内容契约。
2. 分别编写身份、系统约束、任务模式、动作执行、工具使用、语气风格和文本输出模块，避免交叉矛盾和运行时数据。
3. 以不可变常量数组声明唯一顺序，启动时断言七项完整、ID 唯一、优先级严格递增、内容非空且不含动态标签。
4. 用单个空行确定性拼装固定 prompt，并测试逐字符稳定、顺序、分隔和关键语义。

验证：

- 运行：`npm test -- src/core/system-prompt/system-prompt.test.ts`
- 期望：退出码 0；七模块顺序、稳定性、空行和冲突防护测试通过。

## T3：实现动态补充与模式强化策略

- 对应：F3–F7、F9，`plan.md` 的「固定与动态提示组装」与「模式强化」
- 文件：`src/core/system-prompt/types.ts`、`src/core/system-prompt/dynamic-context.ts`、`src/core/system-prompt/session-instructions.ts`、`src/core/system-prompt/assemble.ts`、`src/core/system-prompt/system-prompt.test.ts`
- 依赖：T2

步骤：

1. 定义环境、可选上下文、会话上下文和 system 输出类型，并设置单项、合计与轮次上限。
2. 为环境、自定义指令、Skill、记忆和 session 指令实现固定标签；校验非空内容并实体转义 `<`、`>`、`&`。
3. 实现 1、5、9……轮完整、其他轮精简的模式策略；完整与精简均声明真实 Plan/Do 权限。
4. 按固定、环境、三个可选、session 的顺序返回 system 消息；验证缺失可选项不产生空消息、非法环境和超限内容在组装时拒绝。

验证：

- 运行：`npm test -- src/core/system-prompt/system-prompt.test.ts`
- 期望：退出码 0；五类标签、注入转义、顺序、长度边界、完整/精简周期和模式差异全部通过。

## T4：把提示组装接入 Agent Loop

- 对应：F3、F6、F7、F9、F11，`plan.md` 的「Agent Loop 接入」与「请求组装」
- 文件：`src/core/agent-loop.ts`、`src/core/agent-loop.test.ts`
- 依赖：T3

步骤：

1. 移除现有内联 `MODE_PROMPTS`，让 Agent Loop 接收已验证环境、可选提示上下文和每轮 `modeTurn`。
2. 在任何 Provider 调用前组装一次全部 system 消息，再追加成功历史和当前用户消息。
3. 保证同一用户请求的每个 Agent 迭代复用相同 system 前缀，工具调用与结果只追加到末尾。
4. 覆盖 Plan/Do、完整/精简、非法轮次、动态输入错误、多工具迭代、取消和现有停止路径，确认提示错误无 Provider 调用和工具副作用。

验证：

- 运行：`npm test -- src/core/agent-loop.test.ts src/core/system-prompt/system-prompt.test.ts`
- 期望：退出码 0；捕获请求的角色顺序和前缀稳定，既有循环及停止测试保持通过。

## T5：接入安全环境与 Web 模式轮次

- 对应：F3、F5、F6，`plan.md` 的「Web 会话与组装层」与「安全与权限边界」
- 文件：`src/web/prompt-environment.ts`、`src/web/prompt-environment.test.ts`、`src/web/chat-contract.ts`、`src/web/chat-contract.test.ts`、`src/app/api/chat/route.ts`、`src/components/chat-session-state.ts`、`src/components/chat-session-state.test.ts`、`src/components/chat-workspace.tsx`、`src/components/chat-workspace.test.tsx`
- 依赖：T4

步骤：

1. 从服务端已授权 Workspace 条目构造 ID、名称、平台、日期、时区和固定路径语义；支持测试注入时钟，不传根路径或进程环境。
2. Web 请求增加严格正整数 `modeTurn`，拒绝缺失、额外、非整数、零值和超限值。
3. reducer 增加模式连续轮次状态：同模式提交递增；实际模式切换、Workspace/Provider 切换、清空和刷新归零；失败或取消不回退已提交轮次。
4. 普通提交和“按此计划执行”都先计算本次轮次再发送；后者从 Plan 切到 Do 时提交 1。
5. Route 解析请求与 Workspace 后构造环境并传给 Agent；所有失败发生在模型和工具之前。

验证：

- 运行：`npm test -- src/web/prompt-environment.test.ts src/web/chat-contract.test.ts src/components/chat-session-state.test.ts src/components/chat-workspace.test.tsx`
- 期望：退出码 0；环境无绝对路径与凭据，所有计数、重置、请求字段和非法输入场景通过。

## T6：强化并稳定工具描述

- 对应：F8、F9，`plan.md` 的「工具定义」
- 文件：`src/tools/read-file.ts`、`src/tools/write-file.ts`、`src/tools/edit-file.ts`、`src/tools/run-command.ts`、`src/tools/find-files.ts`、`src/tools/search-code.ts`、`src/tools/registry.test.ts`
- 依赖：T2

步骤：

1. 为读取、查找和搜索工具写明优先于通用 shell 的适用场景。
2. 为写入和编辑工具写明已有目标必须先读取最新内容；保留新文件创建与唯一替换语义。
3. 为命令工具写明仅在专用工具不能合理完成时使用，不改变执行能力或安全限制。
4. 测试同一 registry 多次导出的定义名称、描述、schema 和顺序逐项一致，Plan/Do 仍各自过滤到批准集合。

验证：

- 运行：`npm test -- src/tools/registry.test.ts src/tools/mode-policy.test.ts`
- 期望：退出码 0；描述包含关键规则，定义稳定且工具权限与参数 schema 未改变。

## T7：扩展 Provider 缓存用量解析

- 对应：F10、F11，`plan.md` 的「Provider 与用量模型」与「Provider 用量与缓存」
- 文件：`src/models/provider.ts`、`src/models/openai-provider.ts`、`src/models/openai-provider.test.ts`、`tests/helpers/openai-mock.ts`
- 依赖：无

步骤：

1. 定义 `PromptCacheUsage` 判别联合并加入 `ModelTokenUsage`，基础 Token 与缓存可用性分离。
2. 扩展测试辅助器以生成标准 `cached_tokens`、兼容 `prompt_cache_hit_tokens`、布尔 `prompt_cache_hit` 及任意异常字段。
3. Provider 先验证基础 usage，再按优先级解析缓存；零值合法，数值不得超过 prompt Token，多字段冲突或可选字段非法时仅降级缓存。
4. 保持流末尾至多一个 usage 事件和累计 usage 单调检查，覆盖无 usage 服务的现有行为。

验证：

- 运行：`npm test -- src/models/openai-provider.test.ts`
- 期望：退出码 0；标准、兼容、零、缺失、null、未知、冲突、越界和无 usage 场景符合计划。

## T8：贯通核心事件、Web 契约与缓存展示

- 对应：F10–F12，`plan.md` 的「Web 展示」
- 文件：`src/core/agent-events.ts`、`src/core/agent-loop.ts`、`src/core/agent-loop.test.ts`、`src/web/chat-contract.ts`、`src/web/chat-contract.test.ts`、`src/components/chat-session-state.ts`、`src/components/chat-session-state.test.ts`、`src/components/message-list.tsx`、`src/components/message-list.test.tsx`、`src/app/globals.css`
- 依赖：T4、T5、T7

步骤：

1. 扩展核心 `TokenUsage` 并实现基础 Token、数值缓存、状态缓存和 unavailable 的累计规则。
2. 更新 SSE 严格解析，拒绝非法基础数值与非法判别结构，同时接受合法缓存 unavailable。
3. reducer 保存每迭代与累计用量；消息列表分别呈现缓存 Token/比例、命中状态和未报告，零缓存不与不可用混淆。
4. 为桌面与窄屏调整现有用量行样式，保持纯文本渲染和安全换行。

验证：

- 运行：`npm test -- src/core/agent-loop.test.ts src/web/chat-contract.test.ts src/components/chat-session-state.test.ts src/components/message-list.test.tsx`
- 期望：退出码 0；数值、状态、混合、不完整和无 usage 的事件与文案均准确，最终回复和停止语义未变。

## T9：完成集成回归与改造后人工对比

- 对应：F3、F8–F13，`plan.md` 的「验证策略」
- 文件：`tests/web-tool-agent.e2e.test.ts`、`docs/evals/structured-system-prompt.md`，以及测试发现问题所对应的本轮文件
- 依赖：T1、T4、T5、T6、T8

步骤：

1. 扩展可控 Provider 端到端测试，捕获固定/动态 system 顺序、同轮多迭代前缀、Plan/Do 工具定义和缓存事件。
2. 依次运行全量测试、lint、类型检查和生产构建，修复本轮范围内回归，不放宽安全限制。
3. 启动开发服务器，用浏览器在桌面与窄屏检查 tokens、status、unavailable、模式计数效果、错误覆盖层和控制台，并关闭浏览器与服务器。
4. 复位 T1 的临时 Workspace，以相同模型、Provider、模式和输入重跑六类任务；填写改造后观察和逐项人工结论。若无法使用真实模型，保持未验证并记录原因。
5. 检查测试输出、DOM、网络消息和人工记录不含凭据、受保护文件或 Workspace 绝对路径，并清理临时目录和子进程。

验证：

- 运行：`npm run test`
- 期望：退出码 0；提示、Provider、Agent、Web 和工具的全部自动化测试通过。
- 运行：`npm run lint`
- 期望：退出码 0。
- 运行：`npm run typecheck`
- 期望：退出码 0。
- 运行：`npm run build`
- 期望：退出码 0。
- 观察：浏览器三种缓存状态、六类人工任务和资源清理结果均写入实际验收证据；未执行项明确标为未验证。

## 执行顺序

```text
T1（先记录基线）

T2 → T3 → T4 → T5 ─┐
 └────→ T6          ├→ T8 → T9
T7 ─────────────────┘
```

T6 可在 T3–T5 期间并行，T7 可与 T1–T6 并行；共享类型接入集中在 T8，避免并行任务同时改写 Agent 用量与 Web 契约。
