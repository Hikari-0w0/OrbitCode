import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { parseMessage } from "./messages";
import { MCP_MAX_BYTES, McpError, type McpMessage, type McpTransport, type McpTransportHandlers } from "./types";

// Next 等宿主可能先于异步清理调用 process.exit；仅在退出兜底中同步终止所拥有的进程组。
const processState = globalThis as typeof globalThis & { orbitcodeMcpChildren?: Set<ChildProcessWithoutNullStreams> };
if (!processState.orbitcodeMcpChildren) {
  processState.orbitcodeMcpChildren = new Set();
  process.once("exit", () => {
    for (const child of processState.orbitcodeMcpChildren ?? []) terminate(child, "SIGKILL");
  });
}
function terminate(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try { if (process.platform === "win32") child.kill(signal); else process.kill(-child.pid, signal); } catch { /* 进程组可能已退出。 */ }
}

export class McpStdioTransport implements McpTransport {
  private child?: ChildProcessWithoutNullStreams;
  private closing?: Promise<void>;
  private ended?: Promise<void>;
  constructor(private readonly options: { command: string; args: readonly string[]; env: Readonly<Record<string, string>>; cwd: string }) {}
  async start(handlers: McpTransportHandlers, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.child || this.closing) throw new McpError("cancelled", "MCP 启动已取消。");
    // Next 扩充的 ProcessEnv 要求 NODE_ENV，但外部子进程不应被强制注入该变量。
    const child = spawn(this.options.command, [...this.options.args], { cwd: this.options.cwd, env: this.options.env as NodeJS.ProcessEnv, shell: false, detached: process.platform !== "win32", stdio: "pipe" });
    this.child = child;
    processState.orbitcodeMcpChildren?.add(child);
    this.ended = new Promise((resolve) => child.once("close", () => resolve()));
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        buffer += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          handlers.message(parseMessage(line));
        }
        if (Buffer.byteLength(buffer) > MCP_MAX_BYTES) throw new McpError("limit-exceeded", "MCP 消息超过大小上限。", true);
      } catch (error) {
        handlers.closed(error instanceof McpError ? error : new McpError("mcp-protocol", "MCP 字符编码无效。", true));
      }
    });
    child.stderr.resume();
    child.stdin.on("error", () => handlers.closed(new McpError("mcp-transport", "MCP 输入流已关闭。", true)));
    child.on("error", () => handlers.closed(new McpError("mcp-transport", "MCP 子进程启动失败。")));
    child.on("close", () => handlers.closed(new McpError("mcp-transport", "MCP 子进程已退出。", true)));
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => reject(new McpError("mcp-transport", "MCP 子进程启动失败。")));
    });
    if (signal.aborted) { await this.close(); throw new McpError("cancelled", "MCP 启动已取消。"); }
  }
  async send(message: McpMessage, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.closing || !this.child) throw new McpError("cancelled", "MCP 发送已取消。");
    const payload = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(payload) > MCP_MAX_BYTES) throw new McpError("limit-exceeded", "MCP 消息超过大小上限。");
    await new Promise<void>((resolve, reject) => {
      const abort = () => { cleanup(); reject(new McpError("cancelled", "MCP 发送已取消。", true)); };
      const cleanup = () => signal.removeEventListener("abort", abort);
      signal.addEventListener("abort", abort, { once: true });
      this.child!.stdin.write(payload, (error) => { cleanup(); if (error) reject(new McpError("mcp-transport", "MCP 发送失败。", true)); else resolve(); });
    });
  }
  close(): Promise<void> {
    this.closing ??= this.dispose();
    return this.closing;
  }
  private async dispose(): Promise<void> {
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    await this.waitForExit(1000);
    this.killGroup("SIGTERM");
    await this.waitForExit(1000);
    this.killGroup("SIGKILL");
    await this.waitForExit(1000);
    child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
    processState.orbitcodeMcpChildren?.delete(child);
  }
  private killGroup(signal: NodeJS.Signals): void {
    if (this.child) terminate(this.child, signal);
  }
  private async waitForExit(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.ended, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
    if (timer) clearTimeout(timer);
  }
}
