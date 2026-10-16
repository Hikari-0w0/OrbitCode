import { isProtectedPath } from "@/tools/protected-paths";
import path from "node:path";
import { realpath, lstat } from "node:fs/promises";
import { nodeError, readBounded, within } from "@/lib/bounded-files";
import type { InstructionLoadResult, InstructionSource, LoadedInstruction, BackgroundDiagnostic } from "@/runtime/background-types";
export async function loadInstructions(input: {
    workspaceRoot: string;
    userConfigRoot: string;
    signal?: AbortSignal;
}): Promise<InstructionLoadResult> {
    const signal = AbortSignal.any([AbortSignal.timeout(5000), ...(input.signal ? [input.signal] : [])]);
    let source: InstructionSource = "user";
    const failure = (): InstructionLoadResult => ({status: "blocked", source, detail: "指令加载已取消或超过 5 秒限制。"});
    if (signal.aborted) return failure();
    let remove = () => {};
    const cancelled = new Promise<InstructionLoadResult>(resolve => {
        const onAbort = () => resolve(failure());
        signal.addEventListener("abort", onAbort, {once: true});
        remove = () => signal.removeEventListener("abort", onAbort);
    });
    try { return await Promise.race([expandInstructions(input, signal, selected => { source = selected; }), cancelled]); }
    finally { remove(); }
}

async function expandInstructions(input: {workspaceRoot: string; userConfigRoot: string}, signal: AbortSignal, selected: (source: InstructionSource) => void): Promise<InstructionLoadResult> {
    const instructions: LoadedInstruction[] = [], diagnostics: BackgroundDiagnostic[] = [];
    let total = 0;
    const sources: readonly [
        InstructionSource,
        string,
        string
    ][] = [
        ["user", input.userConfigRoot, path.join(input.userConfigRoot, "instructions.md")],
        ["project-agents", input.workspaceRoot, path.join(input.workspaceRoot, "AGENTS.md")],
        ["project-instructions", path.join(input.workspaceRoot, ".orbitcode"), path.join(input.workspaceRoot, ".orbitcode", "instructions.md")],
    ];
    for (const [source, root, file] of sources) {
        selected(source);
        signal.throwIfAborted();
        const visited = new Set<string>(), files: string[] = [];
        try {
            try {
                await lstat(file);
            }
            catch (error) {
                if (nodeError(error, "ENOENT"))
                    continue;
                throw error;
            }
            const rootReal = await realpath(/* turbopackIgnore: true */ root);
            if (source !== "user" && !within(await realpath(input.workspaceRoot), rootReal))
                throw new Error("项目配置目录链接越界。");
            const expand = async (target: string, depth: number): Promise<string> => {
                signal.throwIfAborted();
                if (depth > 5)
                    throw new Error("引用超过 5 层。");
                const resolved = await realpath(target);
                if (!within(rootReal, resolved))
                    throw new Error("引用超出所属配置目录。");
                if (visited.has(resolved)) {
                    diagnostics.push({ source, detail: "重复或循环引用已跳过。" });
                    return "";
                }
                if (visited.size >= 32)
                    throw new Error("引用超过 32 个文件。");
                if (isProtectedPath(path.relative(rootReal, resolved).split(path.sep).join("/")))
                    throw new Error("引用包含受保护资料。");
                const { content } = await readBounded(root, target, 16000, signal);
                visited.add(resolved);
                files.push(path.relative(rootReal, resolved));
                const chunks: string[] = [];
                for (const line of content.split(/\r?\n/)) {
                    if (/^\s*@include\b/.test(line)) {
                        const match = /^\s*@include\s+<([^<>]+)>\s*$/.exec(line);
                        if (!match || path.isAbsolute(match[1]) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(match[1]) || match[1].includes("\\"))
                            throw new Error("include 必须使用本地相对路径。");
                        const next = path.resolve(path.dirname(target), match[1]);
                        if (!within(path.resolve(/* turbopackIgnore: true */ root), next))
                            throw new Error("引用超出所属配置目录。");
                        chunks.push(await expand(next, depth + 1));
                    }
                    else {
                        const text = line + "\n";
                        total += Buffer.byteLength(text);
                        if (total > 48000)
                            throw new Error("指令累计超过 48,000 字节。");
                        chunks.push(text);
                    }
                }
                return chunks.join("");
            };
            instructions.push({ source, content: await expand(file, 0), files });
        }
        catch {
            return { status: "blocked", source, detail: "指令读取失败：请检查文件权限、引用边界、5 层深度与文件体积限制。" };
        }
    }
    return { status: "ready", instructions, diagnostics };
}
