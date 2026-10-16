import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, rm } from "node:fs/promises";
import path from "node:path";
import { ensureDirectory } from "@/lib/bounded-files";
export class LocalFileLockError extends Error {
  constructor(readonly kind: "storage" | "conflict" | "invalid", message: string, options?: ErrorOptions) { super(message, options); }
}

export async function acquireLocalFileLock(directory: string, name: string, waitMs = 2000): Promise<() => Promise<void>> {
    const lockPath = path.join(directory, `.${name}.lock`);
    const candidate = path.join(directory, `.${name === "settings-v1" ? "settings" : name}-owner-${randomUUID()}.tmp`);
    const owner = await open(candidate, "wx", 0o600);
    try {
        await owner.writeFile(JSON.stringify({ pid: process.pid }));
        await owner.sync();
    }
    catch (error) { await rm(candidate, {force: true}); throw error; }
    finally {
        await owner.close();
    }
    const candidateInfo = await lstat(candidate);
    const started = Date.now();
    try {
        for (;;) {
            try {
                // 完整 owner 文件通过硬链接竞争，避免崩溃留下无主的空锁。
                await link(candidate, lockPath);
                break;
            }
            catch (error) {
                if (!hasCode(error, "EEXIST"))
                    throw new LocalFileLockError("storage", "无法锁定本地资料。", { cause: error });
                await reapExitedOwner(directory, lockPath, name);
                if (Date.now() - started >= waitMs)
                    throw new LocalFileLockError("conflict", "本地资料正在由另一进程修改，请重试。");
                await new Promise((resolve) => setTimeout(resolve, 40));
            }
        }
    }
    finally {
        await rm(candidate, { force: true });
    }
    return async () => {
        const current = await lstat(lockPath).catch(() => undefined);
        if (current?.ino === candidateInfo.ino && current.dev === candidateInfo.dev)
            await rm(lockPath);
    };
}
async function reapExitedOwner(directory: string, lockPath: string, name: string): Promise<void> {
    const claimPath = path.join(directory, `.${name}.reap`);
    let claim;
    try {
        claim = await open(claimPath, "wx", 0o600);
    }
    catch (error) {
        if (hasCode(error, "EEXIST"))
            return;
        throw error;
    }
    try {
        let file;
        try {
            file = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        }
        catch (error) {
            if (hasCode(error, "ENOENT"))
                return;
            throw new LocalFileLockError("invalid", "本地资料锁类型无效。", { cause: error });
        }
        try {
            const info = await file.stat();
            if (!info.isFile() || info.size > 256)
                throw new LocalFileLockError("invalid", "本地资料锁结构无效。");
            let value: unknown;
            try {
                value = JSON.parse(await file.readFile("utf8"));
            }
            catch {
                throw new LocalFileLockError("invalid", "本地资料锁结构无效，请保留文件并检查。");
            }
            if (typeof value !== "object" || value === null || !("pid" in value) || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid < 1)
                throw new LocalFileLockError("invalid", "本地资料锁 owner 无效。");
            try {
                process.kill(value.pid, 0);
                return;
            }
            catch (error) {
                if (!hasCode(error, "ESRCH"))
                    return;
            }
            const current = await lstat(lockPath).catch(() => undefined);
            if (current?.ino === info.ino && current.dev === info.dev)
                await rm(lockPath);
        }
        finally {
            await file.close();
        }
    }
    finally {
        await claim.close();
        await rm(claimPath, { force: true });
    }
}
function hasCode(value: unknown, code: string): boolean {
    return typeof value === "object" && value !== null && "code" in value && value.code === code;
}
export async function withFileLock<T>(directory: string, name: string, action: () => Promise<T>): Promise<T> {
    await ensureDirectory(directory, directory);
    const release = await acquireLocalFileLock(directory, name);
    try {
        return await action();
    }
    finally {
        await release();
    }
}
