export type MarkdownBlock = {
    kind: "paragraph" | "quote";
    text: string;
} | {
    kind: "heading";
    level: number;
    text: string;
} | {
    kind: "code";
    language: string;
    text: string;
} | {
    kind: "list";
    ordered: boolean;
    items: readonly string[];
} | {
    kind: "table";
    rows: readonly (readonly string[])[];
};
export function safeLink(value: string): string | undefined {
    try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
    }
    catch {
        return undefined;
    }
}
export function parseMarkdown(source: string): readonly MarkdownBlock[] {
    if (source.length > 128000)
        return [{ kind: "paragraph", text: source }];
    const lines = source.replace(/\r\n/g, "\n").split("\n");
    const blocks: MarkdownBlock[] = [];
    const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map(cell => cell.trim());
    for (let index = 0; index < lines.length;) {
        const line = lines[index];
        if (!line.trim()) {
            index++;
            continue;
        }
        const fence = /^\s*(`{3,}|~{3,})([^\s]*)\s*$/.exec(line);
        if (fence) {
            const body: string[] = [];
            index++;
            while (index < lines.length && !lines[index].trim().startsWith(fence[1]))
                body.push(lines[index++]);
            if (index < lines.length)
                index++;
            blocks.push({ kind: "code", language: fence[2], text: body.join("\n") });
            continue;
        }
        const heading = /^(#{1,6})\s+(.+)$/.exec(line);
        if (heading) {
            blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
            index++;
            continue;
        }
        if (line.includes("|") && index + 1 < lines.length && cells(lines[index + 1]).every(cell => /^:?-{3,}:?$/.test(cell))) {
            const rows = [cells(line)];
            index += 2;
            while (index < lines.length && lines[index].includes("|"))
                rows.push(cells(lines[index++]));
            blocks.push({ kind: "table", rows });
            continue;
        }
        const list = /^(\s*)([-*+] |\d+\. )(.+)$/.exec(line);
        if (list && list[1].length <= 8) {
            const ordered = /\d/.test(list[2]);
            const items: string[] = [];
            while (index < lines.length) {
                const item = /^\s*([-*+] |\d+\. )(.+)$/.exec(lines[index]);
                if (!item || /\d/.test(item[1]) !== ordered)
                    break;
                items.push(item[2]);
                index++;
            }
            blocks.push({ kind: "list", ordered, items });
            continue;
        }
        if (line.startsWith("> ")) {
            blocks.push({ kind: "quote", text: line.slice(2) });
            index++;
            continue;
        }
        const paragraph = [line];
        index++;
        while (index < lines.length && lines[index].trim() && !/^(#{1,6}\s|\s*```|\s*~~~|> |\s*[-*+] |\s*\d+\. )/.test(lines[index]) && !(lines[index].includes("|") && index + 1 < lines.length && cells(lines[index + 1]).every(cell => /^:?-{3,}:?$/.test(cell))))
            paragraph.push(lines[index++]);
        blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
    }
    return blocks;
}
