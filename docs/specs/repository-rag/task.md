# 仓库知识检索增强（RAG）Tasks

状态：已批准
日期：2026-10-24
依据：[spec.md](spec.md) 与 [plan.md](plan.md)（已批准）

用户于 2026-10-24 指示开始开发；以下任务按验证证据更新进度。命令对应本轮新增或复用的验证入口，已执行结果见 checklist.md。

## 文件清单

具体新增/修改路径逐项列于任务，职责与 plan 的文件组织一致。所有实现任务同时交付对应行为测试；不包含提交、推送或 PR。

## T1：领域契约与纯检索算法

- 对应：F4、F5、F6；plan「核心类型与接口」「检索、来源与预算」
- 前置依赖：无
- 文件与职责：新建 src/core/retrieval/types.ts、tokenizer.ts、ranking.ts、evidence.ts；回归集中在 src/core/retrieval/ranking.test.ts。

步骤：

1. 实现判别联合、中文二元组与标识符分词、BM25、归一化向量点积和稳定 RRF 排名。
2. 实现片段去重、每文件条数限制、证据预算和省略统计；排名分数不作为正确率。

验证：

- 命令：`npm test -- src/core/retrieval/ranking.test.ts`
- 期望：人工可计算的小语料排名符合预期；空输入、同分、中文标识符、重复与超预算结果确定。

## T2：配置与公开视图

- 对应：F1、N2；plan「配置与权限」
- 前置依赖：T1
- 文件与职责：修改 src/runtime/settings-types.ts、settings-service.ts、src/lib/local-settings-store.ts；新增 src/runtime/knowledge/config.ts；回归集中在 src/runtime/knowledge/service.test.ts，并复用 src/runtime/settings-service.test.ts。

步骤：

1. 增加独立 Embedding 和工作区知识配置、远程发送启用标记、范围规则和资源限制；旧配置迁移为停用。
2. 覆盖保存、读取、revision 冲突、导出及恢复预览，公开字段只暴露凭据是否配置；保存不执行网络或扫描。

验证：

- 命令：`npm test -- src/runtime/knowledge/service.test.ts src/runtime/settings-service.test.ts src/lib/local-settings-store.test.ts`
- 期望：旧设置可加载、越界参数被拒绝、敏感值不进入公开视图，配置保存无副作用。

## T3：安全扫描与结构分块

- 对应：F2、F5、N1；plan「扫描与结构分块」「配置与权限」
- 前置依赖：T1、T2
- 文件与职责：新建 src/runtime/knowledge/access.ts、scanner.ts、chunker.ts；回归集中在 src/runtime/knowledge/service.test.ts；修改 package.json、package-lock.json、src/tools/protected-paths.ts、src/tools/macos-seatbelt-sandbox.ts 及已有工作区安全回归。

步骤：

1. 通过现有权限门禁和工作区 API 扫描；为索引数据根增加敏感目录保护，包括自定义数据根位于仓库内的情况。
2. 实现 Markdown 和 TypeScript 结构分块、原文行号与哈希；记录解析失败和跳过原因，避免携带旧片段。
3. 将已有 typescript 调整至生产依赖，在临时生产安装中验证解析器可用，不引入新包。

验证：

- 命令：`npm test -- src/runtime/knowledge/service.test.ts src/tools/workspace.test.ts`
- 期望：合法片段逐字对应源文件；越界链接、拒绝文件、索引自身不会被读取；生产依赖具备分块能力。

## T4：Embedding 适配与服务预算

- 对应：F1、F7、N2、N4；plan「Embedding 适配」「资源限制」
- 前置依赖：T1、T2
- 文件与职责：新建 src/models/embedding-provider.ts、embedding-provider.test.ts。

步骤：

1. 用 fetch 实现兼容请求、前缀配置、批量拆分、向量校验和 usage 来源。
2. 加入并发、请求时限、重试及取消；禁跨地址重定向；对响应与错误进行脱敏。
3. 以本地 HTTP 替身覆盖乱序索引、维度不符、非有限值、鉴权失败、429、5xx 和挂起响应。

验证：

- 命令：`npm test -- src/models/embedding-provider.test.ts`
- 期望：响应正确归位，畸形向量拒绝；重试次数及取消后请求数满足上限，凭据不出现在错误中。

## T5：版本存储与作业生命周期

- 对应：F3、F7、N3；plan「本地索引、增量与并发」
- 前置依赖：T1、T2
- 文件与职责：新建 src/runtime/knowledge/store.ts、lifecycle.ts ；回归集中在 src/runtime/knowledge/service.test.ts，复用 src/lib/local-file-lock.ts。

步骤：

1. 实现私密目录、manifest 校验、版本指针原子发布、单版本读取和有界缓存。
2. 实现跨进程构建所有权、取消标记、epoch 与提交前复核；重叠构建返回 busy。
3. 覆盖删除与构建竞争、停用与查询竞争、进程异常退出和中断暂存恢复，禁止中断后自动续跑付费请求。

验证：

- 命令：`npm test -- src/runtime/knowledge/service.test.ts`
- 期望：通过两个独立 Node 进程验证互斥；故障后保留旧完整版本；删除后旧作业不能复活索引。

## T6：增量索引构建

- 对应：F2、F3、F7；plan「扫描与结构分块」「本地索引、增量与并发」
- 前置依赖：T3、T4、T5
- 文件与职责：新建 src/runtime/knowledge/indexer.ts；回归集中在 src/runtime/knowledge/service.test.ts。

步骤：

1. 连接授权扫描、分块、词法表示、向量生成与暂存发布；按兼容性指纹和内容哈希复用。
2. 处理新增、修改、删除、移出范围和解析失败，返回真实新增/复用/跳过统计。
3. 提交前复核内容和生命周期状态，扫描总上限或服务失败时终止发布，空合法范围可发布空索引。

验证：

- 命令：`npm test -- src/runtime/knowledge/service.test.ts`
- 期望：无变化更新不新增文档向量请求；变化只重算必要片段；失败不替换版本，模型/维度/分块变化触发重建。

## T7：查询编排与实时证据过滤

- 对应：F4、F5、F7、N1、N4、N6；plan「检索、来源与预算」
- 前置依赖：T1、T3、T4、T5、T6
- 文件与职责：新建 src/runtime/knowledge/service.ts、service.test.ts。

步骤：

1. 实现绑定工作区的 KnowledgeReader，类别筛选、两路召回、融合、授权与版本复核。
2. 过滤过期和拒绝文件，在有界候选内补足结果；限制缓存及输出，保留 partial/no-match 区别。
3. 实现服务不可用和语义额度耗尽时的显式关键词降级；取消、权限错误和索引损坏不伪装成零命中。
4. 记录版本、规模、耗时和用量来源，默认不记录查询与正文。

验证：

- 命令：`npm test -- src/runtime/knowledge/service.test.ts`
- 期望：更新前查询不会返回失效正文；文件拒绝在重复查询时仍生效；降级和不可恢复错误可区分。

## T8：Agent 工具与上下文接入

- 对应：F6、F7；plan「Agent 与两端入口」
- 前置依赖：T7
- 文件与职责：新建 src/tools/search-knowledge.ts，回归集中在 tests/knowledge.e2e.test.ts；修改 src/tools/default-registry.ts、src/runtime/agent-runtime.ts、src/core/system-prompt/tool-use.ts。

步骤：

1. 注入只读工具和当前工作区 reader，校验参数，复用权限、取消、总运行时限与上下文卸载。
2. 纳入独立语义服务调用额度并与聊天 usage 区分；停用后旧 reader 拒绝继续请求。
3. 增加核实源码、引用来源与不信任文档指令的提示；保持子 Agent 现有工具白名单。

验证：

- 命令：`npm test -- tests/knowledge.e2e.test.ts src/core/system-prompt/system-prompt.test.ts`
- 期望：Plan/Do 正常检索，写权限不扩大；不需要检索时无自动片段注入；工具成功不改变任务验收结论。

## T9：Web 与 CLI 管理入口

- 对应：F1、F8、N2、N5；plan「Agent 与两端入口」
- 前置依赖：T2、T6、T7、T8
- 文件与职责：新建 src/web/knowledge-http.ts、knowledge-http.test.ts、src/app/api/knowledge/route.ts、src/components/settings/knowledge-settings.tsx、src/cli/knowledge-commands.ts；CLI 回归复用 tests/knowledge.e2e.test.ts；修改 settings/settings-panel.tsx、tool-execution-card.tsx、src/cli/commands.ts、session-controller.ts；新增 tests/knowledge.e2e.test.ts。组件修改路径均相对 src/components。

步骤：

1. 控制面解析已授权 workspaceId、检查请求来源和操作归属，配置交给现有设置服务；长作业短请求启动并查询状态。
2. 实现两端配置、启停和全部管理动作；CLI 从本地配置文件读取非秘密字段与环境变量名，Web 明示远程传输范围。
3. 工具卡片展示来源和版本；核查历史结果不被标为实时事实。
4. 启动开发服务进行 agent-browser 检查，完成后关闭浏览器和相关进程；CLI 独立启动验证。

验证：

- 命令：`npm test -- src/web/knowledge-http.test.ts tests/knowledge.e2e.test.ts`
- 期望：两端在同一夹具上管理行为一致；伪造工作区或作业 ID 被拒绝；页面无错误覆盖层和控制台错误。

## T10：固定评估与回归交付

- 对应：F9、N4、N6；plan「验证策略」
- 前置依赖：T8、T9
- 文件与职责：新增 tests/fixtures/knowledge/ 下公开或合成语料、questions.json、rubric.md，scripts/run-knowledge-evals.ts、scripts/run-knowledge-agent-evals.ts、scripts/fixtures/knowledge-provider.ts、scripts/knowledge-eval-metrics.ts、scripts/knowledge-eval-metrics.test.ts、docs/evals/repository-rag.md；修改 README.md、docs/README.md 和本目录 checklist.md 的实际结果。

步骤：

1. 冻结 60 题、40/20 划分、标注证据和人工判定规则，开发集调参后锁定参数；不因结果不佳重分测试集。
2. 脚本支持检索三组与 Agent 两组对照，保存仓库/配置指纹、全部尝试、Token、服务用量和耗时；无答案与安全问题独立统计。
3. 采用本地替身先验证度量和协议；在安全配置具备且获准运行模型时执行真实评估和 tmux 对话，缺失条件明确记录未验证。
4. 执行完整回归和项目检查，逐项记录验收证据，不提交原始私有日志或凭据，不自动提交 Git。

验证：

- 命令：

```bash
npm test -- scripts/knowledge-eval-metrics.test.ts
npx tsx scripts/run-knowledge-evals.ts --mode fixture
npm test
npm run lint
npm run typecheck
npm run build
```
- 期望：指标计算能用人工小样本复核；完整报告包含不利结果、实际样本量和未验证项，验收只勾选有证据的条目。

## 执行顺序与完成条件

T1 → T2 → T3/T4/T5 → T6 → T7 → T8 → T9 → T10。T3、T4、T5 只表示依赖上可独立，不要求多 Agent 并行开发。

每项测试退出码为 0 且行为证据符合预期后才标记任务完成；最终完成仍以 checklist 全部要求及明确记录的环境限制为准。涉及公开行为或架构变化时先修订受影响文档。

## 当前实施进度

T1–T9 已有实现并完成初版检查；2026-10-25 真实验证发现 T3 扫描范围计数与 T8 Plan 工具接入仍有缺陷，不能继续视为全面完成。T10 已执行真实 Embedding、有效 Do 对照与实际 Agent 场景，复杂任务收敛、精确引用和重复评估仍不足。完整证据与未完成项以 checklist.md 和真实模型报告为准。


### 2026-10-25 改善复测

T3 的扫描计数与 T8 的 Plan 接入已修复，增加包含范围/排除/候选预算、只读工具实际执行和独立 Plan CLI 回归；检索行号展示与临时预算提示已接入。完整回归 819/819，lint、typecheck、build 通过。实际原仓库增量索引成功，真实 Plan 六次均执行检索，tmux 完成单轮任务；复杂复合任务虽能收尾，严格内容复核仍为 0/3。T10 完整重复对照、引用支持和剩余资源组合验收尚未完成，不把正常退出视为任务通过。证据见 [改善复测](../../evals/repository-rag-improvements-2026-10-25.md)。
