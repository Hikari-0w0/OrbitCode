type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export function createDraftStore(storage: () => DraftStorage | undefined) {
    const memory = new Map<string, string>();
    let persistent = true;
    const key = (id: string) => `orbitcode.draft.v1:${id || "new"}`;
    return {
        read(id: string): string {
            if (memory.has(id))
                return memory.get(id) ?? "";
            try {
                return storage()?.getItem(key(id)) ?? "";
            }
            catch {
                persistent = false;
                return "";
            }
        },
        write(id: string, text: string): void {
            memory.set(id, text);
            try {
                const target = storage();
                if (!target)
                    persistent = false;
                else
                    target.setItem(key(id), text);
            }
            catch {
                persistent = false;
            }
        },
        remove(id: string): void {
            memory.delete(id);
            try {
                storage()?.removeItem(key(id));
            }
            catch {
                persistent = false;
            }
        },
        get persistent() { return persistent; },
    };
}
