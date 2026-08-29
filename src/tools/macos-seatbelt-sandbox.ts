import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  CommandExecution,
  CommandRequest,
  CommandSandbox,
  SandboxAvailability,
} from "@/tools/command-sandbox";
import { isProtectedPath } from "@/tools/protected-paths";
import type { WorkspaceBoundary } from "@/tools/types";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const SHELL = "/bin/sh";
const TERMINATION_GRACE_MS = 250;

export class MacOsSeatbeltCommandSandbox implements CommandSandbox {
  private readonly probes = new Map<string, Promise<SandboxAvailability>>();

  probe(workspace: WorkspaceBoundary): Promise<SandboxAvailability> {
    const existing = this.probes.get(workspace.root);
    if (existing) return existing;
    const pending = this.performProbe(workspace).catch(() => ({
      available: false as const,
      message: "严格命令隔离能力探测失败。",
    }));
    this.probes.set(workspace.root, pending);
    return pending;
  }

  async run(
    request: CommandRequest,
    options: { readonly workspace: WorkspaceBoundary; readonly signal: AbortSignal },
  ): Promise<CommandExecution> {
    const availability = await this.probe(options.workspace);
    if (!availability.available) {
      throw new SandboxUnavailableError(availability.message);
    }
    return this.runIsolated(request, options.workspace, options.signal);
  }

  private async performProbe(
    workspace: WorkspaceBoundary,
  ): Promise<SandboxAvailability> {
    if (process.platform !== "darwin") {
      return { available: false, message: "当前平台没有可用的严格命令隔离后端。" };
    }
    try {
      const executable = await lstat(SANDBOX_EXEC);
      if (!executable.isFile()) throw new Error("sandbox-exec is not a file");
    } catch {
      return { available: false, message: "系统未提供可验证的 Seatbelt 执行器。" };
    }

    const runtimeRoot = path.join(workspace.root, ".orbitcode-runtime");
    const probeRoot = path.join(runtimeRoot, `probe-${randomUUID()}`);
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "orbitcode-sandbox-probe-"));
    const outsideFile = path.join(outsideRoot, "outside.txt");
    const allowedFile = path.join(probeRoot, "allowed.txt");
    const protectedFile = path.join(probeRoot, ".env");
    try {
      await mkdir(probeRoot, { recursive: true, mode: 0o700 });
      await writeFile(allowedFile, "allowed", { mode: 0o600 });
      await writeFile(protectedFile, "ORBITCODE_PROBE_SECRET=hidden", { mode: 0o600 });
      await writeFile(outsideFile, "outside", { mode: 0o600 });
      const cwd = {
        absolutePath: probeRoot,
        relativePath: ".orbitcode-runtime",
        existed: true,
      };
      const baseRequest = { cwd, timeoutMs: 2_000, outputLimitBytes: 8_192 };
      const signal = new AbortController().signal;
      const allowed = await this.runIsolated(
        { ...baseRequest, command: "cat allowed.txt && printf updated > written.txt" },
        workspace,
        signal,
      );
      if (allowed.exitCode !== 0 || allowed.stdout !== "allowed") {
        return { available: false, message: "Seatbelt 无法执行工作区内的基本读写。" };
      }
      if ((await readFile(path.join(probeRoot, "written.txt"), "utf8")) !== "updated") {
        return { available: false, message: "Seatbelt 工作区写入探测结果异常。" };
      }
      const outside = await this.runIsolated(
        { ...baseRequest, command: `cat ${quoteShell(outsideFile)}` },
        workspace,
        signal,
      );
      const protectedRead = await this.runIsolated(
        { ...baseRequest, command: "cat .env" },
        workspace,
        signal,
      );
      const environment = await this.runIsolated(
        { ...baseRequest, command: "test -z \"${ORBITCODE_SANDBOX_SENTINEL:-}\"" },
        workspace,
        signal,
      );
      const childEscape = await this.runIsolated(
        { ...baseRequest, command: `sh -c 'cat ${quoteShell(outsideFile)}'` },
        workspace,
        signal,
      );
      if (
        outside.exitCode === 0 ||
        protectedRead.exitCode === 0 ||
        environment.exitCode !== 0 ||
        childEscape.exitCode === 0
      ) {
        return { available: false, message: "Seatbelt 未通过目录、凭据或子进程逃逸探测。" };
      }
      return { available: true };
    } finally {
      await rm(probeRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(outsideRoot, { recursive: true, force: true }).catch(() => undefined);
      await removeEmptyDirectory(runtimeRoot);
    }
  }

  private async runIsolated(
    request: CommandRequest,
    workspace: WorkspaceBoundary,
    signal: AbortSignal,
  ): Promise<CommandExecution> {
    const runtimeRoot = path.join(workspace.root, ".orbitcode-runtime");
    const executionRoot = path.join(runtimeRoot, `run-${randomUUID()}`);
    await mkdir(executionRoot, { recursive: true, mode: 0o700 });
    const protectedPaths = await collectProtectedPaths(workspace.root);
    const developerRoot = await resolveDeveloperRoot();
    const profile = await createProfile(
      workspace.root,
      protectedPaths,
      developerRoot,
    );
    const environment: Record<string, string> = {
      PATH: [
        path.join(workspace.root, "node_modules", ".bin"),
        path.dirname(process.execPath),
        ...(developerRoot === undefined
          ? []
          : [path.join(developerRoot, "usr", "bin")]),
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
      ].join(":"),
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      HOME: executionRoot,
      TMPDIR: executionRoot,
      ...(developerRoot === undefined
        ? {}
        : { SDKROOT: path.join(developerRoot, "SDKs", "MacOSX.sdk") }),
    };
    try {
      return await spawnAndCollect(
        SANDBOX_EXEC,
        ["-p", profile, SHELL, "-c", request.command],
        {
          cwd: request.cwd.absolutePath,
          env: environment,
          signal,
          timeoutMs: request.timeoutMs,
          outputLimitBytes: request.outputLimitBytes,
        },
      );
    } finally {
      await rm(executionRoot, { recursive: true, force: true }).catch(() => undefined);
      await removeEmptyDirectory(runtimeRoot);
    }
  }
}

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

async function createProfile(
  workspaceRoot: string,
  protectedPaths: readonly string[],
  developerRoot: string | undefined,
): Promise<string> {
  const executable = await realpath(process.execPath).catch(() => process.execPath);
  const runtimeRoot = path.dirname(path.dirname(executable));
  const trustedReadRoots = [
    runtimeRoot,
    ...(developerRoot === undefined ? [] : [developerRoot]),
  ];
  const protectedRules = protectedPaths.map(
    (target) => `(deny file-read* file-write* (literal ${schemeString(target)}))`,
  );
  const dataRoots = [
    "/Applications",
    "/Library",
    "/Network",
    "/Users",
    "/Volumes",
    "/opt",
    "/private/etc",
    "/private/tmp",
    "/private/var",
    "/usr/local",
  ];
  const systemReadExemptions = [
    "/private/var/select/sh",
    "/private/var/select/developer_dir",
    "/var/select/developer_dir",
  ];
  const metadataReadExemptions = [
    ...systemReadExemptions,
    ...ancestorDirectories(workspaceRoot),
    ...trustedReadRoots.flatMap(ancestorDirectories),
  ];
  const readBoundaryRules = dataRoots.flatMap((dataRoot) => [
    createReadBoundaryRule(
      "file-read-data",
      dataRoot,
      workspaceRoot,
      trustedReadRoots,
      systemReadExemptions,
    ),
    createReadBoundaryRule(
      "file-read-metadata",
      dataRoot,
      workspaceRoot,
      trustedReadRoots,
      metadataReadExemptions,
    ),
  ]);
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-write* (require-all ` +
      `(require-not (subpath ${schemeString(workspaceRoot)})) ` +
      `(require-not (literal ${schemeString("/dev/null")}))))`,
    ...readBoundaryRules,
    ...protectedRules,
  ].join("\n");
}

function createReadBoundaryRule(
  operation: "file-read-data" | "file-read-metadata",
  dataRoot: string,
  workspaceRoot: string,
  trustedReadRoots: readonly string[],
  exemptions: readonly string[],
): string {
  return (
    `(deny ${operation} (require-all (subpath ${schemeString(dataRoot)}) ` +
    `(require-not (subpath ${schemeString(workspaceRoot)})) ` +
    trustedReadRoots
      .map((target) => `(require-not (subpath ${schemeString(target)}))`)
      .join(" ") +
    " " +
    exemptions
      .map((target) => `(require-not (literal ${schemeString(target)}))`)
      .join(" ") +
    "))"
  );
}

function ancestorDirectories(target: string): readonly string[] {
  const ancestors: string[] = [];
  let cursor = path.dirname(target);
  while (cursor !== path.dirname(cursor)) {
    ancestors.push(cursor);
    cursor = path.dirname(cursor);
  }
  return ancestors;
}

async function resolveDeveloperRoot(): Promise<string | undefined> {
  const selected = await realpath("/var/select/developer_dir").catch(() => undefined);
  if (selected === undefined) return undefined;
  if (
    isWithinTrustedRoot("/Library/Developer", selected) ||
    isWithinTrustedRoot("/Applications", selected)
  ) {
    return selected;
  }
  return undefined;
}

function isWithinTrustedRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function collectProtectedPaths(root: string): Promise<readonly string[]> {
  const result: string[] = [];
  const ignored = new Set([".git", "node_modules", ".next", "dist", "build", "coverage"]);
  async function visit(directory: string, relativeBase: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const relativePath = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (isProtectedPath(relativePath)) {
        result.push(absolutePath);
        continue;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink() && !ignored.has(entry.name)) {
        await visit(absolutePath, relativePath);
      }
    }
  }
  await visit(root, "");
  for (const name of [
    ".env",
    ".env.local",
    ".env.development",
    ".env.production",
    ".env.test",
    "orbitcode.yaml",
    ".npmrc",
    ".netrc",
    ".git-credentials",
    "auth.json",
  ]) {
    // 工作区内容是运行时用户数据，不应被 Next.js 当作部署依赖追踪。
    result.push(path.join(/* turbopackIgnore: true */ root, name));
  }
  return [...new Set(result)].sort();
}

function spawnAndCollect(
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
    readonly outputLimitBytes: number;
  },
): Promise<CommandExecution> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      resolve(emptyExecution({ cancelled: true }));
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(executable, [...args], {
        cwd: options.cwd,
        // Next.js 把 NODE_ENV 扩展为必填字段，但子进程环境允许有意省略它。
        env: options.env as NodeJS.ProcessEnv,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    const stdout = new OutputCollector(options.outputLimitBytes);
    const stderr = new OutputCollector(options.outputLimitBytes);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = (reason: "timeout" | "cancelled"): void => {
      if (settled) return;
      timedOut = reason === "timeout";
      cancelled = reason === "cancelled";
      killProcessGroup(child, "SIGTERM");
      forceKillTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), TERMINATION_GRACE_MS);
    };
    const timeout = setTimeout(() => terminate("timeout"), options.timeoutMs);
    const abort = (): void => terminate("cancelled");
    options.signal.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("close", (exitCode, terminationSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        stdout: stdout.text(),
        stderr: stderr.text(),
        exitCode,
        terminationSignal,
        timedOut,
        cancelled,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      });
    });
    function cleanup(): void {
      clearTimeout(timeout);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      options.signal.removeEventListener("abort", abort);
    }
  });
}

class OutputCollector {
  private readonly chunks: Buffer[] = [];
  private capturedBytes = 0;
  truncated = false;

  constructor(private readonly limitBytes: number) {}

  push(chunk: Buffer): void {
    const remaining = this.limitBytes - this.capturedBytes;
    if (remaining > 0) {
      const captured = chunk.subarray(0, remaining);
      this.chunks.push(captured);
      this.capturedBytes += captured.byteLength;
    }
    if (chunk.byteLength > remaining) this.truncated = true;
  }

  text(): string {
    return new TextDecoder("utf-8").decode(Buffer.concat(this.chunks));
  }
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function emptyExecution(options: { readonly cancelled: boolean }): CommandExecution {
  return {
    stdout: "",
    stderr: "",
    exitCode: null,
    terminationSignal: null,
    timedOut: false,
    cancelled: options.cancelled,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function schemeString(value: string): string {
  return JSON.stringify(value);
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function removeEmptyDirectory(directory: string): Promise<void> {
  const entries = await readdir(directory).catch(() => ["not-empty"]);
  if (entries.length === 0) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
}
