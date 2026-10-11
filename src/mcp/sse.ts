import { MCP_MAX_BYTES, McpError } from "./types";

export async function* readSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let data: string[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (!signal.aborted) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        size += Buffer.byteLength(line) + 1;
        if (size > MCP_MAX_BYTES) throw new McpError("limit-exceeded", "MCP SSE 事件超过上限。", true);
        if (!line) {
          if (data.length && data.join("\n").trim()) yield data.join("\n");
          data = []; size = 0;
        } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (size + Buffer.byteLength(buffer) > MCP_MAX_BYTES) throw new McpError("limit-exceeded", "MCP SSE 事件超过上限。", true);
    }
    decoder.decode();
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
