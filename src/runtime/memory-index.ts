import type { MemoryNote } from "@/runtime/memory-types";
export function buildMemoryIndex(notes: readonly MemoryNote[]): string {
    const index = notes.map(note => `${note.id}\t${note.category}\t${JSON.stringify(note.description)}\n`).join("");
    if (Buffer.byteLength(index) > 25000 || notes.length > 200)
        throw new Error("记忆索引容量不足。");
    return index;
}
export function validateIndexSize(index: string): boolean {
    const lines = index.endsWith("\n") ? index.slice(0, -1).split("\n") : index.split("\n");
    return Buffer.byteLength(index) <= 25000 && (index === "" || lines.length <= 200);
}
