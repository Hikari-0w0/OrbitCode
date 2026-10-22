# 子 Agent 检索与失败交接改进验收（2026-10-20）

> 历史版本记录：report_completion现已撤下，当前行为见[移除决策与验收](report-completion-removal-2026-10-20.md)。以下数字与结论保留原执行时状态。
用户在原真实模型验收后授权改进。本轮完成当前子任务边界、上下文读取出口、运行时事实交接、主 Agent 接管指引及可维护复测脚本；不增加依赖、运行预算、文件隔离、自动重跑或新搜索工具。

本轮新增 **18个真实模型样本：14通过、4失败**。其中提示改进阶段8例为4通过/4失败；发现并修复读取闭环后，原任务矩阵8例、tmux CLI 1例、Web HTTP/SSE 1例均通过，共10例。两阶段、所有失败均保留，不能只报告最终10/10，也不能据此推导一般成功率。

原有[38例报告](sub-agents-real-model-2026-10-20.md)保持历史结论。本文只记录新增改进和验证。

## 改动与依据

1. `agents/child-instructions.ts` 持续区分父编排与当前子任务，要求检索未完成时说明范围，沿nextOffset读取，交接修改/失败/未验证项。`runChildExecution` 在最后追加的用户消息中标记 `orbitcode_current_subtask`；继承父消息和工具配对原样保留，当前任务动态值不插到稳定系统前缀。只改系统提示仍会拒绝委派或回答ACK；因此首阶段的Fork两例继续失败，不能宣称提示已解决问题。
2. 真实失败暴露 `read_context` 大分块被再次卸载，形成引用链。`context-read-payload.ts` 在轻量压缩中对实际read_context结果按单结果/批次预算裁剪可见正文，按Unicode字符更新**原引用**的nextOffset/hasMore。不给读取工具预算豁免；连最小正文与元数据都放不下时明确容量停止。普通文件/命令结果仍按原策略卸载。
3. `ChildHandoff` 复用命令结果摘要，保留计数、callId、最近16条退出码/超时/取消；从文件工具确认结果提取最多8个路径，部分批量失败仍保留已写前缀。命令正文及stdout/stderr不复制到交接；callId用于定位子工具调用，不是父完成报告的evidence_call_id。文件清单明确标记file-tool-results-only，不能当作命令/MCP/进程的完整副作用列表。主结果截断仍保留交接、失败总量及证据ID，并增加省略数。
4. 主执行指令要求按原契约处理失败；允许接管时先说明原因/文件范围，确认相关子任务停止写入，再读最新文件修复并复验。用户明确禁止父修改的文件继续禁止。该指引不是文件所有权锁。
5. `scripts/run-sub-agent-real-evals.ts` 提供固定原场景复测、隔离Workspace/数据、显式真实模型开关、不覆盖已有目录、保留失败、精确凭据扫描与非零失败退出码。每次请求前后记录普通文件SHA-256，含子最终回复到结果交付之间的观测；不跟随目录项中的链接，不提供原子快照/文件隔离。未来运行在开始时记录实现哈希；本轮聚合哈希代表最终文件，不能倒推每个开发阶段加载的版本。真实出站请求另行保留实际指令。

## 所有新增样本

| 阶段 | 样本 | 结果 | 证据子目录 |
| --- | --- | --- | --- |
| 提示改进阶段 | `fork-1` | 失败 | `fork-1-dngWYZ` |
| 提示改进阶段 | `offload-1` | 失败 | `offload-1-Nv0MWS` |
| 提示改进阶段 | `collaboration-1` | 通过 | `collaboration-1-ChgoP7` |
| 提示改进阶段 | `repair-1` | 通过 | `repair-1-YReVlE` |
| 提示改进阶段 | `fork-2` | 失败 | `fork-2-Sm3B78` |
| 提示改进阶段 | `offload-2` | 失败 | `offload-2-KwqyCi` |
| 提示改进阶段 | `collaboration-2` | 通过 | `collaboration-2-AabsXK` |
| 提示改进阶段 | `repair-2` | 通过 | `repair-2-BZDB4K` |
| 读取闭环修复后 | `fork-1` | 通过 | `fork-1-OyFape` |
| 读取闭环修复后 | `offload-1` | 通过 | `offload-1-w29bGD` |
| 读取闭环修复后 | `collaboration-1` | 通过 | `collaboration-1-SQAJ0b` |
| 读取闭环修复后 | `repair-1` | 通过 | `repair-1-JufMN3` |
| 读取闭环修复后 | `fork-2` | 通过 | `fork-2-K55k3B` |
| 读取闭环修复后 | `offload-2` | 通过 | `offload-2-s4s1NL` |
| 读取闭环修复后 | `collaboration-2` | 通过 | `collaboration-2-0TBVtB` |
| 读取闭环修复后 | `repair-2` | 通过 | `repair-2-e8ZWsd` |
| 读取闭环修复后 | tmux真实CLI修复 | 通过 | `sub-agents-improvement-terminal-20261020/` |
| 读取闭环修复后 | Web原W1三子任务代码协作 | 通过 | `sub-agents-improvement-web-20261020/WEB-DTT9ti` |

前8例目录根为 `tmp/agent-evals/sub-agents-improvement-20261020/`，后8例根为 `tmp/agent-evals/sub-agents-improvement-final-20261020/`。终端与Web证据位于表中独立根下；[聚合摘要](../../tmp/agent-evals/sub-agents-improvement-report-20261020/summary.json)保留目录、计数和最终源码哈希。

## 失败保留与复测证据

### Fork检索

提示阶段两个原始Fork样本分别把父委派当作自身任务而拒绝、回答旧轮次的ACK。实际请求有持续子指令和完整父历史，失败保留；说明单靠持续指令不能保证模型选对当前目标。

增加最后追加的当前子任务边界后，同一随机标记检索原任务两次通过。没有把标记实际值塞进子prompt，既有Fork完整历史/当前委派组排除测试继续通过。两次成功不证明任意模型或长历史检索必然正确。

### 迁移内容读取

提示阶段第1例20轮耗尽，第2例顺着二次卸载引用不断展开，最终如实报告未完成。后者原始最终回复和出站工具结果保留，不能继续全部归因于模型猜偏移。

修复后两例均只用**同一个迁移引用、14次连续read_context**找到原标记，没有重新read_file/run_command。离线复核每次读取都展示正文，offset与上一nextOffset连续，无二次卸载引用；见各目录 `offline-audit.json`。原父24轮/6分钟、子上限20轮/5分钟、输出8192，角色上限和offload阈值沿用原场景。未提高上限，也未用先前更明确的顺序扫描任务替代原prompt。

### 代码协作与分工

两次CLI协作和Web原W1均有三个子任务、独立23项契约断言通过。CLI两例的子最终响应时文件哈希与父结束末态一致，父实际文件工具只写index.mjs；命令内容另行复核为验证。Web从父持久化检查点复核，父只写index.mjs并执行集成/子自测与补充验证，没有修改pricing.mjs/stock.mjs；3份子结果各持久化一次。Web本例未记录逐请求哈希，不据此声称发生过临时修改又逐字恢复。

这里的“通过”是分工、交付与独立制品验收通过，不代表所有子verification都为verified。实际仍有命令自测失败后修正、report_completion参数纠错，以及reader提前审阅时实现尚未生成而留下的blocked。CLI第2例stock子对父负责的集成记not-run/blocked，父随后完成集成。保留原状态，不把它覆写成子验收通过。

### 修复交接与tmux

两次固定修复原场景均保留首次exit1、修复后exit0及calc.mjs确认写入，原check.mjs逐字保持，扩展输入独立验收通过。第2例仍把历史失败错误地记作最终not-run，导致verification=partial；这是剩余的报告语义问题，独立验收通过不抹掉该状态。第1例父另做只读复验，未替代子修复或修改文件。

另在tmux启动真实CLI、粘贴自然语言委派，父wait至终态，实际消费handoff。独立检查4组除法输入及除零，原验收脚本未变。父最终保留未独立验证及报告参数问题，没有据子文本宣称全面验收；终端退出码0，tmux已退出。终端中仍有模型把失败报告历史解释不准确的情况，本轮不宣称汇总语言完全可靠。

## 工程门禁与证据边界

- 全量 `npm test`：**693通过，0失败/跳过**。覆盖原有独立Skill、Web/CLI权限与生命周期；本轮新增Unicode连续读取、并行预算/容量停止、部分写入交接和哈希取证。最后增强交接截断的长路径/16命令记录检查，定向4/4通过。
- lint、typecheck、build均退出0；`git diff --check`通过。开发中出现一次TypeScript闭包类型收窄错误及一次增强测试的旧期望未更新，均修正后检查通过，不计入真实模型样本。
- 真实服务仍为现有deepseek-flash配置，无密钥写入脚本/报告。50条原生运行日志runId无重复；scope=self汇总321次Provider stream调用均有usage，报告输入2,996,797、输出109,431、总计3,106,228 tokens。不重复计入父子聚合视图；调用数不是底层HTTP重试数，也不是费用核算。
- 聚合精确凭据扫描：当前配置凭据匹配0，仅代表本轮指定证据目录的精确扫描。原始模型对话、生成文件、配置和日志均忽略，不入库；报告和无凭据脚本入库候选。Web服务、tmux和运行时均关闭，清理见各根下cleanup文件。
- 当前轮未改页面组件，Web补验通过实际HTTP/SSE，不把它描述为浏览器交互复测。上一轮浏览器证据仍属上一轮。
- 请求前后哈希只证明观测时刻，不能发现一个命令内部完成并恢复的瞬时修改。主接管是模型行为指引，没有新增文件所有权或自动回滚。
- 小窗口不可压缩用户原文导致的context-capacity边界保持；上下文搜索、通用容量预诊断、无缓存对照实验尚未实施。本轮没有推送、提交或创建PR。

## 复现

```bash
npx tsx --tsconfig tsconfig.json scripts/run-sub-agent-real-evals.ts \
  --root=tmp/agent-evals/sub-agent-retest-<新的唯一目录> \
  --suite=all --repeat=2 --allow-real-model --provider=<现有Provider配置名>
```

suite可选fork/offload/collaboration/repair/all。模型请求前必须显式允许真实模型，目录已存在则拒绝覆盖；失败保留且进程退出1。不把repeat当作挑选最好结果的自动重试。Web本轮复用原始W1 HTTP评测器，脱敏源码保留在独立忽略目录 `web.source.txt`，尚未并入此入口。

最终实现SHA-256（开发阶段执行版本以请求/阶段证据为准）：

| 文件 | SHA-256 |
| --- | --- |
| `src/core/context/context-read-payload.ts` | `6d2c4204ce3ce2cdd75a482ac0f1afa600ad4a07d006e184533d0cfcaf7d6c68` |
| `src/core/context/lightweight-compaction.ts` | `d492820369d4a8280de1d06ef776c16782a118ca0edbb4ffab9839a9d9912841` |
| `src/runtime/agents/child-instructions.ts` | `0a3506c203c6195bcad8234281e99edde927894c050eac40d978371a80291c2f` |
| `src/runtime/child-execution/handoff.ts` | `884da392795885cfc98ad801fa54332907b167959c190f5ddbd3e3e204d404ea` |
| `src/runtime/child-execution/runner.ts` | `b28a59f51cdc94e413deaeb21815d25166661ab4dab4bf0128131fbab94b4a84` |
| `src/runtime/child-result-delivery.ts` | `8f1f8497e9e1b44c65a43d9f3532f51de7b419149bcdd571e5cc504d56d459a7` |
| `scripts/run-sub-agent-real-evals.ts` | `27e099cf69790d2a2e92fa61c410bfd6cb2242b8a7d799e4ff768159597a66a3` |
