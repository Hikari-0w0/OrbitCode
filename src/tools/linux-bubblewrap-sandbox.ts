import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandExecution, CommandRequest, CommandSandbox, CommandSandboxOptions, ManagedCommandRequest, SandboxAvailability, SandboxManagedProcess } from "@/tools/command-sandbox";
import { linuxSandboxArguments } from "@/tools/linux-sandbox-profile";
import { SandboxUnavailableError } from "@/tools/sandbox-error";
import { spawnAndCollect, spawnManaged } from "@/tools/sandbox-process";
import type { WorkspaceBoundary } from "@/tools/types";
import { createWorkspaceBoundary } from "@/tools/workspace";
import { runWithSandboxDeadline, waitForSandboxProbe } from "@/tools/sandbox-deadline";

const BWRAP = "/usr/bin/bwrap";

export class LinuxBubblewrapCommandSandbox implements CommandSandbox {
  private readonly probes = new Map<string, Promise<SandboxAvailability>>();

  constructor(private readonly options: CommandSandboxOptions = {}) {}

  probe(workspace: WorkspaceBoundary): Promise<SandboxAvailability> {
    const previous = this.probes.get(workspace.root);
    if (previous) return previous;
    const pending = this.performProbe().catch(() => ({ available: false as const, message: "Linux 沙箱探测失败，请检查 bubblewrap、user namespace 与容器安全策略。" }));
    this.probes.set(workspace.root, pending);
    return pending;
  }

  async run(request: CommandRequest, input: { readonly workspace: WorkspaceBoundary; readonly signal: AbortSignal }): Promise<CommandExecution> {
    return runWithSandboxDeadline(request.timeoutMs, input.signal, async signal => {
      const availability = await waitForSandboxProbe(this.probe(input.workspace), signal);
      if (!availability.available) throw new SandboxUnavailableError(availability.message);
      const prepared = await this.prepare(request, input.workspace, signal);
      try {
        return await spawnAndCollect(BWRAP, prepared.args, { cwd: "/", env: {}, signal, timeoutMs: request.timeoutMs, outputLimitBytes: request.outputLimitBytes });
      } finally { await prepared.close(); }
    });
  }

  async start(request: ManagedCommandRequest, input: { readonly workspace: WorkspaceBoundary }): Promise<SandboxManagedProcess> {
    await this.requireAvailable(input.workspace);
    const prepared = await this.prepare(request, input.workspace);
    try {
      const process = spawnManaged(BWRAP, prepared.args, { cwd: "/", env: {} });
      return { ...process, completion: process.completion.finally(() => prepared.close()) };
    } catch (error) { await prepared.close(); throw error; }
  }

  private async requireAvailable(workspace: WorkspaceBoundary): Promise<void> {
    const availability = await this.probe(workspace);
    if (!availability.available) throw new SandboxUnavailableError(availability.message);
  }

  private async prepare(request: ManagedCommandRequest, workspace: WorkspaceBoundary, signal?: AbortSignal) {
    const temporary = await mkdtemp(path.join(tmpdir(), "orbitcode-linux-sandbox-"));
    const close = async () => { await rm(temporary, { recursive: true, force: true }); };
    try {
      const blockedFile = path.join(temporary, "blocked-file");
      const blockedDirectory = path.join(temporary, "blocked-directory");
      await writeFile(blockedFile, "", { mode: 0o000 });
      await mkdir(blockedDirectory, { mode: 0o000 });
      const args = await linuxSandboxArguments({ workspaceRoot: workspace.root, cwd: request.cwd.absolutePath, command: request.command, blockedFile, blockedDirectory, options: this.options, signal });
      return { args, close };
    } catch (error) { await close(); throw error; }
  }

  private async performProbe(): Promise<SandboxAvailability> {
    const signal = AbortSignal.timeout(5000);
    if (process.platform !== "linux") return { available: false, message: "bubblewrap 后端仅支持 Linux。" };
    try {
      if (!(await lstat(BWRAP)).isFile()) throw new Error();
    } catch { return { available: false, message: "Linux 命令隔离需要 /usr/bin/bwrap，请安装系统软件包 bubblewrap。" }; }
    const temporary = await mkdtemp(path.join(tmpdir(), "orbitcode-linux-probe-"));
    try {
      const probeRoot = path.join(temporary, "workspace");
      await mkdir(probeRoot);
      const workspace = await createWorkspaceBoundary(probeRoot);
      const outside = path.join(temporary, "outside.txt");
      await writeFile(outside, "ORBITCODE_OUTSIDE_PROBE");
      const root = await realpath(workspace.root);
      const parentNamespace = await readlink("/proc/self/ns/pid");
      const prepared = await this.prepare({ cwd: { absolutePath: root, relativePath: ".", existed: true }, command: `test -d . && printf probe > "$HOME/probe" && test "$(/bin/cat "$HOME/probe")" = probe && test ! -e ${quote(outside)} && test "$(/usr/bin/readlink /proc/self/ns/pid)" != ${quote(parentNamespace)} && test -z "\${ORBITCODE_SANDBOX_SENTINEL:-}" && printf isolated` }, workspace, signal);
      let result: CommandExecution;
      try { result = await spawnAndCollect(BWRAP, prepared.args, { cwd: "/", env: {}, signal, timeoutMs: 5000, outputLimitBytes: 1024 }); }
      finally { await prepared.close(); }
      if (result.exitCode !== 0 || result.stdout !== "isolated") return { available: false, message: "bubblewrap 隔离探测未通过；系统或外层容器可能禁止 user/PID namespace。未降级执行。" };
      if (await readFile(outside, "utf8") !== "ORBITCODE_OUTSIDE_PROBE") return { available: false, message: "Linux 沙箱外部文件完整性探测失败。" };
      return { available: true };
    } finally { await chmod(temporary, 0o700); await rm(temporary, { recursive: true, force: true }); }
  }
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
