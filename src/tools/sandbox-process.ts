import { spawn, type ChildProcess } from "node:child_process";
import type { CommandExecution, SandboxManagedProcess } from "@/tools/command-sandbox";

const TERMINATION_GRACE_MS = 250;

export function spawnAndCollect(
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
      if (settled || timedOut || cancelled) return;
      timedOut = reason === "timeout";
      cancelled = reason === "cancelled";
      killProcessGroup(child, "SIGTERM");
      forceKillTimer = setTimeout(() => killProcessGroup(child, "SIGKILL"), TERMINATION_GRACE_MS);
    };
    const timeout = setTimeout(() => terminate("timeout"), options.timeoutMs);
    const abort = (): void => terminate("cancelled");
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    // 主进程退出不代表进程组退出；立即回收忽略TERM或关闭输出的普通后代。
    child.once("exit", () => killProcessGroup(child, "SIGKILL"));
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

export function spawnManaged(
  executable: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: Record<string, string> },
): SandboxManagedProcess {
  const child = spawn(executable, [...args], {
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let settled = false;
  const completion = new Promise<{
    readonly exitCode: number | null;
    readonly terminationSignal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    // 主进程退出不代表进程组退出；立即回收忽略TERM或关闭输出的普通后代。
    child.once("exit", () => killProcessGroup(child, "SIGKILL"));
    child.once("close", (exitCode, terminationSignal) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, terminationSignal });
    });
  });
  return {
    pid: child.pid ?? 0,
    stdout: child.stdout,
    stderr: child.stderr,
    completion,
    async stop() {
      if (settled) return;
      killProcessGroup(child, "SIGTERM");
      const forceKill = setTimeout(
        () => killProcessGroup(child, "SIGKILL"),
        TERMINATION_GRACE_MS,
      );
      try {
        await completion.catch(() => undefined);
      } finally {
        clearTimeout(forceKill);
      }
    },
  };
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

export function emptyExecution(options: { readonly cancelled: boolean }): CommandExecution {
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
