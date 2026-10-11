# MCP 验证替身

这些替身只用于自动测试；不需要真实凭据或模型。

- `stdio-server.mjs`：initialize、tools/list、echo；`fail` 返回工具错误，`hang` 不响应，`exit` 退出，`malformed` 输出非法帧。可通过测试环境记录启动 PID 与方法名，不记录参数或环境。
- `host.ts`：启动忽略 TERM 的子进程，验证 SIGINT、SIGTERM 及宿主立即退出时的回收。
- HTTP 替身在 `tests/helpers/mcp-fixture.ts` 和 `src/mcp/http-transport.test.ts` 中使用随机回环端口，复用已有 HTTP 测试基础设施。
- 模型替身复用 `tests/helpers/openai-mock.ts`；没有新增 Provider 或运行时依赖。

运行 `npm test -- tests/mcp-e2e.test.ts src/cli/mcp-session.test.ts src/runtime/mcp-host.test.ts`。真实模型与浏览器验收另见 `docs/specs/mcp-client/checklist.md`；测试产物和临时 MCP 配置不入库。
