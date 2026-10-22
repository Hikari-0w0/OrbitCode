import type { AgentEvent } from "@/core/agent-events";
import { createHash } from "node:crypto";
import type { ChildExecutionHandoff } from "@/core/sub-agents/types";
import { SkillCommandCalls } from "./result";
import type { FileLineRange } from "@/tools/types";

export class ChildHandoff {
  private readonly readFiles = new Map<string, NonNullable<ChildExecutionHandoff["reads"]>["files"][number]>();
  private readonly matches = new Map<string, { path: string; line: number; callId: string }>();
  private readonly contextSearches: NonNullable<NonNullable<ChildExecutionHandoff["reads"]>["contextSearches"]>[number][] = [];
  private omittedReads = 0;
  private readonly commands = new SkillCommandCalls();
  private readonly paths = new Set<string>();
  private omitted = 0;

  record(event: AgentEvent): void {
    if (event.type !== "tool-result") return;
    if (event.result.ok) this.recordReads(event.name, event.result.output, event.callId);
    if (event.name === "run_command") this.commands.record(event.result, event.callId);
    // 仅从工具确认的结果提取文件；不解析命令文本，也不把请求写入当成实际写入。
    if (event.result.sideEffect !== "applied") return;
    const output = event.result.output;
    if (!output || typeof output !== "object" || Array.isArray(output)) return;
    if (event.name === "write_file" || event.name === "edit_file") {
      if (event.result.ok && "path" in output) this.addPath(output.path);
    } else if (event.name === "write_files" && "files" in output && Array.isArray(output.files)) {
      // 批量写入失败仍可能含已完成的前缀，必须保留。
      for (const file of output.files) {
        if (file && typeof file === "object" && !Array.isArray(file) && "path" in file) this.addPath(file.path);
      }
    }
  }

  snapshot(): ChildExecutionHandoff {
    return {
      reads: { files: [...this.readFiles.values()].map(file => ({ ...file })), matches: [...this.matches.values()].map(match => ({ ...match })), ...(this.contextSearches.length ? { contextSearches: this.contextSearches.map(search => ({ ...search })) } : {}), omitted: this.omittedReads },
      commandCalls: this.commands.snapshot(), fileWrites: { scope: "file-tool-results-only", paths: [...this.paths], omitted: this.omitted },
    };
  }

  promptFacts(): string {
    const counts = { source: "当前子任务成功工具结果；不是父历史，也不代表模型完整读完或任务已验收", readFileCount: this.readFiles.size, omittedReads: this.omittedReads, commandCalls: this.commands.snapshot().count, failedCommands: this.commands.snapshot().failed };
    let paths = [...this.readFiles.keys()].slice(0, 4);
    let content = JSON.stringify({ ...counts, readFiles: paths });
    while (Buffer.byteLength(content) > 3500 && paths.length) { paths = paths.slice(0, -1); content = JSON.stringify({ ...counts, readFiles: paths }); }
    return content;
  }

  private recordReads(name: string, output: unknown, callId: string): void {
    if (!output || typeof output !== "object" || Array.isArray(output)) return;
    if (name === "read_context" && "mode" in output && output.mode === "search" &&
      "reference" in output && typeof output.reference === "string" && /^context:\/\/v1\/[a-f0-9-]{36}$/.test(output.reference) &&
      "query" in output && typeof output.query === "string" && output.query.length > 0 && output.query.length <= 128 &&
      "matchCount" in output && typeof output.matchCount === "number" && Number.isSafeInteger(output.matchCount) && output.matchCount >= 0 &&
      "totalCharacters" in output && typeof output.totalCharacters === "number" && Number.isSafeInteger(output.totalCharacters) && output.totalCharacters >= 0 &&
      "complete" in output && output.complete === true && "searchedFrom" in output && output.searchedFrom === 0 && "searchedUntil" in output && output.searchedUntil === output.totalCharacters) {
      if (this.contextSearches.length < 4) this.contextSearches.push({ reference: output.reference, query: output.query, callId, matchCount: output.matchCount, totalCharacters: output.totalCharacters, complete: true });
      else this.omittedReads++;
    }
    if (name === "read_file" && "path" in output && validPath(output.path)) {
      if (Buffer.byteLength(output.path) > 512 || !this.readFiles.has(output.path) && this.readFiles.size >= 16) { this.omittedReads++; return; }
      const range = "range" in output ? readLineRange(output.range) : undefined;
      if ("range" in output && !range) return;
      this.readFiles.set(output.path, { path: output.path, callId,
        ...("content" in output && typeof output.content === "string" ? {
          sha256: range && "sha256" in output && typeof output.sha256 === "string" && /^[a-f0-9]{64}$/.test(output.sha256) ? output.sha256 : createHash("sha256").update(output.content).digest("hex"),
          byteLength: range && "byteLength" in output && typeof output.byteLength === "number" && Number.isSafeInteger(output.byteLength) && output.byteLength >= 0 ? output.byteLength : Buffer.byteLength(output.content),
        } : {}),
        ...(range ? { range } : {}),
      });
    }
    if (name !== "search_code" || !("matches" in output) || !Array.isArray(output.matches)) return;
    for (const match of output.matches) {
      if (!match || typeof match !== "object" || !validPath(match.path) || !Number.isSafeInteger(match.line) || match.line < 1) continue;
      const key = `${match.path}:${match.line}`;
      if (this.matches.has(key)) continue;
      if (Buffer.byteLength(match.path) > 512 || this.matches.size >= 16) { this.omittedReads++; continue; }
      this.matches.set(key, { path: match.path, line: match.line, callId });
    }
  }

  private addPath(value: unknown): void {
    if (typeof value !== "string" || this.paths.has(value)) return;
    if (Buffer.byteLength(value) > 1024 || this.paths.size >= 8) { this.omitted++; return; }
    this.paths.add(value);
  }
}

function readLineRange(value: unknown): FileLineRange | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    !("startLine" in value) || typeof value.startLine !== "number" || !Number.isSafeInteger(value.startLine) || value.startLine < 1 ||
    !("endLine" in value) || typeof value.endLine !== "number" || !Number.isSafeInteger(value.endLine) || value.endLine < value.startLine ||
    !("totalLines" in value) || typeof value.totalLines !== "number" || !Number.isSafeInteger(value.totalLines) || value.totalLines < value.endLine) return undefined;
  return { startLine: value.startLine, endLine: value.endLine, totalLines: value.totalLines, complete: value.startLine === 1 && value.endLine === value.totalLines };
}

function validPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.includes("\\") && !value.split("/").some(part => part === ".." || part === ".") && !/[\x00-\x1f]/.test(value);
}
