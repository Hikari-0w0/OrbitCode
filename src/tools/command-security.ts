export type CommandSecuritySettings = {
  readonly network: "allow" | "deny";
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs: number;
  readonly maxScanEntries: number;
  readonly temporaryDirectory: "isolated" | "workspace" | "short";
  readonly readOnlyRoots: readonly string[];
  readonly writableRoots: readonly string[];
  readonly commandPreflight: "strict" | "off";
  readonly npmrcAccess: "blocked" | "public-only";
  readonly environmentFileAccess: "blocked" | "allow";
  readonly macosAncestorDirectoryAccess: "metadata" | "read";
  readonly preferFileTools: boolean;
  readonly maxCommandChars: number;
  readonly outputLimitBytes: number;
  readonly maxProcesses: number;
  readonly processLogBytes: number;
  readonly defaultReadyTimeoutMs: number;
  readonly maxReadyTimeoutMs: number;
};

export const DEFAULT_COMMAND_SECURITY: CommandSecuritySettings = {
  network: "allow",
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 120_000,
  maxScanEntries: 250_000,
  temporaryDirectory: "isolated",
  readOnlyRoots: [],
  writableRoots: [],
  commandPreflight: "strict",
  npmrcAccess: "blocked",
  environmentFileAccess: "blocked",
  macosAncestorDirectoryAccess: "metadata",
  preferFileTools: true,
  maxCommandChars: 8192,
  outputLimitBytes: 128 * 1024,
  maxProcesses: 4,
  processLogBytes: 128 * 1024,
  defaultReadyTimeoutMs: 10000,
  maxReadyTimeoutMs: 30000,
};

export const EVALUATION_COMMAND_SECURITY: CommandSecuritySettings = {
  ...DEFAULT_COMMAND_SECURITY,
  defaultTimeoutMs: 120000, maxTimeoutMs: 900000, maxScanEntries: 1000000,
  temporaryDirectory: "short", commandPreflight: "off", npmrcAccess: "public-only", environmentFileAccess: "allow", macosAncestorDirectoryAccess: "read", preferFileTools: false,
  maxCommandChars: 32768, outputLimitBytes: 1024 * 1024,
  maxProcesses: 16, processLogBytes: 1024 * 1024, defaultReadyTimeoutMs: 60000, maxReadyTimeoutMs: 300000,
};

export function parseCommandSecurity(value: unknown): CommandSecuritySettings {
  if (value === undefined) return { ...DEFAULT_COMMAND_SECURITY, readOnlyRoots: [], writableRoots: [] };
  if (!record(value)) throw new Error("命令安全配置必须为对象。");
  const input = value;
  if (Object.keys(input).some(key => !Object.hasOwn(DEFAULT_COMMAND_SECURITY, key))) throw new Error("命令安全配置含未知字段。");
  const network = input.network === undefined ? DEFAULT_COMMAND_SECURITY.network : input.network;
  const temporaryDirectory = input.temporaryDirectory === undefined ? DEFAULT_COMMAND_SECURITY.temporaryDirectory : input.temporaryDirectory;
  if (network !== "allow" && network !== "deny") throw new Error("命令网络必须为 allow 或 deny。");
  if (temporaryDirectory !== "isolated" && temporaryDirectory !== "workspace" && temporaryDirectory !== "short") throw new Error("临时目录模式无效。");
  const commandPreflight = input.commandPreflight === undefined ? "strict" : input.commandPreflight;
  const npmrcAccess = input.npmrcAccess === undefined ? "blocked" : input.npmrcAccess;
  const environmentFileAccess = input.environmentFileAccess === undefined ? "blocked" : input.environmentFileAccess;
  const macosAncestorDirectoryAccess = input.macosAncestorDirectoryAccess === undefined ? "metadata" : input.macosAncestorDirectoryAccess;
  const preferFileTools = input.preferFileTools === undefined ? true : input.preferFileTools;
  if (commandPreflight !== "strict" && commandPreflight !== "off") throw new Error("命令格式预检选项无效。");
  if (npmrcAccess !== "blocked" && npmrcAccess !== "public-only") throw new Error("npmrc读取选项无效。");
  if (environmentFileAccess !== "blocked" && environmentFileAccess !== "allow") throw new Error("环境文件访问选项无效。");
  if (macosAncestorDirectoryAccess !== "metadata" && macosAncestorDirectoryAccess !== "read") throw new Error("macOS祖先目录访问选项无效。");
  if (typeof preferFileTools !== "boolean") throw new Error("文件工具偏好必须为布尔值。");
  const integer = (key: keyof CommandSecuritySettings, min: number, max: number) => {
    const entry = input[key] === undefined ? DEFAULT_COMMAND_SECURITY[key] : input[key];
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < min || entry > max) throw new Error(`${key} 超出允许范围 ${min}–${max}。`);
    return entry;
  };
  const defaultTimeoutMs = integer("defaultTimeoutMs", 100, 86_400_000);
  const maxTimeoutMs = integer("maxTimeoutMs", 100, 86_400_000);
  if (defaultTimeoutMs > maxTimeoutMs) throw new Error("默认命令时限不能超过最长命令时限。");
  const roots = (key: "readOnlyRoots" | "writableRoots") => {
    const entries = input[key] === undefined ? [] : input[key];
    if (!Array.isArray(entries) || entries.length > 32 || !entries.every((root: unknown): root is string =>
      typeof root === "string" && root.length <= 4096 && !root.includes("\0") && (root.startsWith("/") || /^[A-Za-z]:[\\/]/.test(root)))) throw new Error("授权目录必须为绝对路径数组，最多32项。");
    return [...new Set(entries)];
  };
  const defaultReadyTimeoutMs = integer("defaultReadyTimeoutMs", 100, 1800000);
  const maxReadyTimeoutMs = integer("maxReadyTimeoutMs", 100, 1800000);
  if (defaultReadyTimeoutMs > maxReadyTimeoutMs) throw new Error("进程默认就绪时限不能超过最长就绪时限。");
  return { network, temporaryDirectory, defaultTimeoutMs, maxTimeoutMs, maxScanEntries: integer("maxScanEntries", 1000, 5_000_000),
    readOnlyRoots: roots("readOnlyRoots"), writableRoots: roots("writableRoots"), commandPreflight, npmrcAccess, environmentFileAccess, macosAncestorDirectoryAccess, preferFileTools,
    maxCommandChars: integer("maxCommandChars", 128, 65536),
    outputLimitBytes: integer("outputLimitBytes", 1024, 16 * 1024 * 1024), maxProcesses: integer("maxProcesses", 1, 64),
    processLogBytes: integer("processLogBytes", 1024, 16 * 1024 * 1024), defaultReadyTimeoutMs, maxReadyTimeoutMs };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
