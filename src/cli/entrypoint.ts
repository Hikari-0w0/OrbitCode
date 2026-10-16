import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isCliEntrypoint(moduleUrl: string, entryPath: string | undefined): boolean {
    if (!entryPath) return false;
    try {
        // Node 会规范化模块 URL；启动参数可能仍是符号链接或 macOS /var 的别名路径。
        return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entryPath);
    } catch {
        return false;
    }
}
