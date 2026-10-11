import { McpConnectionManager } from "@/runtime/mcp-connections";

const globals = globalThis as typeof globalThis & { orbitcodeMcpHost?: McpConnectionManager; orbitcodeMcpSignals?: boolean };
export function webMcpHost(): McpConnectionManager {
  globals.orbitcodeMcpHost ??= new McpConnectionManager();
  if (!globals.orbitcodeMcpSignals) {
    globals.orbitcodeMcpSignals = true;
    installMcpShutdown(() => globals.orbitcodeMcpHost?.close() ?? Promise.resolve());
  }
  return globals.orbitcodeMcpHost;
}
export function installMcpShutdown(close: () => Promise<void>): () => void {
  let ending = false;
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      if (ending) return;
      ending = true;
      const timer = setTimeout(() => process.exit(signal === "SIGINT" ? 130 : 143), 5000);
      void close().catch(() => undefined).finally(() => {
        clearTimeout(timer);
        remove();
        // 仅在本模块是最后一个信号处理者时恢复默认退出；不覆盖宿主自身的退出码。
        if (!process.listenerCount(signal)) process.kill(process.pid, signal);
      });
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  const remove = () => { for (const [signal, handler] of handlers) process.removeListener(signal, handler); };
  return remove;
}
