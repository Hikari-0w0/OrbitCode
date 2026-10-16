export class MemoryJobs {
    constructor(private readonly timeoutSignal: (milliseconds: number) => AbortSignal = milliseconds => AbortSignal.timeout(milliseconds)) {}
    private readonly queued: {
        key: string;
        run: (signal: AbortSignal) => Promise<void>;
        cancel: () => void;
    }[] = [];
    private active?: {
        key: string;
        controller: AbortController;
    };
    private closed = false;
    private readonly idleWaiters: (() => void)[] = [];
    enqueue(key: string, run: (signal: AbortSignal) => Promise<void>, cancel: () => void): boolean {
        if (this.closed || this.queued.length >= 8 || this.active?.key === key || this.queued.some(x => x.key === key))
            return false;
        this.queued.push({ key, run, cancel });
        queueMicrotask(() => void this.pump());
        return true;
    }
    private async pump() {
        if (this.active)
            return;
        const next = this.queued.shift();
        if (!next) {
            for (const resolve of this.idleWaiters.splice(0))
                resolve();
            return;
        }
        const controller = new AbortController();
        this.active = { key: next.key, controller };
        try {
            await next.run(AbortSignal.any([controller.signal, this.timeoutSignal(30000)]));
        }
        catch { }
        finally {
            this.active = undefined;
            void this.pump();
        }
    }
    cancel(prefix: string) { if (this.active?.key.startsWith(prefix))
        this.active.controller.abort(); for (let i = this.queued.length - 1; i >= 0; i--)
        if (this.queued[i].key.startsWith(prefix)) {
            this.queued.splice(i, 1)[0].cancel();
        } }
    close() { this.closed = true; this.cancel(""); }
    idle(): Promise<void> { return this.active || this.queued.length ? new Promise(resolve => this.idleWaiters.push(resolve)) : Promise.resolve(); }
}
