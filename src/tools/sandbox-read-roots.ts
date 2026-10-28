import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { homedir, tmpdir } from "node:os";

export async function resolveSandboxReadRoots(roots: readonly string[], workspaceRoot: string): Promise<readonly string[]> {
  if (roots.length === 0) return [];
  const boundary = await canonicalPath(path.resolve(workspaceRoot));
  const forbidden = ["/", "/Users", "/home", "/root", "/etc", "/private", "/proc", "/sys", "/dev", "/run", "/var", "/var/run", "/var/tmp", "/tmp", "/Volumes", homedir(), tmpdir()];
  // macOS 的 /tmp、/etc、/var 会规范化到 /private 下，必须连同别名一起拒绝。
  const canonicalForbidden = new Set([...forbidden, ...await Promise.all(forbidden.map(root => realpath(root).catch(() => root)))]);
  const resolved: string[] = [];
  for (const root of roots) {
    if (!path.isAbsolute(root)) throw new Error("只读工具链路径必须为绝对目录。");
    const target = await realpath(root);
    if (canonicalForbidden.has(target) || ["/Users", "/home"].includes(path.dirname(target))) {
      throw new Error("只读工具链目录不能是用户数据或系统状态的整个根目录。");
    }
    if (within(target, boundary) || within(boundary, target)) throw new Error("只读工具链目录不能与工作区或受保护目录重叠。");
    if (!(await lstat(target)).isDirectory()) throw new Error("只读工具链路径必须为目录。");
    resolved.push(target);
  }
  return [...new Set(resolved)];
}

async function canonicalPath(target: string): Promise<string> {
  try { return await realpath(target); }
  catch (error) {
    if (!missing(error) || path.dirname(target) === target) throw error;
    // 首次保存时设置目录可能尚不存在，仍要规范化已有父目录的 /tmp 等别名。
    return path.join(await canonicalPath(path.dirname(target)), path.basename(target));
  }
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
