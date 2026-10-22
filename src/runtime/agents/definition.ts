import { isAlias, isMap, isScalar, isSeq, parseDocument, visit } from "yaml";
import type { AgentRole } from "@/core/sub-agents/types";
import { LOCAL_SKILL_TOOLS, RETIRED_METADATA_TOOLS, record } from "@/runtime/skills/definition";

export function parseAgentRole(text: string): AgentRole {
  if (Buffer.byteLength(text) > 65536) throw new Error("角色定义超过 64 KiB。");
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match || Buffer.byteLength(match[1]) > 8192 || !match[2].trim()) throw new Error("角色必须有合法 frontmatter 和正文。");
  const doc = parseDocument(match[1], { uniqueKeys: true, strict: true });
  if (doc.errors.length) throw new Error("角色 YAML 无效。");
  visit(doc, (_key, node) => { if (isAlias(node) || ((isMap(node) || isSeq(node) || isScalar(node)) && (node.anchor || node.tag))) throw new Error("角色不支持 YAML 引用或标签。"); });
  const v: unknown = doc.toJS({ maxAliasCount: 0 });
  if (!record(v) || Object.keys(v).some(key => !["name", "description", "allowed-tools", "disallowed-tools", "model", "max-iterations", "permission-mode"].includes(key))) throw new Error("角色元信息无效。");
  if (typeof v.name !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(v.name) || typeof v.description !== "string" || !v.description.trim() || Array.from(v.description).length > 200 || /[\r\n]/.test(v.description)) throw new Error("角色名称或说明无效。");
  const tools = (key: string): readonly string[] => {
    const values = v[key];
    if (!Array.isArray(values) || values.length > 64) throw new Error("工具列表无效。");
    const parsed: string[] = [];
    for (const item of values) {
      if (typeof item !== "string" || !(item === "agent" || LOCAL_SKILL_TOOLS.has(item) || RETIRED_METADATA_TOOLS.has(item) || /^mcp__[A-Za-z0-9_-]+$/.test(item)) || parsed.includes(item)) throw new Error("工具名无效或重复。");
      parsed.push(item);
    }
    return Object.freeze(parsed.filter(tool => !RETIRED_METADATA_TOOLS.has(tool)));
  };
  if (typeof v.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v.model) || typeof v["max-iterations"] !== "number" || !Number.isSafeInteger(v["max-iterations"]) || v["max-iterations"] < 1 || v["max-iterations"] > 32) throw new Error("角色模型或轮次无效。");
  const mode = v["permission-mode"];
  if (mode !== "strict" && mode !== "default" && mode !== "permissive") throw new Error("角色权限模式无效。");
  return Object.freeze({ name: v.name, description: v.description, allowedTools: tools("allowed-tools"), disallowedTools: tools("disallowed-tools"), model: v.model, maxIterations: v["max-iterations"], permissionMode: mode, instructions: match[2].trim() });
}
