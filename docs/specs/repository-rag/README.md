# 仓库知识检索

本功能在授权工作区内检索 Markdown、TypeScript/TSX 源码和测试。文档入口：[需求](spec.md)、[技术计划](plan.md)、[任务](task.md)、[验收与实际结果](checklist.md)。

## 当前验证状态

2026-10-25 已验证真实 Embedding 和 Do 模式 Agent 闭环；Plan 模式遗漏检索工具白名单，原仓库包含大量范围外 tmp 文件时还会触发扫描上限。复杂问答收敛和精确引用也未全面通过，详见 [真实模型验证记录](../../evals/repository-rag-real-model-2026-10-25.md)。

## Web 使用

1. 打开“设置 → 知识检索”，选择工作区对应的配置卡片。
2. 填写兼容 embeddings API 的基础地址、模型名与向量维度。凭据填写环境变量名称；本地无鉴权服务可留空。基础地址后会追加 `/embeddings`。
3. 检查包含/排除范围。远程服务需要明确启用文本发送，构建发送片段，查询发送问题；保存配置本身不发送正文。
4. 勾选启用并保存，点击构建。随后可以在对话中用自然语言定位项目机制，查看 search_knowledge 的来源和版本，再由 Agent 阅读当前文件。
5. 修改文件后手动更新；模型、维度或前缀改变后重建。删除源文件会在查询时过滤旧正文，成功更新后移除对应片段。状态中的“可查询”只代表最近扫描版本。

高级配置可设置文档/查询前缀及资源限制。不同模型所需前缀与输入限制由用户按服务配置，不根据模型名称猜测。排序相关性不表示答案正确率。

## CLI 使用

CLI 独立运行，使用同一份托管工作区设置和索引。

```text
/knowledge status
/knowledge build
/knowledge update
/knowledge rebuild
/knowledge cancel
/knowledge delete
/knowledge off
/knowledge on
/knowledge config /absolute/path/to/local-knowledge.json
```

命令启动构建后返回作业标识；使用 status 查看结果，cancel 可附带该标识。JSON 配置仅支持凭据环境变量名或无凭据，不在命令行传入真实密钥。示例：

```json
{
  "enabled": true,
  "endpoint": "http://127.0.0.1:8000/v1",
  "model": "your-embedding-model",
  "dimensions": 1024,
  "credential": { "kind": "environment", "variable": "EMBEDDING_API_KEY" },
  "remoteEnabled": false,
  "include": ["README.md", "docs/**/*.md", "src/**/*.ts", "src/**/*.tsx", "tests/**/*.ts"],
  "exclude": [],
  "includeHistorical": false,
  "documentPrefix": "",
  "queryPrefix": "",
  "limits": {}
}
```

模型名和维度仅为配置占位，实际由所接服务决定。远程地址要求 HTTPS，并将 remoteEnabled 设为 true 表示允许发送所选材料。凭据和此配置均保存在未入库的本地位置。

## 降级与排错

- 尚未构建：先 build；配置不兼容或索引损坏：rebuild。
- 文件过期：更新索引或用原有文件工具读取当前源码。
- 语义服务失败或本轮语义请求额度耗尽：关键词索引有效时明确降级，不会把服务失败当作正常零命中。
- 同工作区构建冲突：查看另一作业状态或取消后重试。进程中断保留旧完整版本，不自动续跑计费请求。
- 显式读取拒绝、敏感文件及工作区边界继续生效。检索资料不能授权执行指令。

私密索引位于当前数据根的 knowledge-v1 下，不进入 Git；默认不记录完整查询或正文。停用保留索引，删除清除索引并让在途旧作业失效。

## 评估

```bash
npm test
npm test -- scripts/knowledge-eval-metrics.test.ts
npx tsx scripts/run-knowledge-evals.ts --mode fixture
npx tsx scripts/run-knowledge-evals.ts --mode provider --config /absolute/path/to/private-config.json --split test
npx tsx scripts/run-knowledge-agent-evals.ts --data-dir /absolute/path/to/private-data --workspace workspace-id --split test --take 5 --repetitions 3 --output /absolute/path/to/new-private-report.json
```

provider 与 Agent 模式会调用显式配置的服务，按预算运行并可能产生费用；fixture 模式使用确定性词法向量，仅验证流程和指标。Agent 对照会创建临时隔离设置，将工作区限定到固定合成语料的临时副本，并预创建只读 Plan 会话，分别运行关闭/开启 RAG；报告中的答案正确性、引用支持度与任务通过率等待人工按 rubric 评定，不自动判定通过。

真实质量与已执行验证见 [评估记录](../../evals/repository-rag.md)。
