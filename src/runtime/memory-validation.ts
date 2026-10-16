import { parseDocument, isAlias, visit } from "yaml";
import { NOTE_CATEGORIES, type MemoryCandidate, type MemoryEvidenceInput, type MemoryNote, type NoteEvidence, type SavedTurnIdentity } from "@/runtime/memory-types";
export function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function fields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
    return required.every(key => key in value) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
export function safeText(value: unknown, max: number): value is string {
    return typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\0");
}
export function hasSecret(text: string, secrets: readonly string[] = []): boolean {
    return secrets.some(secret => secret.length > 0 && text.includes(secret)) || /(?:\bBearer\s+\S+|\bsk-[\w-]{8,}|(?:api[_ -]?key|password|secret|token)\s*[:=]\s*["']?[^\s"']{4,}|-----BEGIN [\w ]*PRIVATE KEY-----)/i.test(text);
}
export function redactMemoryInput(text: string, secrets: readonly string[]): string {
    let result = text;
    for (const secret of secrets)
        if (secret)
            result = result.split(secret).join("<redacted>");
    return result.replace(/\bBearer\s+\S+|\bsk-[\w-]{8,}|(?:api[_ -]?key|password|secret|token)\s*[:=]\s*["']?[^\s"']{4,}/gi, "<redacted>");
}
function parseEvidence(value: unknown): NoteEvidence {
    if (!isRecord(value))
        throw new Error("笔记证据无效。");
    if (value.kind === "user-stated" && fields(value, ["kind", "messageId"]) && safeText(value.messageId, 128))
        return { kind: value.kind, messageId: value.messageId };
    if (value.kind === "tool-observed" && fields(value, ["kind", "callId"]) && safeText(value.callId, 128))
        return { kind: value.kind, callId: value.callId };
    if (value.kind === "reference-only" && fields(value, ["kind", "source"]) && safeText(value.source, 512) && /^https?:\/\//.test(value.source))
        return { kind: value.kind, source: value.source };
    throw new Error("笔记证据无效。");
}
export function parseCandidate(value: unknown, input?: MemoryEvidenceInput): MemoryCandidate {
    if (!isRecord(value) || !fields(value, ["category", "scope", "title", "description", "body", "evidence"], ["replaces"]) || !NOTE_CATEGORIES.some(x => x === value.category) || (value.scope !== "user" && value.scope !== "project") || !safeText(value.title, 120) || !safeText(value.description, 160) || !safeText(value.body, 16000) || !Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > 16 || (value.replaces !== undefined && !safeId(value.replaces)))
        throw new Error("笔记候选字段无效。");
    if (/^\s*(?:(?:本轮|当前任务|临时)\s*)?进度\s*[:：]\s*\d+%|^\s*(?:stdout|stderr)\s*[:：]/i.test(value.body)) throw new Error("临时进度或孤立日志不能作为长期笔记。");
    const evidence = value.evidence.map(parseEvidence);
    if (hasSecret(JSON.stringify(value), input?.secrets) || /[\r\n]/.test(value.title + value.description))
        throw new Error("笔记包含受限内容。");
    if (input)
        for (const item of evidence) {
            if (item.kind === "user-stated" && !input.userMessages.has(item.messageId))
                throw new Error("笔记引用不存在的用户消息。");
            if (item.kind === "tool-observed" && !input.toolCalls.has(item.callId))
                throw new Error("笔记引用不存在的工具观察。");
            if (item.kind === "reference-only" && input.userTexts && ![...input.userTexts.values()].some(text => text.includes(item.source)))
                throw new Error("参考来源未经支持。");
        }
    if (value.scope === "user" && (value.category !== "preference" || !evidence.some(x => x.kind === "user-stated")))
        throw new Error("用户级笔记缺少跨项目偏好证据。");
    if (input?.userTexts && value.scope === "user" && !evidence.some(x => x.kind === "user-stated" && /所有项目|跨项目|以后都|始终|always|all projects/i.test(input.userTexts?.get(x.messageId) ?? "")))
        throw new Error("跨项目偏好未明确表达。");
    if (value.category === "project-knowledge" && !evidence.some(x => x.kind === "user-stated" || x.kind === "tool-observed"))
        throw new Error("项目知识缺少事实来源。");
    if (value.category === "reference" && !evidence.some(x => x.kind === "reference-only"))
        throw new Error("参考资料缺少来源。");
    if (value.replaces && value.category !== "correction")
        throw new Error("仅明确纠正可替代旧笔记。");
    if (value.replaces && input?.userTexts && !evidence.some(x => x.kind === "user-stated" && /纠正|更正|改为|不再|应该是|correct|instead/i.test(input.userTexts?.get(x.messageId) ?? "")))
        throw new Error("替代笔记缺少明确纠正。");
    if (value.replaces && input?.replaceableNotes && input.replaceableNotes.get(value.replaces) !== value.scope)
        throw new Error("替代目标不存在于本轮允许的同作用域笔记中。");
    if (value.category === "preference" && input?.userTexts && !evidence.some(x => x.kind === "user-stated" && isPreferenceStatement(input.userTexts?.get(x.messageId) ?? "")))
        throw new Error("偏好询问或旧笔记读取不是新的用户偏好声明。");
    const category = NOTE_CATEGORIES.find(x => x === value.category);
    if (!category)
        throw new Error("笔记类别无效。");
    return { category, scope: value.scope, title: value.title, description: value.description, body: value.body, evidence, ...(typeof value.replaces === "string" ? { replaces: value.replaces } : {}) };
}
function isPreferenceStatement(text: string): boolean {
    // 仅排除明显的偏好询问，不把普通用户表达强制限定为固定句式。
    const question = /(?:偏好|要求|格式|结构)[\s\S]{0,40}(?:是什么|有哪些|什么|如何|是否)|(?:what|which)[\s\S]{0,40}(?:prefer|preference)/i.test(text);
    return !question || /请记住|请保存|我要求|我的偏好是|我偏好|今后|以后|i prefer|please remember/i.test(text);
}
export function safeId(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value); }
export function parseTurnIdentity(value: unknown): SavedTurnIdentity {
    if (!isRecord(value) || !fields(value, ["conversationId", "turnId", "savedRevision", "lifecycleEpoch"]) || !safeId(value.conversationId) || !safeId(value.turnId) || !safeId(value.lifecycleEpoch) || typeof value.savedRevision !== "number" || !Number.isSafeInteger(value.savedRevision) || value.savedRevision < 0)
        throw new Error("笔记来源无效。");
    return { conversationId: value.conversationId, turnId: value.turnId, savedRevision: value.savedRevision, lifecycleEpoch: value.lifecycleEpoch };
}
export function serializeNote(note: MemoryNote): string {
    const { body, ...meta } = note;
    return `---\n${JSON.stringify(meta, null, 2)}\n---\n${body}\n`;
}
export function parseNote(markdown: string): MemoryNote {
    if (Buffer.byteLength(markdown, "utf8") > 16000 || markdown.includes("\0"))
        throw new Error("笔记过长或无效。");
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(markdown);
    if (!match)
        throw new Error("笔记缺少 frontmatter。");
    const doc = parseDocument(match[1], { uniqueKeys: true });
    let alias = false;
    visit(doc, (_, node) => { if (isAlias(node))
        alias = true; });
    if (alias || doc.errors.length || doc.warnings.length)
        throw new Error("笔记 frontmatter 无效。");
    const meta: unknown = doc.toJS({ maxAliasCount: 0 });
    if (!isRecord(meta) || !fields(meta, ["id", "category", "scope", "title", "description", "evidence", "createdAt", "updatedAt", "sources"], ["replaces"]) || !safeId(meta.id) || typeof meta.createdAt !== "string" || !Number.isFinite(Date.parse(meta.createdAt)) || typeof meta.updatedAt !== "string" || !Number.isFinite(Date.parse(meta.updatedAt)) || !Array.isArray(meta.sources) || !meta.sources.length || meta.sources.length > 64)
        throw new Error("笔记元信息无效。");
    const { id, createdAt, updatedAt, sources, ...candidate } = meta;
    return { ...parseCandidate({ ...candidate, body: match[2].trimEnd() }), id, createdAt, updatedAt, sources: sources.map(parseTurnIdentity) };
}
