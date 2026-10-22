export type ExecutionOutcome<T> = {
  readonly result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
  readonly cleanup: "complete" | "failed";
  readonly started: boolean;
};

type ReadyExecution = { start(): void };

// 资源等待与模型执行分开计数；所有就绪的子执行共用同一条 FIFO 队列。
export class ChildExecutionScheduler {
  private readonly ready: ReadyExecution[] = [];
  private readonly operations = new Set<Promise<unknown>>();
  private readonly shutdown = new AbortController();
  private running = 0;
  private closed = false;
  private closing?: Promise<void>;
  private queueMutationDepth = 0;
  private pumping = false;

  constructor(private concurrency: number) { this.validate(concurrency); }

  configure(concurrency: number): void {
    this.validate(concurrency);
    this.concurrency = concurrency;
    this.pump();
  }

  run<T>(input: {
    readonly signal: AbortSignal;
    readonly acquire?: (signal: AbortSignal) => Promise<void>;
    readonly execute: (signal: AbortSignal) => Promise<T>;
    readonly cleanup?: () => Promise<void>;
    readonly onQueued?: () => void;
    readonly onStart?: () => void;
  }): Promise<ExecutionOutcome<T>> {
    const signal = AbortSignal.any([input.signal, this.shutdown.signal]);
    let resolve!: (outcome: ExecutionOutcome<T>) => void;
    const operation = new Promise<ExecutionOutcome<T>>(settle => { resolve = settle; });
    // 接纳先于任何用户回调；回调同步关闭调度器时，本次执行也必须属于回收屏障。
    this.operations.add(operation);
    void operation.then(() => this.operations.delete(operation));
    const begin = () => {
      let finishing = false;
      let started = false;
      let slotHeld = false;
      let request: ReadyExecution | undefined;
      const finish = async (result: ExecutionOutcome<T>["result"]) => {
        if (finishing) return;
        finishing = true;
        signal.removeEventListener("abort", abortQueued);
        if (request) {
          const index = this.ready.indexOf(request);
          if (index >= 0) this.ready.splice(index, 1);
        }
        let cleanup: ExecutionOutcome<T>["cleanup"] = "complete";
        try { await input.cleanup?.(); } catch { cleanup = "failed"; }
        if (slotHeld) { slotHeld = false; this.running--; }
        this.pump();
        resolve({ result, cleanup, started });
      };
      const abortQueued = () => { void finish({ ok: false, error: signal.reason }); };
      const enqueue = () => this.mutateQueue(() => {
        if (signal.aborted || this.closed) { abortQueued(); return; }
        request = {
          start: () => {
            slotHeld = true;
            signal.removeEventListener("abort", abortQueued);
            void (async () => {
              try {
                signal.throwIfAborted();
                input.onStart?.();
                signal.throwIfAborted();
                started = true;
                const value = await input.execute(signal);
                await finish({ ok: true, value });
              } catch (error) { await finish({ ok: false, error }); }
            })();
          },
        };
        signal.addEventListener("abort", abortQueued, { once: true });
        this.ready.push(request);
        // 先登记就绪顺序再通知；回调重入接纳/配置时不能越过当前任务或提前启动它。
        try { input.onQueued?.(); } catch (error) { void finish({ ok: false, error }); return; }
        if (signal.aborted || this.closed) abortQueued();
      });
      if (this.closed || signal.aborted) { abortQueued(); return; }
      const acquire = input.acquire;
      if (acquire) {
        // 取消必须等取得资源的操作收敛，随后统一清理部分初始化结果。
        void (async () => {
          try { await acquire(signal); enqueue(); }
          catch (error) { await finish({ ok: false, error }); }
        })();
      } else enqueue();
    };
    begin();
    return operation;
  }

  // 屏障只覆盖关闭前接纳的操作；关闭后调用 run 的调用方仍须等待其拒绝/清理结果。
  // 回调可以发起关闭，但不能等待包含自身的屏障，否则会形成自等待。
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    // 先发布同一个屏障再广播取消，取消处理中的重入关闭不能观察到半完成状态。
    this.closing = Promise.all([...this.operations]).then(() => {});
    this.shutdown.abort(new Error("子执行调度器已关闭。"));
    return this.closing;
  }

  private validate(concurrency: number): void {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("子执行并发必须为正整数。");
  }

  private pump(): void {
    if (this.closed || this.queueMutationDepth > 0 || this.pumping) return;
    this.pumping = true;
    try {
      while (!this.closed && this.running < this.concurrency && this.ready.length) {
        const request = this.ready.shift();
        if (!request) break;
        this.running++;
        request.start();
      }
    } finally { this.pumping = false; }
  }

  private mutateQueue(action: () => void): void {
    this.queueMutationDepth++;
    try { action(); }
    finally { this.queueMutationDepth--; this.pump(); }
  }
}
