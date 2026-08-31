import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

import type {
  CommandSandbox,
  ManagedCommandExit,
  SandboxManagedProcess,
} from "@/tools/command-sandbox";
import type { WorkspaceBoundary } from "@/tools/types";

const DEFAULT_MAX_PROCESSES = 4;
const DEFAULT_LOG_BYTES = 128 * 1024;
const CONNECT_TIMEOUT_MS = 150;

export type ManagedProcessLogChunk = {
  readonly cursor: number;
  readonly stream: "stdout" | "stderr";
  readonly text: string;
};

export type ManagedProcessSnapshot = {
  readonly processId: string;
  readonly status: "running" | "exited" | "failed";
  readonly pid: number;
  readonly exit?: ManagedCommandExit;
  readonly logs: readonly ManagedProcessLogChunk[];
  readonly nextCursor: number;
  readonly truncated: boolean;
};

type ProcessRecord = {
  readonly id: string;
  readonly handle: SandboxManagedProcess;
  readonly logs: ProcessLogBuffer;
  status: ManagedProcessSnapshot["status"];
  exit?: ManagedCommandExit;
};

export class ManagedProcessError extends Error {
  constructor(
    readonly kind: "limit" | "unavailable" | "invalid-id" | "start" | "not-ready",
    message: string,
    diagnostic: {
      readonly processAvailable: false;
      readonly logs: readonly ManagedProcessLogChunk[];
    } | undefined = undefined,
  ) {
    super(message);
    this.name = "ManagedProcessError";
    this.processAvailable = diagnostic?.processAvailable;
    this.logs = diagnostic?.logs ?? [];
  }

  readonly processAvailable: false | undefined;
  readonly logs: readonly ManagedProcessLogChunk[];
}

export class ManagedProcessController {
  readonly #records = new Map<string, ProcessRecord>();
  readonly #maxProcesses: number;
  readonly #logBytes: number;
  #closed = false;

  constructor(
    private readonly sandbox: CommandSandbox,
    private readonly workspace: WorkspaceBoundary,
    options: { readonly maxProcesses?: number; readonly logBytes?: number } = {},
  ) {
    this.#maxProcesses = options.maxProcesses ?? DEFAULT_MAX_PROCESSES;
    this.#logBytes = options.logBytes ?? DEFAULT_LOG_BYTES;
  }

  async start(input: {
    readonly command: string;
    readonly cwd?: string;
    readonly readyPort?: number;
    readonly readyTimeoutMs?: number;
    readonly signal: AbortSignal;
  }): Promise<ManagedProcessSnapshot> {
    if (this.#closed) throw new ManagedProcessError("start", "进程控制器已关闭。");
    const running = [...this.#records.values()].filter(
      (record) => record.status === "running",
    ).length;
    if (running >= this.#maxProcesses) {
      throw new ManagedProcessError("limit", "本轮可管理的长驻进程数量已达上限。");
    }
    if (!this.sandbox.start) {
      throw new ManagedProcessError("unavailable", "当前命令沙箱不支持长驻进程。");
    }
    const cwd = await this.workspace.resolveExistingDirectory(input.cwd);
    let handle: SandboxManagedProcess;
    try {
      handle = await this.sandbox.start(
        { command: input.command, cwd },
        { workspace: this.workspace },
      );
    } catch {
      throw new ManagedProcessError("start", "无法启动受管进程。");
    }
    if (handle.pid <= 0) {
      await handle.stop().catch(() => undefined);
      throw new ManagedProcessError("start", "受管进程没有有效 PID。");
    }
    const record: ProcessRecord = {
      id: `process-${randomUUID()}`,
      handle,
      logs: new ProcessLogBuffer(this.#logBytes),
      status: "running",
    };
    handle.stdout?.on("data", (chunk: Buffer | string) =>
      record.logs.push("stdout", chunk)
    );
    handle.stderr?.on("data", (chunk: Buffer | string) =>
      record.logs.push("stderr", chunk)
    );
    this.#records.set(record.id, record);
    void handle.completion.then(
      (exit) => {
        record.exit = exit;
        record.status = "exited";
      },
      () => {
        record.status = "failed";
      },
    );

    try {
      if (input.readyPort !== undefined) {
        await this.#waitForPort(
          record,
          input.readyPort,
          input.readyTimeoutMs ?? 10_000,
          input.signal,
        );
      } else if (input.signal.aborted) {
        throw new ManagedProcessError("not-ready", "启动受管进程已取消。");
      }
      return this.status(record.id, 0);
    } catch (error) {
      await handle.stop().catch(() => undefined);
      const logs = record.logs.read(0).chunks;
      this.#records.delete(record.id);
      if (error instanceof ManagedProcessError) {
        throw new ManagedProcessError(error.kind, error.message, {
          processAvailable: false,
          logs,
        });
      }
      throw error;
    }
  }

  status(processId: string, cursor = 0): ManagedProcessSnapshot {
    const record = this.#require(processId);
    const logs = record.logs.read(cursor);
    return {
      processId,
      status: record.status,
      pid: record.handle.pid,
      ...(record.exit === undefined ? {} : { exit: record.exit }),
      logs: logs.chunks,
      nextCursor: logs.nextCursor,
      truncated: logs.truncated,
    };
  }

  async stop(processId: string): Promise<ManagedProcessSnapshot> {
    const record = this.#require(processId);
    await record.handle.stop().catch(() => undefined);
    await record.handle.completion.catch(() => undefined);
    return this.status(processId, 0);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.all(
      [...this.#records.values()]
        .filter((record) => record.status === "running")
        .map((record) => record.handle.stop().catch(() => undefined)),
    );
  }

  async #waitForPort(
    record: ProcessRecord,
    port: number,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (signal.aborted) {
        throw new ManagedProcessError("not-ready", "等待进程就绪已取消。");
      }
      if (record.status !== "running") {
        throw new ManagedProcessError("not-ready", "进程在端口就绪前已经退出。");
      }
      if (await canConnect(port)) return;
      if (Date.now() >= deadline) {
        throw new ManagedProcessError("not-ready", "进程未在限定时间内监听本机端口。");
      }
      await abortableDelay(50, signal);
    }
  }

  #require(processId: string): ProcessRecord {
    if (!/^process-[0-9a-f-]{36}$/u.test(processId)) {
      throw new ManagedProcessError("invalid-id", "受管进程 ID 无效。");
    }
    const record = this.#records.get(processId);
    if (!record) throw new ManagedProcessError("invalid-id", "受管进程不存在或不属于本轮。");
    return record;
  }
}

class ProcessLogBuffer {
  readonly #chunks: ManagedProcessLogChunk[] = [];
  #bytes = 0;
  #nextCursor = 1;
  #droppedThrough = 0;

  constructor(private readonly limitBytes: number) {}

  push(stream: "stdout" | "stderr", value: Buffer | string): void {
    const source = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const captured = source.byteLength > this.limitBytes
      ? source.subarray(source.byteLength - this.limitBytes)
      : source;
    const chunk = {
      cursor: this.#nextCursor,
      stream,
      text: new TextDecoder("utf-8").decode(captured),
    } as const;
    this.#nextCursor += 1;
    this.#chunks.push(chunk);
    this.#bytes += captured.byteLength;
    while (this.#bytes > this.limitBytes && this.#chunks.length > 1) {
      const removed = this.#chunks.shift();
      if (!removed) break;
      this.#bytes -= Buffer.byteLength(removed.text, "utf8");
      this.#droppedThrough = removed.cursor;
    }
  }

  read(cursor: number): {
    readonly chunks: readonly ManagedProcessLogChunk[];
    readonly nextCursor: number;
    readonly truncated: boolean;
  } {
    const safeCursor = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
    return {
      chunks: this.#chunks.filter((chunk) => chunk.cursor > safeCursor),
      nextCursor: this.#nextCursor - 1,
      truncated: safeCursor < this.#droppedThrough,
    };
  }
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (connected: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(new ManagedProcessError("not-ready", "等待进程就绪已取消。"));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", abort, { once: true });
  });
}
