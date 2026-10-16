import path from "node:path";
import { constants } from "node:fs";
import { mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
export function within(root: string, target: string): boolean {
    const relative = path.relative(root, target);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
export function nodeError(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && error.code === code; }
export async function readBounded(root: string, target: string, maxBytes: number, signal?: AbortSignal): Promise<{
    content: string;
    realPath: string;
}> {
    signal?.throwIfAborted();
    const resolvedRoot = await realpath(root), resolved = await realpath(target);
    if (!within(resolvedRoot, resolved))
        throw new Error("文件超出所属配置目录。");
    const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > maxBytes)
            throw new Error("文件不是普通文件或超过上限。");
        const buffer = Buffer.alloc(maxBytes + 1);
        let used = 0;
        while (used < buffer.length) {
            signal?.throwIfAborted();
            const read = await handle.read(buffer, used, buffer.length - used, used);
            if (!read.bytesRead)
                break;
            used += read.bytesRead;
        }
        const after = await handle.stat(), current = await stat(resolved);
        if (used > maxBytes || before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || current.ino !== before.ino || current.dev !== before.dev || await realpath(target) !== resolved || await realpath(root) !== resolvedRoot)
            throw new Error("文件读取期间发生变化或超过上限。");
        const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, used));
        if (content.includes("\0"))
            throw new Error("文件包含无效文本。");
        return { content, realPath: resolved };
    }
    finally {
        await handle.close();
    }
}
export async function ensureDirectory(root: string, target: string): Promise<void> {
    const lexicalRoot = path.resolve(root), lexicalTarget = path.resolve(target);
    if (!within(lexicalRoot, lexicalTarget))
        throw new Error("目录越界。");
    await mkdir(lexicalRoot, { recursive: true, mode: 0o700 });
    const canonicalRoot = await realpath(lexicalRoot);
    let cursor = lexicalRoot;
    for (const part of path.relative(lexicalRoot, lexicalTarget).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        try {
            await mkdir(cursor, { mode: 0o700 });
        }
        catch (error) {
            if (!nodeError(error, "EEXIST"))
                throw error;
        }
        if (!within(canonicalRoot, await realpath(cursor)))
            throw new Error("目录链接越界。");
    }
}
export async function atomicText(root: string, target: string, content: string): Promise<void> {
    await ensureDirectory(root, path.dirname(target));
    const canonicalRoot = await realpath(root), parent = await realpath(path.dirname(target));
    if (!within(canonicalRoot, parent))
        throw new Error("写入越界。");
    const temporary = path.join(parent, `.${randomUUID()}.tmp`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
        if (await realpath(path.dirname(target)) !== parent || await realpath(root) !== canonicalRoot)
            throw new Error("写入目录已变化。");
        await rename(temporary, path.join(parent, path.basename(target)));
        const directory = await open(parent, constants.O_RDONLY);
        try {
            await directory.sync();
        }
        finally {
            await directory.close();
        }
    }
    finally {
        await handle.close();
        await rm(temporary, { force: true });
    }
}
