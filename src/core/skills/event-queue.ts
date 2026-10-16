export class SkillEventQueue<T> {
    private readonly values: T[] = [];
    private readonly readers = new Set<() => void>();
    private readonly writers = new Set<() => void>();
    private closed = false;
    constructor(private readonly capacity = 128) { }
    private release(waiters: Set<() => void>): void { for (const resolve of waiters)
        resolve(); waiters.clear(); }
    async push(value: T): Promise<void> {
        while (!this.closed && this.values.length >= this.capacity)
            await new Promise<void>(resolve => { this.writers.add(resolve); });
        if (this.closed)
            return;
        this.values.push(value);
        this.release(this.readers);
    }
    async next(): Promise<T | undefined> {
        while (!this.closed && !this.values.length)
            await new Promise<void>(resolve => { this.readers.add(resolve); });
        const value = this.values.shift();
        this.release(this.writers);
        return value;
    }
    close(): void { this.closed = true; this.release(this.readers); this.release(this.writers); }
}
