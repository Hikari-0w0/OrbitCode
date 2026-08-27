import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type MockRequest = {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly authorization: string | undefined;
  readonly body: unknown;
};

export type MockChunk = {
  readonly data: string | Uint8Array;
  readonly delayMs?: number;
};

export type MockResponse = {
  readonly status?: number;
  readonly statusMessage?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly chunks?: readonly MockChunk[];
  readonly destroyAfterChunks?: boolean;
};

export type OpenAIMockServer = {
  readonly baseUrl: string;
  readonly requests: MockRequest[];
  close(): Promise<void>;
};

export async function startOpenAIMockServer(
  responder: (request: MockRequest) => MockResponse | Promise<MockResponse>,
): Promise<OpenAIMockServer> {
  const requests: MockRequest[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer(async (request, response) => {
    try {
      const captured = await captureRequest(request);
      requests.push(captured);
      const mockResponse = await responder(captured);
      await sendResponse(response, mockResponse);
    } catch {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "text/plain" });
      }
      response.end("mock failure");
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function captureRequest(request: IncomingMessage): Promise<MockRequest> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.once("error", reject);
    request.once("end", () => {
      const source = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      try {
        body = JSON.parse(source);
      } catch {
        body = undefined;
      }
      resolve({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body,
      });
    });
  });
}

async function sendResponse(
  response: ServerResponse,
  mock: MockResponse,
): Promise<void> {
  response.writeHead(mock.status ?? 200, mock.statusMessage, {
    "content-type": "text/event-stream; charset=utf-8",
    ...mock.headers,
  });
  response.flushHeaders();
  for (const chunk of mock.chunks ?? []) {
    if (chunk.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, chunk.delayMs));
    }
    if (response.destroyed) {
      return;
    }
    response.write(chunk.data);
  }
  if (mock.destroyAfterChunks) {
    response.destroy();
    return;
  }
  response.end();
}

export function textDelta(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

export const DONE_EVENT = "data: [DONE]\n\n";
