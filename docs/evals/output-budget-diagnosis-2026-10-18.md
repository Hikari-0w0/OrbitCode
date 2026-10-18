# 模型输出中断诊断与预算调整（2026-10-18）

## 证据与判断

最近运行 `22dc0b06-f76c-4387-b091-7371bb710547` 在北京时间 21:56:35—21:57:01 生成简易注册登录系统。前三轮的四次工具调用均成功；第四次模型响应准备批量 `write_files`，参数增量累计 25701 字符后以非成功结束原因停止，写入尚未执行，最终为 `model-error`。本次没有调用 `report_completion`。

当前本地配置使用 DeepSeek 官方 `https://api.deepseek.com`、`deepseek-flash`、`thinking.enabled=false`；修改前未配置输出预算，Provider 请求也没有发送 `max_tokens`。当前上下文窗口配置为 1000000 tokens；这是上下文容量，不等于单次输出预算。本地工具参数上限为 2097152 字符，不是此次 25701 字符处停止的阈值。

[DeepSeek 官方 Chat Completions 文档](https://api-docs.deepseek.com/api/create-chat-completion/)在本次核对时说明：非思考模式省略 `max_tokens` 时默认输出预算为 8K tokens，可以显式设置更大的预算；总输入与输出仍受上下文窗口限制。文档区分 `length`、`content_filter`、`insufficient_system_resource` 和 `aborted` 等终止原因。

**高置信假设是上游默认输出预算不足，但历史根因尚未确证。** 历史代码把不同终止原因折叠成同一错误，没有保存原始值。字符数也不能直接换算为准确 Token 数。当前配置与官方默认值可解释现象，不能补造历史 `finish_reason=length`。

## 已实施调整

- 增加可选 YAML `max_tokens`，内部对应 `maxOutputTokens`；配置后透传 OpenAI 兼容 Chat Completions 的同名请求字段，省略时维持原服务商默认行为。
- 按本次授权，将本机未入库的 `orbitcode.yaml` 中 `deepseek-flash` 输出预算设为 `32768`。其他模型配置和本地工具参数上限未调整。
- 本地校验要求预算为正整数，不超过 1048576 且不超过所配上下文窗口；服务商实际输出上限和总上下文限制仍有效。
- 托管配置导入、保存、编辑和运行快照保留输出预算，评测模型指纹包含该值，避免调整后与旧条件误判为相同配置。当前模型表单尚无单独编辑项，配置入口为 YAML，导入后保留。
- ProviderError 增加受限结束原因字段，并将已知结束原因写入错误文案。`length` 提示配置预算、服务商默认值及分批生成建议；未知上游文本不直接写入日志或页面。
- 截断响应不发布工具调用，不执行不完整 JSON；协议错误不自动重复整个大批量生成。

## 验证

- 确定性 HTTP 替身覆盖显式 `max_tokens=32768`、四类非成功结束原因、截断参数不发布以及旧配置省略字段保持兼容。
- CLI 集成通过实际 Provider 和运行时，将约 2.5 万字符的截断工具参数重放为 `finish_reason=length`，确认未产生部分文件，具体原因与预算进入会话检查点。
- 配置导入、编辑、持久化和运行快照保持预算；非法预算被拒绝且不覆盖旧修订。
- tmux 中执行全量测试，603/603 通过，无跳过，原始退出码 0；lint、typecheck、build 和 `git diff --check` 通过。构建保留 Skills catalog 的动态文件访问 tracing 警告。
- 本地配置经正式解析器读取，确认 `deepseek-flash.maxOutputTokens=32768`。本节记录初始确定性验证，当时未调用真实模型或重跑历史任务，不能据此宣称历史任务恢复成功或已验证实际 32K 输出。后续用户授权的实际模型结果另见 [真实模型复测](output-budget-real-model-2026-10-18.md)。

后续真实运行若仍失败，优先检查新错误中的具体 `finish_reason`：只有长度终止才继续评估预算和分批生成；内容过滤或资源终止不能靠放宽本地字符限制解释。
