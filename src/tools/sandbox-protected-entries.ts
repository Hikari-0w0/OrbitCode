import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { isProtectedPath } from "@/tools/protected-paths";
import { SandboxPreparationError } from "@/tools/sandbox-error";
import { readPublicNpmrc } from "@/tools/public-npmrc";

export type SandboxProtectedEntry = { readonly path: string; readonly directory: boolean; readonly publicNpmrc?: string };

export async function collectSandboxProtectedEntries(root: string | readonly string[], signal?: AbortSignal, maxEntries = 250_000, npmrcAccess: "blocked" | "public-only" = "blocked", environmentFileAccess: "blocked" | "allow" = "blocked"): Promise<readonly SandboxProtectedEntry[]> {
  const roots = typeof root === "string" ? [root] : root;
  const entries: { path: string; directory: boolean; inode: string; protected: boolean; publicNpmrc?: string }[] = [];
  const protectedInodes = new Set<string>();
  const publicInodes = new Map<string, string>();
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
        if (++visited > maxEntries) throw new SandboxPreparationError(`工作区安全扫描超过${maxEntries}项，未执行命令；可在命令安全设置中调整容量。`);
        const relative = base ? `${base}/${entry.name}` : entry.name;
        const target = path.join(directory, entry.name);
        const inode = `${info.dev}:${info.ino}`;
        const publicNpmrc = !hiddenParent && entry.name === ".npmrc" && info.isFile() && npmrcAccess === "public-only" ? await readPublicNpmrc(target, info) : undefined;
        // 环境文件放开不覆盖其他凭据路径、隐藏父目录或同 inode 的保护。
        const protectedEntry = hiddenParent || (isProtectedPath(relative, environmentFileAccess) && publicNpmrc === undefined) || relative === ".orbitcode";
        // 不遍历符号链接；敏感链接的工作区内真实目标另外识别。
        if (!info.isSymbolicLink() && !hiddenParent) entries.push({ path: target, directory: info.isDirectory(), inode, protected: protectedEntry, ...(publicNpmrc === undefined ? {} : { publicNpmrc }) });
        if (publicNpmrc !== undefined) publicInodes.set(inode, publicNpmrc);
        if (protectedEntry && info.isFile()) protectedInodes.add(inode);
        if (info.isSymbolicLink() && protectedEntry) {
          const resolved = await realpath(target).catch(error => { if (missing(error)) return undefined; throw error; });
          if (resolved && roots.some(directory => within(directory, resolved))) {
            if (roots.includes(resolved)) throw new Error("敏感路径链接指向整个授权目录，无法安全隔离。");
            const targetInfo = await lstat(resolved);
            protectedInodes.add(`${targetInfo.dev}:${targetInfo.ino}`);
          }
        }
        if (info.isDirectory()) await visit(target, relative, protectedEntry);
      }
    }
  }
  for (const directory of roots) await visit(directory, "");
  const candidates = entries.filter(entry => entry.protected || protectedInodes.has(entry.inode) || publicInodes.has(entry.inode)).sort((left, right) => left.path.length - right.path.length);
  const result: SandboxProtectedEntry[] = [];
  const directories: string[] = [];
  for (const entry of candidates) {
    // 遮蔽父目录后再挂载子路径会失败；保留目录外的硬链接别名即可。
    if (directories.some(directory => entry.path.startsWith(`${directory}${path.sep}`))) continue;
    const publicNpmrc = !entry.protected && !protectedInodes.has(entry.inode) ? publicInodes.get(entry.inode) : undefined;
    result.push({ path: entry.path, directory: entry.directory, ...(publicNpmrc === undefined ? {} : { publicNpmrc }) });
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
