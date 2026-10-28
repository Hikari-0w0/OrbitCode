import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { SandboxPreparationError } from "@/tools/sandbox-error";

export const WORKSPACE_TEMP_DIRECTORY = ".orbitcode-tmp";

export async function shortTemporaryDirectory(root: string): Promise<string> {
  // 路径长度独立于工作区深度，给 Unix socket 留出文件名空间；只授权这个私有目录。
  const parent = await realpath("/tmp");
  const canonicalRoot = await realpath(root);
  const target = path.join(parent, `oc-${process.getuid?.() ?? "user"}-${createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 16)}`);
  try { await mkdir(target, { mode: 0o700 }); }
  catch (error) { if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error; }
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(target) !== target || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0) {
    throw new SandboxPreparationError("短临时目录必须属于当前用户、权限为0700且不能为链接。");
  }
  return target;
}

export async function workspaceTemporaryDirectory(root: string): Promise<string> {
  const target = path.join(root, WORKSPACE_TEMP_DIRECTORY);
  try { await mkdir(target, { mode: 0o700 }); }
  catch (error) { if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error; }
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(target) !== path.join(await realpath(root), WORKSPACE_TEMP_DIRECTORY)) {
    throw new SandboxPreparationError("工作区临时目录必须为工作区内的普通目录，不能使用符号链接。");
  }
  return target;
}
