import { randomUUID } from "node:crypto";

export type SettingsOperationEvent =
  | { readonly type: "started" }
  | { readonly type: "finished"; readonly httpStatus: number; readonly result: unknown };

type Operation = {
  readonly owner: string;
  readonly controller: AbortController;
  readonly subscribers: Set<(event: SettingsOperationEvent) => void>;
  readonly expiresAt: number;
  readonly timer: ReturnType<typeof setTimeout>;
  event: SettingsOperationEvent;
};

export class SettingsOperations {
  private readonly operations = new Map<string, Operation>();

  start(owner: string, run: (signal: AbortSignal) => Promise<Response>): string {
    for (const [id, operation] of this.operations) if (operation.expiresAt <= Date.now()) {
      operation.controller.abort(); clearTimeout(operation.timer); this.operations.delete(id); this.runners.delete(id);
    }
    if (this.operations.size >= 64) throw new Error("管理操作数量已达上限。");
    const id = randomUUID();
    const controller = new AbortController();
    const operation: Operation = { owner, controller, subscribers: new Set(), expiresAt: Date.now() + 60_000,
      event: { type: "started" },
      timer: setTimeout(() => this.cancel(owner, id), 35_000) };
    operation.timer.unref();
    this.operations.set(id, operation);
    // 首次订阅前不启动外部动作，避免创建操作后浏览器离开留下无观察者的请求。
    this.runners.set(id, run);
    return id;
  }

  private readonly runners = new Map<string, (signal: AbortSignal) => Promise<Response>>();

  has(owner: string, id: string): boolean { return this.operations.get(id)?.owner === owner; }

  subscribe(owner: string, id: string, receive: (event: SettingsOperationEvent) => void): () => void {
    const operation = this.operations.get(id);
    if (!operation || operation.owner !== owner) throw new Error("管理操作不存在。");
    receive(operation.event);
    if (operation.event.type === "finished") return () => {};
    operation.subscribers.add(receive);
    const run = this.runners.get(id);
    this.runners.delete(id);
    if (run) {
      void (async () => {
        try {
          const response = await run(operation.controller.signal);
          const result: unknown = await response.json();
          this.finish(operation, { type: "finished", httpStatus: response.status, result });
        } catch {
          this.finish(operation, { type: "finished", httpStatus: 502, result: { status: "failed", detail: "管理操作失败。" } });
        }
      })();
    }
    return () => {
      operation.subscribers.delete(receive);
      if (!operation.subscribers.size && operation.event.type !== "finished") this.cancel(owner, id);
    };
  }

  cancel(owner: string, id: string): boolean {
    const operation = this.operations.get(id);
    if (!operation || operation.owner !== owner) return false;
    if (operation.event.type === "finished") return true;
    operation.controller.abort(); this.runners.delete(id);
    this.finish(operation, { type: "finished", httpStatus: 499, result: { status: "cancelled", detail: "管理操作已取消。" } });
    return true;
  }

  private finish(operation: Operation, event: Extract<SettingsOperationEvent, { type: "finished" }>): void {
    if (operation.event.type === "finished") return;
    operation.event = event;
    clearTimeout(operation.timer);
    for (const receive of operation.subscribers) receive(event);
    operation.subscribers.clear();
  }
}

const globals = globalThis as typeof globalThis & { orbitcodeSettingsOperations?: SettingsOperations };
export const settingsOperations = globals.orbitcodeSettingsOperations ??= new SettingsOperations();
