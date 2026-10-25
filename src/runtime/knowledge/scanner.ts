import { compileGlob } from "@/tools/glob";
import { KnowledgeError, type KnowledgeScope } from "@/core/retrieval/types";
import type { KnowledgeConfig } from "./config";
import type { KnowledgeAccess } from "./access";

const MAX_SCAN_CANDIDATES = 100_000;

export function fileScope(file: string): Exclude<KnowledgeScope, "all"> {
  return /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.tsx?$/i.test(file)
    ? "tests" : file.endsWith(".md") ? "docs" : "code";
}

export function historical(file: string): boolean {
  return /(?:^|\/)(?:archive|evals)(?:\/|$)/i.test(file);
}

function knowledgeScope(config: KnowledgeConfig): (file: string) => boolean {
  const include = config.include.map(compileGlob);
  const exclude = config.exclude.map(compileGlob);
  return file => /\.(?:md|tsx?)$/i.test(file)
    && !/(?:^|\/)(?:\.?logs?|\.?conversations[^/]*|context-v1|memory-v1|memory-state-v1|knowledge-v1|fixtures\/secrets)(?:\/|$)/i.test(file)
    && (!historical(file) || config.includeHistorical)
    && include.some(pattern => pattern.matches(file))
    && !exclude.some(pattern => pattern.matches(file));
}

export function inScope(file: string, config: KnowledgeConfig): boolean {
  return knowledgeScope(config)(file);
}

export type ScannedFile = { path: string; content: string; hash: string };

export async function scanFiles(access: KnowledgeAccess, config: KnowledgeConfig, signal: AbortSignal) {
  const files: ScannedFile[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const seen = new Set<string>();
  const matches = knowledgeScope(config);
  let bytes = 0;
  let candidates = 0;
  // 包含模式交给工作区遍历器剪枝；独立候选预算约束排除项和模式重叠造成的实际工作量。
  for (const pattern of new Set(config.include)) {
    for await (const entry of access.workspace.walk({ pattern, signal, maxEntries: MAX_SCAN_CANDIDATES + 1 })) {
      signal.throwIfAborted();
      if (++candidates > MAX_SCAN_CANDIDATES) throw new KnowledgeError("limit-exceeded", "遍历候选数达到上限。");
      if (!matches(entry.relativePath) || seen.has(entry.relativePath)) continue;
      seen.add(entry.relativePath);
      if (seen.size > config.limits.maxFiles) throw new KnowledgeError("limit-exceeded", "扫描文件数达到上限。");
      if (entry.byteLength > config.limits.maxFileBytes) {
        skipped.push({ path: entry.relativePath, reason: "file-too-large" });
        continue;
      }
      try {
        const snapshot = await access.read(entry.relativePath, config.limits.maxFileBytes, signal);
        bytes += Buffer.byteLength(snapshot.content);
        if (bytes > config.limits.maxScanBytes) throw new KnowledgeError("limit-exceeded", "扫描字节数达到上限。");
        files.push({ path: entry.relativePath, content: snapshot.content, hash: snapshot.hash });
      } catch (error) {
        if (error instanceof KnowledgeError && error.code === "limit-exceeded") throw error;
        signal.throwIfAborted();
        skipped.push({ path: "", reason: "unreadable" });
      }
    }
  }
  return { files: files.sort((a, b) => a.path.localeCompare(b.path, "en")), skipped, bytes };
}
