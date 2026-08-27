export class SseError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "SseError";
  }
}

export async function* parseServerSentEvents(
  chunks: AsyncIterable<Uint8Array>,
): AsyncIterable<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";

  try {
    for await (const chunk of chunks) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary = findEventBoundary(buffer);
      while (boundary) {
        const eventBlock = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const data = parseEventBlock(eventBlock);
        if (data !== undefined) {
          yield data;
        }
        boundary = findEventBoundary(buffer);
      }
    }
    buffer += decoder.decode();
  } catch (error) {
    if (error instanceof SseError) {
      throw error;
    }
    throw new SseError("无法读取 SSE 响应流。", error);
  }

  if (buffer.length > 0) {
    if (buffer.trim().length === 0) {
      return;
    }
    throw new SseError("SSE 响应在完整事件结束前中断。");
  }
}

function findEventBoundary(
  buffer: string,
): { readonly index: number; readonly length: number } | undefined {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
  if (!match || match.index === undefined) {
    return undefined;
  }
  return { index: match.index, length: match[0].length };
}

function parseEventBlock(eventBlock: string): string | undefined {
  const dataLines: string[] = [];
  const normalized = eventBlock.replace(/\r\n|\r/g, "\n");

  for (const line of normalized.split("\n")) {
    if (line.startsWith(":")) {
      continue;
    }

    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    if (field !== "data") {
      continue;
    }

    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    dataLines.push(value);
  }

  return dataLines.length === 0 ? undefined : dataLines.join("\n");
}
