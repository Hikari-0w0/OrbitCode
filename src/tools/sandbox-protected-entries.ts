import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { isProtectedPath } from "@/tools/protected-paths";

export type SandboxProtectedEntry = { readonly path: string; readonly directory: boolean };

export async function collectSandboxProtectedEntries(root: string, signal?: AbortSignal): Promise<readonly SandboxProtectedEntry[]> {
  const entries: { path: string; directory: boolean; inode: string; protected: boolean }[] = [];
  const protectedInodes = new Set<string>();
  let visited = 0;
  async function visit(directory: string, base: string, hiddenParent = false): Promise<void> {
    signal?.throwIfAborted();
    const children = await readdir(directory, { withFileTypes: true });
    // 有界批量stat避免大仓库串行I/O拖慢每条命令，也不积累整个目录树的并发请求。
    for (let offset = 0; offset < children.length; offset += 32) {
      signal?.throwIfAborted();
      const inspected = await Promise.all(children.slice(offset, offset + 32).map(async entry => ({ entry, info: await lstat(path.join(directory, entry.name)) })));
      for (const { entry, info } of inspected) {
        signal?.throwIfAborted();
        if (++visited > 250_000) throw new Error("工作区安全扫描超过250000项，未执行命令。");
        const relative = base ? `${base}/${entry.name}` : entry.name;
        const target = path.join(directory, entry.name);
        const inode = `${info.dev}:${info.ino}`;
        const protectedEntry = hiddenParent || isProtectedPath(relative) || relative === ".orbitcode";
        // 不遍历符号链接；敏感链接的工作区内真实目标另外识别。
        if (!info.isSymbolicLink() && !hiddenParent) entries.push({ path: target, directory: info.isDirectory(), inode, protected: protectedEntry });
        if (protectedEntry && info.isFile()) protectedInodes.add(inode);
        if (info.isSymbolicLink() && protectedEntry) {
          const resolved = await realpath(target).catch(error => { if (missing(error)) return undefined; throw error; });
          if (resolved && within(root, resolved)) {
            if (resolved === root) throw new Error("敏感路径链接指向整个工作区，无法安全隔离。");
            const targetInfo = await lstat(resolved);
            protectedInodes.add(`${targetInfo.dev}:${targetInfo.ino}`);
          }
        }
        if (info.isDirectory()) await visit(target, relative, protectedEntry);
      }
    }
  }
  await visit(root, "");
  const candidates = entries.filter(entry => entry.protected || protectedInodes.has(entry.inode)).sort((left, right) => left.path.length - right.path.length);
  const result: { path: string; directory: boolean }[] = [];
  const directories: string[] = [];
  for (const entry of candidates) {
    // 遮蔽父目录后再挂载子路径会失败；保留目录外的硬链接别名即可。
    if (directories.some(directory => entry.path.startsWith(`${directory}${path.sep}`))) continue;
    result.push({ path: entry.path, directory: entry.directory });
    if (entry.directory) directories.push(entry.path);
  }
  return result;
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
