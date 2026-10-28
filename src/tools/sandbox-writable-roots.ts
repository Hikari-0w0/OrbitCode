import path from "node:path";
import { realpath } from "node:fs/promises";
import { resolveSandboxReadRoots } from "@/tools/sandbox-read-roots";

export async function resolveSandboxWritableRoots(roots: readonly string[], boundary: string, readOnlyRoots: readonly string[] = []): Promise<readonly string[]> {
  if (roots.length === 0) return [];
  const resolved = await resolveSandboxReadRoots(roots, boundary);
  const runtime = path.dirname(path.dirname(await realpath(process.execPath)));
  const protectedRoots = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/Applications", "/Library", runtime, ...await resolveSandboxReadRoots(readOnlyRoots, boundary)];
  const canonical = await Promise.all(protectedRoots.map(root => realpath(root).catch(() => root)));
  if (resolved.some(root => canonical.some(protectedRoot => overlaps(root, protectedRoot)))) throw new Error("可写目录不能与系统、Node运行时或只读工具链重叠。");
  return resolved.filter(root => !resolved.some(other => other !== root && root.startsWith(`${other}${path.sep}`)));
}

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
}
