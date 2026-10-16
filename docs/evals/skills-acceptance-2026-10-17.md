# Skill 深度补测与验收收尾

日期：2026-10-17，Asia/Shanghai。用户授权继续测试、排查并修复值得修复的问题。本轮使用隔离 Workspace、配置、会话和本地 OpenAI 协议替身，调用实际文件、命令、进程、MCP、CLI 与 Web；没有新增真实模型调用，没有新增依赖，也没有提交或推送。

最终 `npm test` 为 **581/581 通过**，失败、取消、跳过均为 0；随后 lint、typecheck、build 均退出 0。原先缺少证据的 15 项取得补测结果，当前规格清单 **34/34 项通过**。这表示已定义条款在本次环境中通过，不表示任意模型、操作系统或并发时序均已穷尽验证。

## 复现后修复的问题

| 问题 | 影响及修复 | 回归证据 |
| --- | --- | --- |
| 保存失败后清空仍保留 pending-save 和旧运行标记 | 磁盘已清空，但后续请求被旧结果阻塞。成功清空后清理二者；清空 CAS 失败时保留待保存结果，删除成功后也丢弃内存待保存结果 | `tests/skills-state-safety.e2e.test.ts`：清空后真实请求成功、重试不重放副作用、清空失败仍能重试、删除清理 |
| recent 历史遇到压缩或回合不足时没有边界提示 | 子会话无法区分“完整最近历史”和“仅剩部分历史”。新增请求/实际回合数与压缩说明，不把早期摘要冒充最近回合 | `src/runtime/skills/history.test.ts`：none/recent/all、摘要、损坏工具组、引用隔离及 1 MiB 展开预算 |
| 超大资源错误分类不明确 | 超过 128 KiB 原先退化为通用加载错误。底层增加容量错误类型，资源层映射到 `limit-exceeded`；拒绝后不更新资源哈希 | `src/runtime/skills/resources-boundaries.test.ts` |
| Next 生产文件追踪夹带本地配置 | NFT 清单实际包含本地 `.env` 和 `.orbitcode` 文件路径。排除本地配置、工作区数据和开发文件，同时明确包含内置 Markdown；没有证据表明这些文件曾被发布或泄露 | 修复前审计失败；最终 `trace-audit.json` 的 forbidden 为空，三个内置入口均存在；未打印或复制凭据内容 |
| 符号链接路径启动 CLI 时静默退出 0 | 原入口只按 URL 字符串比较，在 macOS `/var` 与 `/private/var` 等路径下没有执行 main。改为双方真实路径比较 | `tests/cli-symlink-entry.e2e.test.ts`；完全外部包的编译后 CLI 实际输出三个 Skill 并退出 0 |

没有放宽白名单交集、Plan/Do、路径边界、审批或独立递归限制。`load_skill` 的既有系统工具豁免保持原语义。

## 本轮补齐的边界

- 严格字段/YAML/参数与文件预算；同层冲突、来源不可用、链接逃逸、257 个入口、1025 个目录项、累计 8 MiB 和目录摘要 16 KiB 上限。不完整来源不返回可激活的截断目录。
- 无 ContextManager 的真实协议循环；两个共享 Skill 在同回合、后续回合及自动/手动压缩后继续生效。
- 删除源文件后快照仍可运行；停用后的导出保留历史；同进程和两个独立 CLI 进程争用同一修订时仅一次提交成功；保存重试不调用模型或重复写入。
- 独立模型等待期间禁止清空；取消并清空后，迟到模型响应不改变 revision、epoch、消息或 Skill 状态。
- 模板、示例、脚本和参考文件逐类读取，脚本不执行；外部用户资源、绝对路径、穿越、链接和保护文件拒绝。实际审批允许之前/之后变更已引用资源，执行复检均阻止旧写入。
- 第 65 个资源、1 MiB 历史、第 5 次独立调用、32k 模型窗口等限制实际触发，失败保留旧状态；已有轮数/deadline/失败预算回归通过。
- 临时 ContextStore 删除失败有明确清理错误且不抹去副作用。真实 stdio MCP 中，子运行结束后父调用仍使用原服务进程，初始化一次、工具调用两次；父 runtime 关闭后进程消失。

对应测试还包括 `tests/skills-budget.e2e.test.ts`、`tests/skills-context-variants.e2e.test.ts`、`tests/skills-mcp-lifecycle.e2e.test.ts`、`tests/skills-cross-process.e2e.test.ts` 及 catalog/service/isolated-runner 回归。清单逐项映射见 [checklist.md](../specs/reusable-skills/checklist.md)。

## 真实终端、生产包与浏览器

`scripts/verify-skill-terminal.ts` 在本任务独立 tmux server 中运行真实 CLI，12 个场景通过：审批拒绝、审批允许、长运行取消、未知 Skill、缺参数、工具失败、无效参数、命令非零、命令超时、主循环上限、子循环上限和禁止工具。共 30 次协议替身模型请求、3 次审批；主会话最终 revision 14。非零命令保留 stdout `OUT_9`、stderr `ERR_9` 和退出码 9；超时保留 timeout 字段。取消后受管进程消失，主会话继续运行，子激活不污染父状态。拒绝后的最终回复不被当作写入成功，文件结果单独断言。

`scripts/verify-skill-package.ts` 将生产 `.next`、完整依赖、内置资源与编译后的 220 个应用 JS 文件复制到仓库祖先目录之外的系统临时目录。副本没有 `src`、`.env`、旧 YAML 或 `.orbitcode`；仅在副本的 commit 简介添加 `PACKAGE_COPY_627`。真实 Next start 的 API 返回三个样板及副本标记，主页 200；从另一 cwd 运行编译后的 CLI 也输出三个名称及标记，退出 0。最终构建复测使用端口 63410，服务已关闭。该验证借用现有 tsx 解析编译 JS 的别名，没有声称项目新增了独立 CLI 发行器。

agent-browser 在修复后的外部生产包中实际打开页面、展开 Skills、刷新并确认三个样板及副本标记；错误覆盖层未出现，浏览器 errors 和 console messages 均为空。该次 UI 检查对应同一运行实现，最终重新构建后再次通过包 API/CLI 验证；未把它描述为真实模型 Web 测试。完整的参数调用、状态保留、停用及清空 Web 交互沿用前次已留证验证。

## 命令、失败与原始证据

| 命令/阶段 | 原始结果 |
| --- | --- |
| `npm test` | 退出 0，581 passed、0 failed/cancelled/skipped |
| 首次最终 lint | 退出 1：早期放在仓库临时目录中的编译副本被 ESLint 扫描，343 errors、6302 warnings，未继续 typecheck/build |
| 清理已确认属于本任务的编译副本，再 `npm run lint` | 退出 0，没有修改 ESLint 规则或忽略真实源码错误 |
| `npm run typecheck` | 退出 0 |
| `npm run build` | 退出 0，含 skills API |
| `tsx scripts/verify-skill-terminal.ts tmp/agent-evals/skill-terminal-20261017` | 退出 0，12 场景通过 |
| `tsx scripts/verify-skill-package.ts tmp/agent-evals/skill-package-final-20261017` | 退出 0，追踪审计、外部包 Web/CLI 通过 |

补测中保留的失败还包括：清空待保存状态、recent 摘要边界、资源超限分类、生产追踪配置和 CLI 入口问题的修复前失败；测试夹具自身的 promptEnvironment/NODE_ENV 缺项分别修正，没有通过修改产品契约让夹具通过。Markdown 正文允许 `---`，测试曾误判其为第二份 frontmatter，已修正为 YAML 部分的非法组合。

早期包放在仓库子目录中，Next 可以向上查找配置，因此当次成功不能证明完全隔离。改用系统临时目录后又复现了 CLI 静默退出，修复后才取得最终通过证据。早期副本生成文件导致上述 lint 阻塞，已清理；不删除这些失败记录。

本机未入库证据（系统清理后可能消失）：

- 全量日志：`/tmp/orbitcode-skills-acceptance-tests.log`、`/tmp/orbitcode-skills-acceptance-lint.log`（失败）、`/tmp/orbitcode-skills-acceptance-lint-clean.log`、`/tmp/orbitcode-skills-acceptance-typecheck.log`、`/tmp/orbitcode-skills-acceptance-build.log`。
- 修复前后：`/tmp/orbitcode-skills-state-safety-{red,green,final}.log`、`/tmp/orbitcode-skills-format-history-{red,green}.log`、`/tmp/orbitcode-skills-resources-boundaries-red.log`、`/tmp/orbitcode-skills-boundary-green.log`、`/tmp/orbitcode-cli-symlink-{red,green}.log`。
- 终端：`tmp/agent-evals/skill-terminal-20261017/` 的 result、tmux、请求和会话/日志；汇总 `/tmp/orbitcode-skills-terminal-deep.log`。
- 最终包：`tmp/agent-evals/skill-package-final-20261017/` 的 trace-audit、production-catalog、cli、server、result；汇总 `/tmp/orbitcode-skills-package-final.log`。
- 生产浏览器：`tmp/agent-evals/skill-package-external-fixed-20261017/` 的 browser-snapshot、browser-errors、browser-console 和 browser.png。

命名 tmux、浏览器、生产服务器、本地替身及受管子进程均已结束；复制包已经清理，保留上述轻量结果。最终 `cleanup.json` 记录三个确认属于本任务的外部副本删除，3097/3098/3099/58912/62442/63410 均无监听。没有宽泛结束用户其他进程。

## 验证结论的边界

本轮证明确定性场景下的状态一致性、强制工具边界和真实程序闭环。没有新增真实模型样本，也没有覆盖所有文件系统故障、网络异常、操作系统及并发排列。前次真实模型原始分布仍为 10 通过、2 失败、3 阻塞，修复后的 12/12 和最终 3/3 分阶段保留，不能合并成任意模型的稳定成功率。详见 [原评测](skills-real-model-2026-10-16.md) 和 [修复复测](skills-fixes-2026-10-16.md)。

## 后续真实模型补测

本报告对应的确定性阶段没有调用真实模型。用户随后明确授权后，当前实现取得 CLI 12 项及 Web HTTP/SSE 4 项有效功能验证，另一次 Web 夹具中止原样保留；详见 [同日真实模型报告](skills-real-model-2026-10-17.md)。两阶段证据分别记录，不改写本报告阶段条件。
