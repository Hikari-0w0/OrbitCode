import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export type WorkspaceSnapshot = Readonly<Record<string, { readonly bytes: number; readonly sha256: string }>>;

// 评测只记录普通文件哈希，不跟随链接、不复制内容；这是取证，不提供文件隔离或原子快照。
export async function snapshotWorkspace(root: string): Promise<WorkspaceSnapshot> {
  const result: Record<string, { bytes: number; sha256: string }> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".orbitcode" || entry.name === ".git" || entry.name === "node_modules") continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const content = await readFile(file);
        result[path.relative(root, file)] = { bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") };
      }
    }
  };
  await visit(root);
  return result;
}
