"use client";
import { memo, useMemo, useState, type ReactNode } from "react";
import { parseMarkdown, safeLink } from "./markdown-content";
function InlineText({ text }: {
    readonly text: string;
}) {
    const result: ReactNode[] = [];
    // 有界扫描，只识别无嵌套行内标记；其他内容保持原文。
    const pattern = /(`[^`\n]{1,2000}`|\*\*[^*\n]{1,2000}\*\*|\[[^\]\n]{1,1000}\]\([^\s)]{1,2000}\))/g;
    let offset = 0;
    for (const match of text.matchAll(pattern)) {
        const index = match.index;
        result.push(text.slice(offset, index));
        const token = match[0];
        if (token.startsWith("`"))
            result.push(<code key={index}>{token.slice(1, -1)}</code>);
        else if (token.startsWith("**"))
            result.push(<strong key={index}>{token.slice(2, -2)}</strong>);
        else {
            const split = token.indexOf("](");
            const href = safeLink(token.slice(split + 2, -1));
            result.push(href ? <a key={index} href={href} target="_blank" rel="noopener noreferrer">{token.slice(1, split)}</a> : token);
        }
        offset = index + token.length;
    }
    result.push(text.slice(offset));
    return <>{result}</>;
}
export function CopyButton({ text, label = "复制" }: {
    readonly text: string;
    readonly label?: string;
}) {
    const [status, setStatus] = useState("");
    async function copy() { try {
        await navigator.clipboard.writeText(text);
        setStatus("已复制");
    }
    catch {
        setStatus("复制失败，请选择原文复制");
    } }
    return <span className="copyAction"><button type="button" onClick={() => void copy()} aria-label={label}>{label}</button>{status && <span role="status">{status}</span>}</span>;
}
export const MessageContent = memo(function MessageContent({ text }: {
    readonly text: string;
}) {
    const blocks = useMemo(() => parseMarkdown(text), [text]);
    return <div className="messageText markdownContent">{blocks.map((block, index) => {
            if (block.kind === "code")
                return <div className="codeBlock" key={index}><div className="codeToolbar"><span>{block.language || "代码"}</span><CopyButton text={block.text} label="复制代码"/></div><pre><code>{block.text}</code></pre></div>;
            if (block.kind === "heading")
                return <div key={index} role="heading" aria-level={Math.min(6, block.level + 1)} className={`markdownHeading markdownHeading--${block.level}`}><InlineText text={block.text}/></div>;
            if (block.kind === "quote")
                return <blockquote key={index}><InlineText text={block.text}/></blockquote>;
            if (block.kind === "list") {
                const items = block.items.map((item, i) => <li key={i}><InlineText text={item}/></li>);
                return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
            }
            if (block.kind === "table")
                return <div className="tableViewport" key={index}><table><thead><tr>{block.rows[0].map((cell, i) => <th key={i}><InlineText text={cell}/></th>)}</tr></thead><tbody>{block.rows.slice(1).map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}><InlineText text={cell}/></td>)}</tr>)}</tbody></table></div>;
            return <p key={index}><InlineText text={block.text}/></p>;
        })}</div>;
});
