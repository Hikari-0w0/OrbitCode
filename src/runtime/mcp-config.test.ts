import assert from "node:assert/strict";
import test from "node:test";
import { loadMcpConfig } from "./mcp-config";
const options = { workspaceRoot: "/workspace", userHome: "/user", environment: { TEST_TOKEN: "fake-token", HOME: "/home" } };
test("MCP 配置整项覆盖并展开凭据，不继承旧字段", async () => {
  const result = await loadMcpConfig({ ...options, readText: async (file) => file.startsWith("/user")
    ? 'mcpServers:\n  demo:\n    type: stdio\n    command: old\n    env: {OLD: value}\n'
    : 'mcpServers:\n  demo:\n    type: http\n    url: https://example.com/mcp\n    headers: {Authorization: "Bearer ${TEST_TOKEN}"}\n' });
  assert.equal(result.servers.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(result.servers[0].config)), { type: "http", url: "https://example.com/mcp", headers: { authorization: "Bearer fake-token" } });
  assert.equal(result.diagnostics.length, 0);
});
test("无效项目覆盖不回落，缺失变量与重复键安全失败", async () => {
  for (const project of ['mcpServers: {demo: {type: bad}}', 'mcpServers: {demo: {type: stdio, command: node, env: {X: "${MISSING}"}}}', 'mcpServers: {}\nmcpServers: {}']) {
    const result = await loadMcpConfig({ ...options, readText: async (file) => file.startsWith("/user") ? 'mcpServers: {demo: {type: stdio, command: node}}' : project });
    assert.equal(result.servers.length, 0);
    assert.ok(result.diagnostics.length);
    assert.ok(!JSON.stringify(result.diagnostics).includes("fake-token"));
  }
});
test("缺文件为空；禁止 alias、越权 headers 与控制字符", async () => {
  const missing = await loadMcpConfig({ ...options, readText: async () => { throw Object.assign(new Error(), { code: "ENOENT" }); } });
  assert.deepEqual(missing, { servers: [], diagnostics: [] });
  for (const project of ['mcpServers: {a: &a {type: stdio, command: node}, b: *a}', 'mcpServers: {demo: {type: http, url: "https://example.com", headers: {Host: evil}}}']) {
    const result = await loadMcpConfig({ ...options, readText: async () => project });
    assert.equal(result.servers.length, 0);
  }
});

test("变量只展开一次、空值保留；全部有效配置字段参与身份和容量校验", async () => {
  const { stringify } = await import("yaml");
  const raw = { type: "stdio", command: "${COMMAND}", args: ["${ARG}"], env: { EMPTY: "${EMPTY}", NESTED: "${NESTED}" } };
  const load = (value: unknown, environment = { EMPTY: "", NESTED: "${UNEXPANDED}", PATH: "/bin" }) => loadMcpConfig({ ...options, environment, readText: async (p) => p.startsWith("/user") ? "mcpServers: {user: {type: stdio, command: node}}" : stringify({ mcpServers: { demo: value } }) });
  const first = await load(raw); assert.equal(first.servers.length, 2);
  const demo = first.servers.find(s => s.name === "demo")!;
  assert.equal(demo.config.type, "stdio");
  if (demo.config.type === "stdio") { assert.equal(demo.config.env.EMPTY, ""); assert.equal(demo.config.env.NESTED, "${UNEXPANDED}"); assert.equal(demo.config.command, "${COMMAND}"); assert.deepEqual(demo.config.args, ["${ARG}"]); }
  for (const value of [{ ...raw, command: "other" }, { ...raw, args: [] }, { ...raw, env: {} }]) assert.notEqual((await load(value)).servers[0].configurationId, demo.configurationId);
  assert.notEqual((await load(raw, { EMPTY: "", NESTED: "${UNEXPANDED}", PATH: "/other" })).servers[0].configurationId, demo.configurationId);
  for (const value of [{ type: "http", url: "file:///tmp/x" }, { type: "http", url: "https://user:password@example.com" }, { type: "stdio", command: "node", args: Array(129).fill("x") }]) assert.equal((await load(value)).servers.length, 1);
  const over = await loadMcpConfig({ ...options, readText: async () => stringify({ mcpServers: Object.fromEntries(Array.from({length: 33}, (_,i) => [`s${i}`, {type: "stdio",command:"node"}])) }) });
  assert.equal(over.servers.length, 0);
  assert.equal((await loadMcpConfig({ ...options, readText: async () => "x".repeat(256*1024+1) })).servers.length, 0);
});
