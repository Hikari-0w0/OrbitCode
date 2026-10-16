export const NOTE_CATEGORIES = ["preference", "correction", "project-knowledge", "reference"] as const;
export type NoteCategory = typeof NOTE_CATEGORIES[number];
export type MemoryScope = "user" | "project";
export type NoteEvidence = {
    readonly kind: "user-stated";
    readonly messageId: string;
} | {
    readonly kind: "tool-observed";
    readonly callId: string;
} | {
    readonly kind: "reference-only";
    readonly source: string;
};
export type SavedTurnIdentity = {
    readonly conversationId: string;
    readonly turnId: string;
    readonly savedRevision: number;
    readonly lifecycleEpoch: string;
};
export type MemoryCandidate = {
    readonly category: NoteCategory;
    readonly scope: MemoryScope;
    readonly title: string;
    readonly description: string;
    readonly body: string;
    readonly evidence: readonly NoteEvidence[];
    readonly replaces?: string;
};
export type MemoryNote = MemoryCandidate & {
    readonly id: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly sources: readonly SavedTurnIdentity[];
};
export type MemoryJobState = {
    readonly source: SavedTurnIdentity;
    readonly status: "queued" | "running" | "saved" | "skipped" | "failed" | "abandoned";
    readonly detail: string;
    readonly noteIds: readonly string[];
};
export type MemorySnapshot = {
    readonly revision: string;
    readonly index: string;
    readonly notes: readonly MemoryNote[];
    readonly hashes: Readonly<Record<string, string>>;
};
export type MemoryWriteResult = {
    readonly status: "saved";
    readonly revision: string;
    readonly noteIds: readonly string[];
} | {
    readonly status: "rejected";
    readonly reason: "invalid" | "capacity" | "conflict" | "disabled" | "source-retired";
};
export type MemoryEvidenceInput = {
    readonly userMessages: ReadonlySet<string>;
    readonly toolCalls: ReadonlySet<string>;
    readonly userTexts?: ReadonlyMap<string, string>;
    readonly secrets?: readonly string[];
    readonly replaceableNotes?: ReadonlyMap<string, MemoryScope>;
};
