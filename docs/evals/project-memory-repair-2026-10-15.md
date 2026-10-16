# 项目记忆失败修复与真实复验（2026-10-15）

## 结果

用户明确授权修复后，已修复首次真实测试暴露的异步结果表述、纠正目标选择和旧笔记重复提取问题。**最终版本 5 个往返场景与 1 个独立空记忆场景，6/6 独立检查通过；确定性测试 506/506，lint、typecheck、build 均退出 0。**

这是当前 DeepSeek Flash、固定小型工作区与有限轮次的验收结果，不是任意模型或长期自动记忆质量的保证。修复前失败记录保留于 [首次测试报告](project-memory-real-model-2026-10-15.md)。

## 修复内容与边界

1. 前台系统约束明确：本轮最终回复生成时，自动笔记尚未异步提取，不能声称已保存、已记住或已更新长期记忆。无可用事实记忆时应回答未知，项目代号不替代文件事实。只有当前轮次存在有效索引时注册 read_memory，避免空索引时编造 memory://index。
2. 提取输入仅使用当前用户表达与新的工具观察，不再把助手自述或 read_memory 旧正文作为新事实来源。纯旧记忆查询且没有新增记忆要求时，直接返回空候选，不请求提取模型；普通新偏好声明仍可提取。明显偏好问句不能被当作新的偏好声明。
3. 纠正默认允许独立记录新事实和失效旧值，不要求一定替代旧笔记。替代时只能选择本轮实际提供的同项目目标，解析层与存储层均校验。提取前后的目标 hash 必须一致；模型等待期间人工修改过的目标拒绝覆盖。
4. 合法数组中的候选逐条校验，非法项拒绝并显示数量，其余有效项继续按既有作用域事务提交；全非法仍失败。没有自动修补来源、转换类别、扩大用户级记忆范围、放宽权限或增加模型重试。

这些改动复用现有 runtime、提示组装、权限和存储，不新增运行时依赖，不改变会话或 Markdown 格式。关闭、删除、取消与来源存活检查仍由原提交守卫保护。

## 独立验收

最终场景运行后，由测试控制端检查实际 scope 笔记、read_memory 返回及前后完整快照，不以最终回复的自述判定保存成功。原始检查结果为 acceptance.json。

| 检查 | 观察到的结果 |
| --- | --- |
| 偏好与项目事实分别保存 | 首轮 user 1 条、project 1 条；项目笔记含 MARBLE-82 和真实 tool-observed 来源 |
| 新会话读取原值 | 无历史的新会话通过 read_memory 读出偏好与 MARBLE-82；笔记快照未改变 |
| 纠正保存与新会话读取 | 重新读取外部更新的 README 后保存 correction；下一新会话实际读出 MARBLE-93，并说明 MARBLE-82 失效；纯查询未增加笔记 |
| 用户偏好复用与项目隔离 | 第二项目 user 1 条、project 0 条；读取到偏好，未读到第一项目标记 |
| 前台保存与纯查询不再提取 | 5 轮均 final-response/saved；只有初次声明和纠正请求了提取模型，3 个纯记忆查询零提取请求 |
| 无事实记忆时明确未知 | 独立空记忆场景 user/project 均 0 条；模型明确回答“未知”，没有调用任何工具，没有用代号填补事实 |

人工复核：首轮和纠正回复都明确区分“理解本轮要求/核实当前文件”与“长期记忆是否写入”，没有把本轮异步写入说成已完成。普通读取仍遵守项目 instructions 的蓝鹭代号及 include 后缀。

## 证据与运行标识

所有原始记录均在忽略的 tmp/agent-evals 下，使用独立 data 和 Workspace，只读取当前项目配置以解析模型凭据，不改日常设置或笔记。

- 最终五场景：`tmp/agent-evals/project-memory-real-vgvdO1/`。
- 最终空记忆：`tmp/agent-evals/project-memory-real-74aJ21/`。
- metadata.json 保存模型、源码 SHA-256 与记录的调用数；requests.jsonl 是脱敏请求；extraction-outputs.jsonl 是候选响应；results.json 与 data/logs 保存实际笔记、工具证据及 runId。
- acceptance.json 与 acceptance.py.txt 为独立检查结果及本机检查脚本；runner.ts.txt 保存本机运行脚本，归档扩展名避免参与项目 lint/build。

| 场景 | runId | conversationId |
| --- | --- | --- |
| seed | 717e0369-446d-45de-a664-a97b846f768c | 691e9658-e3ac-4bb5-8d6a-306558fbe91b |
| fresh-session | 50df1466-871a-457d-b490-df0e2bf9d7bf | 95c1c64e-7fd2-485c-9237-8036cf702e26 |
| correction | a5fed96a-3c03-448d-aa62-cf09c260d15e | 691e9658-e3ac-4bb5-8d6a-306558fbe91b |
| after-correction | 7ae56890-1297-4df3-9aab-eda2fea0764e | cc17482e-d592-4baf-a41d-50ed3920f1fe |
| other-project | 1a58ed3c-90fa-4f8f-83fb-d628cc65a314 | 71b70c8f-57ff-47a3-8ceb-2013ae979877 |
| missing-fact | e2618b48-1689-4d35-b185-a5ae39565cb1 | 7ebd9977-6c15-44de-91f4-5176164178e2 |

最终六轮记录 14 次模型 stream 调用，其中五场景 12 次、空记忆 2 次；不是供应商 HTTP 重试或计费请求数。本轮修复期间共运行 27 轮前台对话，另 21 轮属于中间版本，不能计入最终 6/6。中间版本发现的重复候选、把“此前记住”的问句误判为新增记忆意图，以及空索引误调用均保留在原始证据中，并加入了相应修复/回归；不把中间版本与最终版本当成相同条件下的统计对照。

本轮中间目录：project-memory-real-VWtaGP、LW1ST6、XIaWSW、iFrAiY、SRKKuw（后四项同用 project-memory-real- 前缀）。

## 回归与剩余限制

- `npm test`：退出 0，506/506，无跳过或取消；`/tmp/orbitcode-memory-repair-tests.txt`。
- `npm run lint` → `npm run typecheck` → `npm run build`：依次退出 0；`/tmp/orbitcode-memory-repair-build.txt`。
- `python3 /tmp/orbitcode-memory-repair-acceptance.py`：退出 0，6/6。
- 当前配置凭据精确扫描：365 个证据/报告文件，0 匹配；credential-scan.json 保存计数，不输出凭据。
- 来源隔离、同作用域目标、混合非法候选、人工修改竞争和纯查询零请求均有确定性回归。此前权限、取消、CAS、容量和进程恢复检查继续通过。

纯查询识别采用保守的意图和工具组合判断，不是完整的自然语言语义解析；复合表达、不同语言和新的偏好改写仍可能需要进一步评测。程序没有证明所有同义句均能去重，也没有证明任意新事实都一定被模型提取。提供的目标集合与 hash 检查可以阻止跨作用域或人工更新覆盖，但不等于证明任意替代目标在语义上都正确。

本轮通过实际共享 Runtime 与真实模型验证，没有重新启动浏览器或 tmux UI；页面与 CLI 适配未新增改动，既有替身验收与本轮全量入口测试继续保留。真实测试进程已结束，未提交或推送代码。
