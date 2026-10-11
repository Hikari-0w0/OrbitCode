import { homedir } from "node:os";
import path from "node:path";
import { parseDocument, isAlias, visit } from "yaml";
import { isObject } from "@/mcp/messages";
import { mcpDigest } from "@/lib/mcp-redaction";

export type McpServerConfig =
  | { readonly type: "stdio"; readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>> }
  | { readonly type: "http"; readonly url: string; readonly headers: Readonly<Record<string, string>> };
export type ResolvedMcpServer = {
  readonly name: string;
  readonly workspaceRoot: string;
  readonly configurationId: string;
  readonly config: McpServerConfig;
  readonly secrets: readonly string[];
};
export type McpConfigSnapshot = { readonly servers: readonly ResolvedMcpServer[]; readonly diagnostics: readonly { serverName: string; detail: string }[] };
export type McpConfigOptions = {
  readonly workspaceRoot: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly userHome?: string;
  readonly readText?: (file: string) => Promise<string>;
};
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED_HEADERS = new Set(["host", "content-length", "connection", "accept", "content-type", "mcp-session-id", "mcp-protocol-version"]);
export async function loadMcpConfig(options: McpConfigOptions): Promise<McpConfigSnapshot> {
  const diagnostics: { serverName: string; detail: string }[] = [];
  const read = options.readText ?? (async (file: string) => {
    // 有界读取避免先把任意大的配置载入内存。
    const { open } = await import("node:fs/promises");
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(256 * 1024 + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 256 * 1024) throw new Error("配置超过大小上限。");
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally { await handle.close(); }
  });
  const layer = async (file: string): Promise<Record<string, unknown> | undefined> => {
    try {
      const source = await read(file);
      if (Buffer.byteLength(source) > 256 * 1024) throw new Error();
      const document = parseDocument(source, { uniqueKeys: true, prettyErrors: false });
      if (document.errors.length) throw new Error();
      visit(document, (_key, node) => { if (isAlias(node)) throw new Error(); });
      const value: unknown = document.toJS({ maxAliasCount: 0 });
      if (!isObject(value) || Object.keys(value).some((k) => k !== "mcpServers") || !isObject(value.mcpServers)) throw new Error();
      return value.mcpServers;
    } catch (error) {
      if (isObject(error) && error.code === "ENOENT") return {};
      return undefined;
    }
  };
  const user = await layer(path.join(options.userHome ?? homedir(), ".orbitcode/mcp.yaml"));
  const project = await layer(path.join(options.workspaceRoot, ".orbitcode/mcp.yaml"));
  if (!user) diagnostics.push({ serverName: "用户配置", detail: "用户 MCP 配置无法安全读取，已忽略该层。" });
  if (!project) return { servers: [], diagnostics: [...diagnostics, { serverName: "项目配置", detail: "项目 MCP 配置无法安全读取，本工作区 MCP 已禁用。" }] };
  const merged = new Map([...Object.entries(user ?? {}), ...Object.entries(project)]);
  if (merged.size > 32) return { servers: [], diagnostics: [{ serverName: "配置", detail: "MCP Server 数量超过 32 个，本工作区 MCP 已禁用。" }] };
  const servers: ResolvedMcpServer[] = [];
  for (const [name, raw] of [...merged].sort(([a], [b]) => a.localeCompare(b))) {
    try {
      if (!SERVER_NAME.test(name)) throw new Error("Server 名无效。");
      const secrets: string[] = [];
      const config = parseServer(raw, options.environment, secrets);
      servers.push({ name, workspaceRoot: options.workspaceRoot, config, secrets, configurationId: mcpDigest({ workspaceRoot: options.workspaceRoot, config }) });
    } catch (error) {
      diagnostics.push({ serverName: SERVER_NAME.test(name) ? name : "无效名称", detail: error instanceof ConfigError ? error.message : "MCP Server 配置无效。" });
    }
  }
  return { servers, diagnostics };
}
class ConfigError extends Error {}
function invalid(): never { throw new ConfigError("MCP Server 配置字段、类型或长度无效。"); }
function string(value: unknown, max: number, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.includes("\0") || Buffer.byteLength(value) > max) invalid();
  return value;
}
function parseServer(raw: unknown, environment: McpConfigOptions["environment"], secrets: string[]): McpServerConfig {
  if (!isObject(raw)) invalid();
  const map = (value: unknown, headers: boolean): Record<string, string> => {
    if (value === undefined) return {};
    if (!isObject(value)) invalid();
    const result: Record<string, string> = Object.create(null);
    for (const [key, rawValue] of Object.entries(value)) {
      if (headers ? !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) : !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) invalid();
      const name = headers ? key.toLowerCase() : key;
      if (Object.hasOwn(result, name) || (headers && RESERVED_HEADERS.has(name))) invalid();
      const source = string(rawValue, 16 * 1024, true);
      const expanded = source.replace(/\$\{([^}]*)\}/g, (_all, variable: string) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) invalid();
        const resolved = environment[variable];
        if (resolved === undefined) throw new ConfigError(`MCP ${headers ? "headers" : "env"} 引用未定义变量：${variable}。`);
        secrets.push(resolved);
        return resolved;
      });
      string(expanded, 16 * 1024, true);
      if (headers && /[\r\n]/.test(expanded)) invalid();
      result[name] = expanded;
      secrets.push(expanded);
    }
    return result;
  };
  if (raw.type === "stdio") {
    if (Object.keys(raw).some((k) => !["type", "command", "args", "env"].includes(k))) invalid();
    const args = raw.args ?? [];
    if (!Array.isArray(args) || args.length > 128) invalid();
    const inherited: Record<string, string> = {};
    for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]) if (environment[name] !== undefined) inherited[name] = string(environment[name], 16 * 1024, true);
    return { type: "stdio", command: string(raw.command, 4096), args: args.map((a) => string(a, 4096, true)), env: { ...inherited, ...map(raw.env, false) } };
  }
  if (raw.type === "http") {
    if (Object.keys(raw).some((k) => !["type", "url", "headers"].includes(k))) invalid();
    const url = new URL(string(raw.url, 8192));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) invalid();
    for (const value of url.searchParams.values()) if (value) secrets.push(value, encodeURIComponent(value));
    return { type: "http", url: url.href, headers: map(raw.headers, true) };
  }
  return invalid();
}
