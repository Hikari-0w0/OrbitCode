import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readFileTool } from "./read-file";
import { createWorkspaceBoundary, WorkspaceError } from "./workspace";
import type { ReadRangeLimits } from "./types";

test("大文件分段读取跨 UTF-8 块保留原文、行号及整文件指纹，完整读取仍有界", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-range-"));
  try {
    const text = "a".repeat(65535) + "中\r\n" + "x".repeat(600000) + "\n目标行\r\n结尾";
    await writeFile(path.join(root, "source.txt"), text);
    const workspace = await createWorkspaceBoundary(root);
    const context = { workspace, signal: new AbortController().signal, deadlineMs: Date.now() + 10000 };
    const range = await readFileTool.execute({ path: "source.txt", start_line: 3, end_line: 4 }, context);
    assert.ok(range.ok && range.output && typeof range.output === "object" && "range" in range.output && "sha256" in range.output);
    assert.equal(range.output.content, "目标行\r\n结尾");
    assert.deepEqual(range.output.range, { startLine: 3, endLine: 4, totalLines: 4, complete: false });
    assert.equal(range.output.sha256, createHash("sha256").update(text).digest("hex"));
    const whole = await readFileTool.execute({ path: "source.txt" }, context);
    assert.equal(whole.ok ? undefined : whole.error.kind, "limit-exceeded");
    const tooLong = await readFileTool.execute({ path: "source.txt", start_line: 2, end_line: 2 }, context);
    assert.equal(tooLong.ok ? undefined : tooLong.error.kind, "limit-exceeded");
    const beyond = await readFileTool.execute({ path: "source.txt", start_line: 10 }, context);
    assert.equal(beyond.ok ? undefined : beyond.error.kind, "invalid-arguments");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("流式范围保持空文件、换行、BOM 与旧读取语义一致", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-range-lines-"));
  try {
    const workspace = await createWorkspaceBoundary(root);
    for (const text of ["", "a", "\n", "a\n", "a\n\n", "\uFEFF你好\r\n下一行", "x".repeat(65535) + "中\n尾\n"]) {
      await writeFile(path.join(root, "text.txt"), text);
      const full = await workspace.readTextFile("text.txt", { maxBytes: 1024 * 1024 });
      const result = await workspace.readTextFileRange("text.txt", limits());
      assert.equal(result.content, full.content);
      assert.equal(result.range.totalLines, (full.content.match(/[^\n]*\n|[^\n]+$/gu) ?? [""]).length);
      assert.equal(result.range.complete, true);
      assert.equal(result.sha256, createHash("sha256").update(full.content).digest("hex"));
      assert.equal(result.byteLength, Buffer.byteLength(text));
      assert.equal("identity" in result, false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("范围读取不绕过路径保护、全文件 UTF-8 校验、扫描预算和取消", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-range-security-"));
  const outside = await mkdtemp(path.join(tmpdir(), "orbitcode-range-outside-"));
  try {
    const workspace = await createWorkspaceBoundary(root);
    await writeFile(path.join(root, ".env"), "synthetic-private");
    await writeFile(path.join(outside, "secret.txt"), "synthetic-private");
    await symlink(path.join(outside, "secret.txt"), path.join(root, "outside.txt"));
    await symlink(".env", path.join(root, "alias.txt"));
    for (const target of [".env", "alias.txt", "outside.txt", "../secret.txt"]) await assert.rejects(workspace.readTextFileRange(target, limits()), WorkspaceError);
    await writeFile(path.join(root, "invalid.txt"), Buffer.concat([Buffer.from("ok\n"), Buffer.alloc(70000, 97), Buffer.from([0xff])]));
    await assert.rejects(workspace.readTextFileRange("invalid.txt", { ...limits(), endLine: 1 }), (error: unknown) => error instanceof WorkspaceError && error.kind === "unsupported-content");
    await assert.rejects(workspace.readTextFileRange("invalid.txt", { ...limits(), maxScanBytes: 100 }), (error: unknown) => error instanceof WorkspaceError && error.kind === "limit-exceeded");
    const controller = new AbortController(); controller.abort();
    const result = await readFileTool.execute({ path: "invalid.txt", start_line: 1 }, { workspace, signal: controller.signal, deadlineMs: Date.now() + 1000 });
    assert.equal(result.ok ? undefined : result.error.kind, "cancelled");
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

function limits(): ReadRangeLimits {
  return { startLine: 1, endLine: 100, maxScanBytes: 1024 * 1024, maxOutputBytes: 128 * 1024, signal: new AbortController().signal };
}
