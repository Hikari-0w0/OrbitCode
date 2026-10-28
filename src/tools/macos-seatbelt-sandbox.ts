import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  CommandExecution,
  CommandRequest,
  CommandSandbox,
  ManagedCommandRequest,
  SandboxAvailability,
  SandboxManagedProcess,
} from "@/tools/command-sandbox";
import { spawnAndCollect, spawnManaged } from "@/tools/sandbox-process";
import { SandboxUnavailableError } from "@/tools/sandbox-error";
export { SandboxUnavailableError } from "@/tools/sandbox-error";
import type { CommandSandboxOptions } from "@/tools/command-sandbox";
import { parseCommandSecurity, type CommandSecuritySettings } from "@/tools/command-security";
import { shortTemporaryDirectory, workspaceTemporaryDirectory } from "@/tools/workspace-temporary-directory";
import { resolveSandboxWritableRoots } from "@/tools/sandbox-writable-roots";
import { resolveSandboxReadRoots } from "@/tools/sandbox-read-roots";
import { collectSandboxProtectedEntries, type SandboxProtectedEntry } from "@/tools/sandbox-protected-entries";
import type { WorkspaceBoundary } from "@/tools/types";
import { createWorkspaceBoundary } from "@/tools/workspace";
import { runWithSandboxDeadline, waitForSandboxProbe } from "@/tools/sandbox-deadline";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const SHELL = "/bin/bash";
const SYSTEM_RUNTIME_READ_ROOTS = ["/private/etc/ssl"] as const;

export class MacOsSeatbeltCommandSandbox implements CommandSandbox {
  readonly security: CommandSecuritySettings;
  private readonly options: CommandSecuritySettings;
  constructor(options: CommandSandboxOptions = {}) { this.options = this.security = parseCommandSecurity(options); }

  private readonly probes = new Map<string, Promise<SandboxAvailability>>();

  probe(workspace: WorkspaceBoundary): Promise<SandboxAvailability> {
    const existing = this.probes.get(workspace.root);
    if (existing) return existing;
    const pending = this.performProbe().catch(() => ({
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
    return runWithSandboxDeadline(request.timeoutMs, options.signal, async signal => {
      const availability = await waitForSandboxProbe(this.probe(options.workspace), signal);
      if (!availability.available) throw new SandboxUnavailableError(availability.message);
      return this.runIsolated(request, options.workspace, signal);
    });
  }

  async start(
    request: ManagedCommandRequest,
    options: { readonly workspace: WorkspaceBoundary },
  ): Promise<SandboxManagedProcess> {
    const availability = await this.probe(options.workspace);
    if (!availability.available) {
      throw new SandboxUnavailableError(availability.message);
    }
    return this.startIsolated(request, options.workspace);
  }

  private async performProbe(): Promise<SandboxAvailability> {
    if (process.platform !== "darwin") {
      return { available: false, message: "当前平台没有可用的严格命令隔离后端。" };
    }
    try {
      const executable = await lstat(SANDBOX_EXEC);
      if (!executable.isFile()) throw new Error("sandbox-exec is not a file");
    } catch {
      return { available: false, message: "系统未提供可验证的 Seatbelt 执行器。" };
    }

    const probeRoot = await mkdtemp(path.join(tmpdir(), "orbitcode-capability-probe-"));
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "orbitcode-sandbox-probe-"));
    const outsideFile = path.join(outsideRoot, "outside.txt");
    const allowedFile = path.join(probeRoot, "allowed.txt");
    const protectedFile = path.join(probeRoot, "auth.json");
    try {
      const workspace = await createWorkspaceBoundary(probeRoot);
      await writeFile(allowedFile, "allowed", { mode: 0o600 });
      await writeFile(protectedFile, "ORBITCODE_PROBE_SECRET=hidden", { mode: 0o600 });
      await writeFile(outsideFile, "outside", { mode: 0o600 });
      const cwd = {
        absolutePath: probeRoot,
        relativePath: ".orbitcode-runtime",
        existed: true,
      };
      const baseRequest = { cwd, timeoutMs: 2_000, outputLimitBytes: 8_192 };
      const signal = AbortSignal.timeout(5000);
      const allowed = await this.runIsolated(
        { ...baseRequest, command: "/bin/cat allowed.txt && printf updated > written.txt" },
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
        { ...baseRequest, command: `/bin/cat ${quoteShell(outsideFile)}` },
        workspace,
        signal,
      );
      const protectedRead = await this.runIsolated(
        { ...baseRequest, command: "/bin/cat auth.json" },
        workspace,
        signal,
      );
      const environment = await this.runIsolated(
        { ...baseRequest, command: "test -z \"${ORBITCODE_SANDBOX_SENTINEL:-}\"" },
        workspace,
        signal,
      );
      const childEscape = await this.runIsolated(
        { ...baseRequest, command: `/bin/sh -c ${quoteShell(`/bin/cat ${quoteShell(outsideFile)}`)}` },
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
    }
  }

  private async runIsolated(
    request: CommandRequest,
    workspace: WorkspaceBoundary,
    signal: AbortSignal,
  ): Promise<CommandExecution> {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "orbitcode-sandbox-run-"));
    const privateRuntimeRoot = await realpath(runtimeRoot);
    const executionRoot = path.join(privateRuntimeRoot, "home");
    try {
      await mkdir(executionRoot, { mode: 0o700 });
      const temporaryRoot = this.options.temporaryDirectory === "short" ? await shortTemporaryDirectory(workspace.root) : this.options.temporaryDirectory === "workspace" ? await workspaceTemporaryDirectory(workspace.root) : executionRoot;
      const writableRoots = await resolveSandboxWritableRoots([...this.options.writableRoots, ...(this.options.temporaryDirectory === "short" ? [temporaryRoot] : [])], workspace.root, this.options.readOnlyRoots);
      const protectedPaths = await collectProtectedPaths([workspace.root, ...writableRoots], signal, this.options.maxScanEntries, this.options.npmrcAccess, this.options.environmentFileAccess);
      const developerRoot = await resolveDeveloperRoot();
      const profile = await createProfile(
        workspace.root,
        protectedPaths,
        developerRoot,
        privateRuntimeRoot,
        { ...this.options, writableRoots },
      );
      const environment = createCommandEnvironment(
        workspace.root,
        executionRoot,
        developerRoot,
        this.options.readOnlyRoots,
        temporaryRoot,
      );
      return await spawnAndCollect(
        SANDBOX_EXEC,
        ["-p", profile, SHELL, "--noprofile", "--norc", "-o", "pipefail", "-c", request.command],
        {
          cwd: request.cwd.absolutePath,
          env: environment,
          signal,
          timeoutMs: request.timeoutMs,
          outputLimitBytes: request.outputLimitBytes,
        },
      );
    } finally {
      await rm(privateRuntimeRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async startIsolated(
    request: ManagedCommandRequest,
    workspace: WorkspaceBoundary,
  ): Promise<SandboxManagedProcess> {
    const runtimeRoot = await mkdtemp(path.join(tmpdir(), "orbitcode-sandbox-process-"));
    const privateRuntimeRoot = await realpath(runtimeRoot);
    const executionRoot = path.join(privateRuntimeRoot, "home");
    try {
      await mkdir(executionRoot, { mode: 0o700 });
      const temporaryRoot = this.options.temporaryDirectory === "short" ? await shortTemporaryDirectory(workspace.root) : this.options.temporaryDirectory === "workspace" ? await workspaceTemporaryDirectory(workspace.root) : executionRoot;
      const writableRoots = await resolveSandboxWritableRoots([...this.options.writableRoots, ...(this.options.temporaryDirectory === "short" ? [temporaryRoot] : [])], workspace.root, this.options.readOnlyRoots);
      const protectedPaths = await collectProtectedPaths([workspace.root, ...writableRoots], undefined, this.options.maxScanEntries, this.options.npmrcAccess, this.options.environmentFileAccess);
      const developerRoot = await resolveDeveloperRoot();
      const profile = await createProfile(
        workspace.root,
        protectedPaths,
        developerRoot,
        privateRuntimeRoot,
        { ...this.options, writableRoots },
      );
      const environment = createCommandEnvironment(
        workspace.root,
        executionRoot,
        developerRoot,
        this.options.readOnlyRoots,
        temporaryRoot,
      );
      const managed = spawnManaged(
        SANDBOX_EXEC,
        ["-p", profile, SHELL, "--noprofile", "--norc", "-o", "pipefail", "-c", request.command],
        { cwd: request.cwd.absolutePath, env: environment },
      );
      return {
        ...managed,
        completion: managed.completion.finally(async () => {
          await rm(privateRuntimeRoot, { recursive: true, force: true }).catch(() => undefined);
        }),
      };
    } catch (error) {
      await rm(privateRuntimeRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
}

async function createProfile(
  workspaceRoot: string,
  protectedPaths: readonly SandboxProtectedEntry[],
  developerRoot: string | undefined,
  privateRuntimeRoot: string,
  options: CommandSandboxOptions,
): Promise<string> {
  const executable = await realpath(process.execPath).catch(() => process.execPath);
  const runtimeRoot = path.dirname(path.dirname(executable));
  const trustedReadRoots = [
    runtimeRoot,
    privateRuntimeRoot,
    ...(options.writableRoots ?? []),
    ...await resolveSandboxReadRoots(options.readOnlyRoots ?? [], workspaceRoot),
    ...SYSTEM_RUNTIME_READ_ROOTS,
    ...(developerRoot === undefined ? [] : [developerRoot]),
  ];
  const protectedRules = protectedPaths.map(
    (target) => `(deny ${target.publicNpmrc === undefined ? "file-read* file-write*" : "file-write*"} (${target.directory ? "subpath" : "literal"} ${schemeString(target.path)}))`,
  );
  // 文件规则按路径匹配，必须阻止改名其祖先目录；同目录的普通文件仍可读写。
  const protectedAncestors = new Set(protectedPaths.flatMap(target => ancestorDirectories(target.path).filter(directory => [workspaceRoot, ...(options.writableRoots ?? [])].some(root => isWithinTrustedRoot(root, directory)))));
  const ancestorRules = [...protectedAncestors].map(directory => `(deny file-write-unlink (literal ${schemeString(directory)}))`);
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
  // 部分运行时通过打开逐级祖先目录确定 cwd；只放开目录本身，不放开其文件子树。
  const dataReadExemptions = options.macosAncestorDirectoryAccess === "read" ? metadataReadExemptions : systemReadExemptions;
  const readBoundaryRules = dataRoots.flatMap((dataRoot) => [
    createReadBoundaryRule(
      "file-read-data",
      dataRoot,
      workspaceRoot,
      trustedReadRoots,
      dataReadExemptions,
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
    // 环境过滤还不足以保密，kern.procargs2 等接口也不能查询父进程等其他进程。
    '(deny sysctl-read (sysctl-name-regex #"^kern\\.procargs"))',
    '(deny process-info* (target others))',
    ...(options.network === "deny" ? ["(deny network*)"] : []),
    `(deny file-write* (require-all ` +
      `(require-not (subpath ${schemeString(workspaceRoot)})) ` +
      `(require-not (subpath ${schemeString(privateRuntimeRoot)})) ` +
      (options.writableRoots ?? []).map(root => `(require-not (subpath ${schemeString(root)})) `).join("") +
      `(require-not (literal ${schemeString("/dev/null")}))))`,
    ...readBoundaryRules,
    ...protectedRules,
    ...ancestorRules,
    // 记忆目录可能在命令启动后创建，按目录段保护其整个子树。
    '(deny file-read* file-write* (regex #"(^|/)(memory-v1|memory-state-v1|knowledge-v1)(/|$)"))',
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
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function collectProtectedPaths(root: string | readonly string[], signal?: AbortSignal, maxEntries?: number, npmrcAccess?: "blocked" | "public-only", environmentFileAccess: "blocked" | "allow" = "blocked"): Promise<readonly SandboxProtectedEntry[]> {
  const roots = typeof root === "string" ? [root] : root;
  const entries = await collectSandboxProtectedEntries(roots, signal, maxEntries, npmrcAccess, environmentFileAccess);
  const paths = new Set(entries.map(entry => entry.path));
  const reserved = [".env", ".env.local", ".env.development", ".env.production", ".env.test", "orbitcode.yaml", ".npmrc", ".netrc", ".git-credentials", "auth.json"];
  return [...entries, ...roots.flatMap(directory => reserved.filter(name => environmentFileAccess !== "allow" || !name.startsWith(".env")).map(name => path.join(directory, name))).filter(target => !paths.has(target)).map(target => ({ path: target, directory: false }))];
}

function createCommandEnvironment(
  workspaceRoot: string,
  executionRoot: string,
  developerRoot: string | undefined,
  readOnlyRoots: readonly string[] = [],
  temporaryRoot = executionRoot,
): Record<string, string> {
  return {
    PATH: [
      path.join(workspaceRoot, "node_modules", ".bin"),
      path.dirname(process.execPath),
      ...readOnlyRoots.map(root => path.join(root, "bin")),
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
    TMPDIR: temporaryRoot,
    XDG_CACHE_HOME: path.join(temporaryRoot, "cache"),
    npm_config_cache: path.join(temporaryRoot, "cache", "npm"),
    PNPM_HOME: path.join(temporaryRoot, "cache", "pnpm"),
    BUN_INSTALL_CACHE_DIR: path.join(temporaryRoot, "cache", "bun"),
    ...(developerRoot === undefined
      ? {}
      : { SDKROOT: path.join(developerRoot, "SDKs", "MacOSX.sdk") }),
  };
}

function schemeString(value: string): string {
  return JSON.stringify(value);
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
