import path from "node:path";

const MAX_SCAN_DEPTH = 4;
const MAX_TOKENS = 512;
const MAX_COMMAND_LENGTH = 8 * 1024;

export type DangerousCommandAnalysis =
  | { readonly safe: true }
  | {
      readonly safe: false;
      readonly code:
        | "destructive-filesystem"
        | "disk-device"
        | "system-control"
        | "process-control"
        | "security-control"
        | "resource-exhaustion"
        | "analysis-limit";
      readonly message: string;
    };

export function analyzeDangerousCommand(
  command: string,
  canonicalCwd = ".",
): DangerousCommandAnalysis {
  return analyze(command, canonicalCwd, 0);
}

function analyze(
  command: string,
  canonicalCwd: string,
  depth: number,
): DangerousCommandAnalysis {
  if (command.length === 0 || command.length > MAX_COMMAND_LENGTH || depth > MAX_SCAN_DEPTH) {
    return denied("analysis-limit", "命令超过危险操作分析边界。");
  }
  if (/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:[^}]*\}\s*;?\s*:/u.test(command)) {
    return denied("resource-exhaustion", "命令包含进程耗尽操作。");
  }
  const substitutions = extractStaticSubstitutions(command);
  if (!substitutions.ok) {
    return denied("analysis-limit", "命令包含无法安全分析的 shell 结构。");
  }
  for (const nested of substitutions.values) {
    const result = analyze(nested, canonicalCwd, depth + 1);
    if (!result.safe) return result;
  }
  const tokenized = tokenizeShell(command);
  if (!tokenized.ok || tokenized.segments.flat().length > MAX_TOKENS) {
    return denied("analysis-limit", "命令包含无法安全分析的 shell 结构。");
  }
  for (const segment of tokenized.segments) {
    const result = analyzeSegment(segment, canonicalCwd, depth);
    if (!result.safe) return result;
  }
  return { safe: true };
}

function analyzeSegment(
  rawTokens: readonly string[],
  canonicalCwd: string,
  depth: number,
): DangerousCommandAnalysis {
  const tokens = stripCommandPrefixes(rawTokens);
  if (tokens.length === 0) return { safe: true };
  const executable = path.posix.basename(tokens[0]);
  const args = tokens.slice(1);

  if (["sudo", "su", "doas"].includes(executable)) {
    return denied("security-control", "命令尝试提升或切换系统权限。");
  }
  if (["shutdown", "reboot", "halt", "poweroff"].includes(executable)) {
    return denied("system-control", "命令尝试停止或重启系统。");
  }
  if (["mkfs", "newfs", "fdisk", "parted"].includes(executable)) {
    return denied("disk-device", "命令尝试修改磁盘或文件系统。");
  }
  if (executable === "diskutil" && args.some((arg) => /^(erase|partition|zeroDisk|secureErase)/u.test(arg))) {
    return denied("disk-device", "命令尝试擦除或重新分区磁盘。");
  }
  if (executable === "dd" && args.some((arg) => /^of=\/dev\//u.test(arg))) {
    return denied("disk-device", "命令尝试直接写入设备。");
  }
  if (executable === "rm" && isBroadRecursiveRemoval(args, canonicalCwd)) {
    return denied("destructive-filesystem", "命令尝试递归删除系统或 Workspace 根范围。");
  }
  if (["chmod", "chown", "chgrp"].includes(executable) && isBroadRecursiveChange(args, canonicalCwd)) {
    return denied("destructive-filesystem", "命令尝试递归修改系统或 Workspace 根权限。");
  }
  if (executable === "find" && canonicalCwd === "." && args.includes("-delete") && args.some(isWorkspaceRootTarget)) {
    return denied("destructive-filesystem", "命令尝试删除整个 Workspace 范围。");
  }
  if (executable === "git" && args[0] === "clean" && hasShortFlag(args.slice(1), "f") && hasShortFlag(args.slice(1), "x")) {
    return denied("destructive-filesystem", "命令尝试不可恢复地清理全部未跟踪文件。");
  }
  if (["killall", "pkill"].includes(executable)) {
    return denied("process-control", "命令尝试广域终止进程。");
  }
  if (executable === "kill" && args.some((arg) => arg === "-1" || arg === "-9" || arg === "-KILL") && args.includes("-1")) {
    return denied("process-control", "命令尝试广域终止进程。");
  }
  if (["csrutil", "visudo"].includes(executable) || (executable === "spctl" && args.includes("--master-disable"))) {
    return denied("security-control", "命令尝试修改系统安全控制。");
  }
  if (executable === "launchctl" && args.some((arg) => ["bootout", "unload", "remove"].includes(arg))) {
    return denied("system-control", "命令尝试停止系统服务。");
  }
  if (executable === "ulimit" && args.some((arg) => arg === "-u" || arg === "-n")) {
    return denied("resource-exhaustion", "命令尝试修改进程资源边界。");
  }
  if (["sh", "bash", "zsh", "dash"].includes(executable)) {
    const commandIndex = args.findIndex((arg) => arg === "-c");
    if (commandIndex >= 0) {
      const nested = args[commandIndex + 1];
      if (!nested) return denied("analysis-limit", "shell -c 缺少可分析命令。");
      return analyze(nested, canonicalCwd, depth + 1);
    }
  }
  if (executable === "eval") {
    const nested = args.join(" ");
    if (nested.includes("$") || nested.includes("`")) {
      return denied("analysis-limit", "eval 包含动态且无法安全分析的内容。");
    }
    return analyze(nested, canonicalCwd, depth + 1);
  }
  return { safe: true };
}

function stripCommandPrefixes(tokens: readonly string[]): readonly string[] {
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index])) index += 1;
  if (tokens[index] === "env") {
    index += 1;
    while (index < tokens.length && (/^-/u.test(tokens[index]) || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index]))) index += 1;
  }
  if (tokens[index] === "command" || tokens[index] === "builtin") index += 1;
  return tokens.slice(index);
}

function isBroadRecursiveRemoval(args: readonly string[], canonicalCwd: string): boolean {
  const recursive = hasShortFlag(args, "r") || args.includes("--recursive");
  const force = hasShortFlag(args, "f") || args.includes("--force");
  if (!recursive || !force) return false;
  const targets = args.filter((arg) => !arg.startsWith("-"));
  return targets.some((target) => isSystemRootTarget(target) || (canonicalCwd === "." && isWorkspaceRootTarget(target)));
}

function isBroadRecursiveChange(args: readonly string[], canonicalCwd: string): boolean {
  const recursive = hasShortFlag(args, "R") || args.includes("--recursive");
  if (!recursive) return false;
  return args.some((target) => isSystemRootTarget(target) || (canonicalCwd === "." && isWorkspaceRootTarget(target)));
}

function hasShortFlag(args: readonly string[], flag: string): boolean {
  return args.some((arg) => arg.startsWith("-") && !arg.startsWith("--") && arg.slice(1).includes(flag));
}

function isSystemRootTarget(value: string): boolean {
  return ["/", "/*", "~", "~/*", "$HOME", "${HOME}", "$HOME/*", "${HOME}/*"].includes(value);
}

function isWorkspaceRootTarget(value: string): boolean {
  return [".", "./", "./*", "*"].includes(value);
}

type TokenizeResult =
  | { readonly ok: true; readonly segments: readonly (readonly string[])[] }
  | { readonly ok: false };

function tokenizeShell(source: string): TokenizeResult {
  const segments: string[][] = [[]];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const flush = (): void => {
    if (token.length > 0) segments[segments.length - 1].push(token);
    token = "";
  };
  const split = (): void => {
    flush();
    if (segments[segments.length - 1].length > 0) segments.push([]);
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      flush();
      continue;
    }
    if (char === ";" || char === "|" || char === "&" || char === "\n") {
      split();
      if ((char === "|" || char === "&") && source[index + 1] === char) index += 1;
      continue;
    }
    token += char;
  }
  if (escaped || quote) return { ok: false };
  flush();
  return { ok: true, segments: segments.filter((segment) => segment.length > 0) };
}

type SubstitutionResult =
  | { readonly ok: true; readonly values: readonly string[] }
  | { readonly ok: false };

function extractStaticSubstitutions(source: string): SubstitutionResult {
  const values: string[] = [];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "`") {
      const close = source.indexOf("`", index + 1);
      if (close < 0) return { ok: false };
      values.push(source.slice(index + 1, close));
      index = close;
      continue;
    }
    if (source[index] !== "$" || source[index + 1] !== "(") continue;
    let depth = 1;
    let cursor = index + 2;
    for (; cursor < source.length && depth > 0; cursor += 1) {
      if (source[cursor] === "(") depth += 1;
      else if (source[cursor] === ")") depth -= 1;
    }
    if (depth !== 0) return { ok: false };
    values.push(source.slice(index + 2, cursor - 1));
    index = cursor - 1;
  }
  return { ok: true, values };
}

function denied(
  code: Exclude<DangerousCommandAnalysis, { readonly safe: true }>["code"],
  message: string,
): DangerousCommandAnalysis {
  return { safe: false, code, message };
}
