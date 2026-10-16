import { createHash } from "node:crypto";
import { isAlias, isMap, isScalar, isSeq, parseDocument, visit } from "yaml";
import { SkillError, type SkillDefinition, type SkillHistory } from "@/core/skills/types";
import type { ToolName } from "@/tools/types";
export const LOCAL_SKILL_TOOLS = new Set<string>(["read_file", "write_file", "write_files", "edit_file", "run_command", "find_files", "search_code", "read_context", "read_memory", "start_process", "process_status", "stop_process", "report_completion", "load_skill", "read_skill_resource"]);
export const hashText = (text: string): string => createHash("sha256").update(text).digest("hex");
export const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const fail = (message: string): never => { throw new SkillError("invalid-definition", message); };
export function parseSkillMetadata(value: unknown): SkillDefinition {
    if (!record(value) || Object.keys(value).some(key => !["name", "description", "allowed-tools", "mode", "history", "model"].includes(key)))
        return fail("Skill 元信息含未知字段或不是对象。");
    if (typeof value.name !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value.name))
        return fail("name 必须为最多 64 字符的小写名称。");
    if (typeof value.description !== "string" || !value.description.trim() || Array.from(value.description).length > 200 || /[\r\n]/u.test(value.description))
        return fail("description 必须为 1—200 字符单行简介。");
    const tools = value["allowed-tools"];
    if (!Array.isArray(tools) || tools.length > 64 || tools.some(tool => typeof tool !== "string" || (!LOCAL_SKILL_TOOLS.has(tool) && !/^mcp__[A-Za-z0-9_-]+$/.test(tool))) || new Set(tools).size !== tools.length)
        return fail("allowed-tools 必须是无重复的精确工具名称数组。");
    if (value.model !== undefined && (typeof value.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.model)))
        return fail("model 必须引用已有模型配置 ID。");
    // 前面的逐项运行时校验建立 ToolName 边界，不接受任意字符串。
    const allowedTools = tools as ToolName[];
    const base = { name: value.name, description: value.description, allowedTools, ...(typeof value.model === "string" ? { model: value.model } : {}) };
    if (value.mode === "shared") {
        if (value.history !== undefined)
            return fail("shared 模式不接受 history。");
        return { ...base, mode: "shared" };
    }
    if (value.mode !== "isolated")
        return fail("mode 只能为 shared 或 isolated。");
    const history = value.history ?? { kind: "none" };
    if (!record(history) || !["none", "all", "recent"].includes(String(history.kind)) || Object.keys(history).some(key => !["kind", ...(history.kind === "recent" ? ["turns"] : [])].includes(key)))
        return fail("history 配置无效。");
    let policy: SkillHistory;
    if (history.kind === "recent") {
        if (typeof history.turns !== "number" || !Number.isInteger(history.turns) || history.turns < 1 || history.turns > 50)
            return fail("history.turns 必须为 1—50 整数。");
        policy = { kind: "recent", turns: history.turns };
    }
    else
        policy = { kind: history.kind === "all" ? "all" : "none" };
    return { ...base, mode: "isolated", history: policy };
}
export function parseSkill(text: string): {
    definition: SkillDefinition;
    body: string;
    hash: string;
} {
    if (Buffer.byteLength(text) > 64 * 1024)
        return fail("Skill 入口超过 64 KiB。");
    const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
    if (!match || Buffer.byteLength(match[1]) > 8192)
        return fail("缺少合法 YAML frontmatter 或元信息超过 8 KiB。");
    const doc = parseDocument(match[1], { uniqueKeys: true, strict: true });
    if (doc.errors.length)
        return fail(`YAML 解析错误：${doc.errors[0].linePos?.[0].line ?? 1} 行。`);
    visit(doc, (_key, node) => { if (isAlias(node) || ((isMap(node) || isSeq(node) || isScalar(node)) && (node.anchor || node.tag)))
        fail("不支持 YAML 锚点、别名或自定义标签。"); });
    if (!match[2].trim())
        return fail("Skill 正文不能为空。");
    return { definition: parseSkillMetadata(doc.toJS({ maxAliasCount: 0 })), body: match[2], hash: hashText(text) };
}
export function argumentWords(text: string): readonly string[] {
    const words: string[] = [];
    let word = "", quote = "", started = false;
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (char === "\\" && index + 1 < text.length && /[\s'"\\]/u.test(text[index + 1])) {
            word += text[++index];
            started = true;
        }
        else if (quote) {
            if (char === quote)
                quote = "";
            else
                word += char;
            started = true;
        }
        else if (char === "'" || char === '"') {
            quote = char;
            started = true;
        }
        else if (/\s/u.test(char)) {
            if (started)
                words.push(word);
            word = "";
            started = false;
        }
        else {
            word += char;
            started = true;
        }
    }
    if (quote)
        throw new SkillError("invalid-arguments", "参数引号未闭合。");
    if (started)
        words.push(word);
    return words;
}
export function substituteSkill(body: string, args: string): string {
    if (Buffer.byteLength(args) > 16 * 1024)
        throw new SkillError("capacity", "Skill 参数超过 16 KiB。");
    const words = argumentWords(args);
    return body.replace(/(\\)?\{\{(arguments|arg:[1-9]\d*)\}\}/g, (match: string, escaped: string | undefined, token: string) => {
        if (escaped)
            return match.slice(1);
        if (token === "arguments")
            return args;
        const value = words[Number(token.slice(4)) - 1];
        if (value === undefined)
            throw new SkillError("invalid-arguments", `缺少参数 ${token}。`);
        return value;
    });
}
