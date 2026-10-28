import { lstat, realpath, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CommandSandboxOptions } from "@/tools/command-sandbox";
import { collectSandboxProtectedEntries } from "@/tools/sandbox-protected-entries";
import { resolveSandboxReadRoots } from "@/tools/sandbox-read-roots";
import { shortTemporaryDirectory, workspaceTemporaryDirectory } from "@/tools/workspace-temporary-directory";
import { resolveSandboxWritableRoots } from "@/tools/sandbox-writable-roots";

export const LINUX_SANDBOX_HOME = "/.orbitcode-home";
const SYSTEM_ROOTS = ["/usr", "/bin", "/sbin", "/lib", "/lib64"];
const PUBLIC_CONFIGURATION = ["/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/ld.so.cache", "/etc/localtime", "/etc/ssl/certs", "/etc/alternatives"];

export async function linuxSandboxArguments(input: {
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly command: string;
  readonly blockedFile: string;
  readonly blockedDirectory: string;
  readonly options: CommandSandboxOptions;
  readonly signal?: AbortSignal;
}): Promise<string[]> {
  const root = await realpath(input.workspaceRoot);
  const cwd = await realpath(input.cwd);
  if (!within(root, cwd)) throw new Error("命令工作目录不在授权工作区内。");
  const runtime = path.dirname(path.dirname(await realpath(process.execPath)));
  const extraRoots = await resolveSandboxReadRoots(input.options.readOnlyRoots ?? [], root);
  const temporaryRoot = input.options.temporaryDirectory === "short" ? await shortTemporaryDirectory(root) : input.options.temporaryDirectory === "workspace" ? await workspaceTemporaryDirectory(root) : "/tmp";
  const writableRoots = await resolveSandboxWritableRoots([...(input.options.writableRoots ?? []), ...(input.options.temporaryDirectory === "short" ? [temporaryRoot] : [])], root, extraRoots);
  const trustedRoots = [...SYSTEM_ROOTS, runtime, ...extraRoots];
  const roots = new Set<string>();
  for (const directory of trustedRoots) {
    const resolved = await realpath(directory).catch(error => {
      if (SYSTEM_ROOTS.includes(directory) && missing(error)) return undefined;
      throw error;
    });
    if (!resolved) continue;
    if (resolved === "/" || within(resolved, root) || within(root, resolved)) throw new Error("只读工具链目录不能包含工作区或与工作区重叠。");
    if (!(await lstat(resolved)).isDirectory()) throw new Error("只读工具链路径必须为目录。");
    roots.add(directory);
  }
  if (within(root, LINUX_SANDBOX_HOME) || within(LINUX_SANDBOX_HOME, root)) throw new Error("工作区与沙箱私有 HOME 冲突。");
  const args = ["--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try", "--die-with-parent", "--new-session", "--cap-drop", "ALL"];
  if (input.options.network === "deny") args.push("--unshare-net");
  args.push("--tmpfs", "/tmp", "--tmpfs", "/var/tmp", "--tmpfs", LINUX_SANDBOX_HOME);
  for (const directory of roots) args.push("--ro-bind", directory, directory);
  for (const target of PUBLIC_CONFIGURATION) {
    if (await lstat(target).catch(error => { if (missing(error)) return undefined; throw error; })) args.push("--ro-bind", target, target);
  }
  args.push("--proc", "/proc", "--remount-ro", "/proc", "--dev", "/dev", "--bind", root, root);
  for (const directory of writableRoots) args.push("--bind", directory, directory);
  for (const target of await collectSandboxProtectedEntries([root, ...writableRoots], input.signal, input.options.maxScanEntries, input.options.npmrcAccess, input.options.environmentFileAccess)) {
    if (target.publicNpmrc !== undefined) {
      const snapshot = path.join(path.dirname(input.blockedFile), `public-npmrc-${randomUUID()}`);
      await writeFile(snapshot, target.publicNpmrc, { mode: 0o600, flag: "wx" });
      args.push("--ro-bind", snapshot, target.path);
    } else args.push("--ro-bind", target.directory ? input.blockedDirectory : input.blockedFile, target.path);
  }
  const searchPath = [path.join(root, "node_modules", ".bin"), path.dirname(process.execPath), ...extraRoots.map(directory => path.join(directory, "bin")), "/usr/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin"].join(":");
  args.push("--clearenv", "--setenv", "PATH", searchPath, "--setenv", "HOME", LINUX_SANDBOX_HOME, "--setenv", "TMPDIR", temporaryRoot, "--setenv", "XDG_CACHE_HOME", path.join(temporaryRoot, "cache"), "--setenv", "npm_config_cache", path.join(temporaryRoot, "cache", "npm"), "--setenv", "PNPM_HOME", path.join(temporaryRoot, "cache", "pnpm"), "--setenv", "BUN_INSTALL_CACHE_DIR", path.join(temporaryRoot, "cache", "bun"), "--setenv", "LANG", "C.UTF-8", "--setenv", "LC_ALL", "C.UTF-8", "--chdir", cwd, "--", "/bin/bash", "--noprofile", "--norc", "-o", "pipefail", "-c", input.command);
  return args;
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
