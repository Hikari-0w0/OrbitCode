import path from "node:path";
import { opendir, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { AgentRole } from "@/core/sub-agents/types";
import { nodeError, readBounded, within } from "@/lib/bounded-files";
import { parseAgentRole } from "./definition";
export type AgentRoleEntry = { readonly role: AgentRole; readonly source: "project" | "user" | "builtin" };
export type AgentCatalog = { readonly entries: ReadonlyMap<string, AgentRoleEntry>; readonly diagnostics: readonly string[]; readonly complete: boolean; readonly summary: string };
export async function loadAgentCatalog(input: { workspaceRoot: string; userRoot: string; builtinRoot?: string; signal?: AbortSignal }): Promise<AgentCatalog> {
  const entries = new Map<string, AgentRoleEntry>(), blocked = new Set<string>(), diagnostics: string[] = [];
  const builtin = input.builtinRoot ?? (process.env.NEXT_RUNTIME ? path.join(process.cwd(), "agents") : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../agents"));
  const sources = [["project", path.join(input.workspaceRoot, ".orbitcode/agents")], ["user", path.join(input.userRoot, "agents")], ["builtin", builtin]] as const;
  const signal = AbortSignal.any([AbortSignal.timeout(5000), ...(input.signal ? [input.signal] : [])]);
  let complete = true, total = 0;
  for (const [source, root] of sources) {
    const layer = new Map<string, AgentRoleEntry | undefined>();
    try {
      signal.throwIfAborted();
      const canonical = await realpath(root);
      if (source === "project" && !within(await realpath(input.workspaceRoot), canonical)) throw new Error("角色目录越界。");
      const directory = await opendir(root), files: string[] = [];
      let count = 0;
      for await (const file of directory) {
        if (++count > 1024) throw new Error("目录项超限。");
        if (file.name.endsWith(".md") && (file.isFile() || file.isSymbolicLink())) files.push(file.name);
      }
      for (const file of files.sort()) {
        if (++total > 128) throw new Error("角色候选超过 128。");
        signal.throwIfAborted();
        let name = path.basename(file, ".md");
        let knownName = false;
        try {
          const read = await readBounded(canonical, path.join(root, file), 65536, signal);
          // 损坏 YAML 无法可信解析名称时保守禁用整个目录，不允许低层定义意外提权。
          const recovered = /^name:\s*([a-z][a-z0-9-]{0,63})\s*$/m.exec(read.content);
          if (recovered) { name = recovered[1]; knownName = true; }
          const role = parseAgentRole(read.content);
          name = role.name; knownName = true;
          if (layer.has(name)) { layer.set(name, undefined); diagnostics.push(`${source}: 同层角色重复 ${name}`); }
          else layer.set(name, { role, source });
        } catch {
          layer.set(name, undefined); diagnostics.push(`${source}: ${file} 角色不可读或格式错误`); if (!knownName) complete = false;
        }
      }
      for (const [name, entry] of layer) if (!entries.has(name) && !blocked.has(name)) {
        if (entry) entries.set(name, entry); else blocked.add(name);
      }
    } catch (error) { if (!nodeError(error, "ENOENT")) { complete = false; diagnostics.push(`${source}: 角色扫描未完成或越界`); } }
  }
  const summary = [...entries.values()].map(entry => `${entry.role.name}: ${entry.role.description}`).join("\n");
  if (Buffer.byteLength(summary) > 16384) { complete = false; diagnostics.push("角色目录摘要超过 16 KiB。"); }
  return { entries, diagnostics, complete, summary: complete ? summary : "角色目录存在错误，请修复后重试。" };
}
