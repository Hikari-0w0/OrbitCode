import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { editFileTool } from "@/tools/edit-file";
import { findFilesTool } from "@/tools/find-files";
import { readFileTool } from "@/tools/read-file";
import { searchCodeTool } from "@/tools/search-code";
import { writeFileTool } from "@/tools/write-file";
import { createWorkspaceBoundary } from "@/tools/workspace";

test("读取、创建、覆盖和唯一替换形成安全闭环", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-file-tools-"));
  try {
    await writeFile(path.join(root, "source.txt"), "one\ntarget\nthree\n");
    const workspace = await createWorkspaceBoundary(root);
    const context = toolContext(workspace);

    const read = await readFileTool.execute({ path: "source.txt" }, context);
    assert.deepEqual(read.ok && read.output, {
      path: "source.txt",
      content: "one\ntarget\nthree\n",
      byteLength: 17,
    });

    const created = await writeFileTool.execute(
      { path: "created.txt", content: "hello" },
      context,
    );
    assert.equal(created.ok && created.sideEffect, "applied");
    const overwritten = await writeFileTool.execute(
      { path: "created.txt", content: "updated" },
      context,
    );
    assert.deepEqual(overwritten.ok && overwritten.output, {
      path: "created.txt",
      byteLength: 7,
      created: false,
    });

    const edited = await editFileTool.execute(
      { path: "source.txt", old_text: "target", new_text: "changed" },
      context,
    );
    assert.deepEqual(edited.ok && edited.output, {
      path: "source.txt",
      replacements: 1,
      byteLength: 18,
    });
    assert.equal(await readFile(path.join(root, "source.txt"), "utf8"), "one\nchanged\nthree\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("修改零匹配、多匹配和无变化时保持文件不变", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-edit-tool-"));
  try {
    const target = path.join(root, "target.txt");
    await writeFile(target, "same same");
    const workspace = await createWorkspaceBoundary(root);
    const context = toolContext(workspace);
    const values = [
      { old_text: "missing", new_text: "x" },
      { old_text: "same", new_text: "x" },
      { old_text: "same same", new_text: "same same" },
    ];
    for (const value of values) {
      const result = await editFileTool.execute({ path: "target.txt", ...value }, context);
      assert.equal(result.ok, false);
      assert.equal(await readFile(target, "utf8"), "same same");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("查找与搜索返回稳定相对位置并支持空结果", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-search-tool-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "b.ts"), "const Orbit = 1;\n");
    await writeFile(path.join(root, "src", "a.ts"), "orbit\nORBIT\n");
    await writeFile(path.join(root, "README.md"), "Orbit\n");
    const workspace = await createWorkspaceBoundary(root);
    const context = toolContext(workspace);

    const found = await findFilesTool.execute({ pattern: "**/*.ts" }, context);
    assert.deepEqual(found.ok && found.output, {
      paths: ["src/a.ts", "src/b.ts"],
      count: 2,
    });
    const searched = await searchCodeTool.execute(
      { query: "orbit", file_pattern: "**/*.ts", case_sensitive: false },
      context,
    );
    assert.deepEqual(searched.ok && searched.output, {
      matches: [
        { path: "src/a.ts", line: 1, column: 1, text: "orbit", textTruncated: false },
        { path: "src/a.ts", line: 2, column: 1, text: "ORBIT", textTruncated: false },
        {
          path: "src/b.ts",
          line: 1,
          column: 7,
          text: "const Orbit = 1;",
          textTruncated: false,
        },
      ],
      count: 3,
      skippedFiles: 0,
    });
    const empty = await findFilesTool.execute({ pattern: "**/*.go" }, context);
    assert.deepEqual(empty.ok && empty.output, { paths: [], count: 0 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("find_files 自动解包 pattern 字段中的合法工具 JSON", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-find-unwrap-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "main.ts"), "export {};\n");
    const workspace = await createWorkspaceBoundary(root);
    const prepared = findFilesTool.prepareUnknown({
      pattern: '{"pattern":"**/*.ts"}',
    });
    assert.equal(prepared.kind, "ready");
    if (prepared.kind !== "ready") return;
    const result = await prepared.call.execute(toolContext(workspace));
    assert.deepEqual(result.ok && result.output, {
      paths: ["src/main.ts"],
      count: 1,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("文件工具结构化拒绝敏感路径、非法模式和超限写入", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-file-failure-"));
  const outside = path.join(tmpdir(), `orbitcode-write-sentinel-${process.pid}.txt`);
  try {
    await writeFile(path.join(root, ".env"), "SECRET=sentinel");
    await writeFile(outside, "outside-unchanged");
    await symlink(outside, path.join(root, "linked.txt"));
    const workspace = await createWorkspaceBoundary(root);
    const context = toolContext(workspace);
    const protectedRead = await readFileTool.execute({ path: ".env" }, context);
    const invalidGlob = await findFilesTool.execute({ pattern: "../*" }, context);
    const tooLarge = await writeFileTool.execute(
      { path: "large.txt", content: "你".repeat(200_000) },
      context,
    );
    const protectedWrite = await writeFileTool.execute(
      { path: "orbitcode.yaml", content: "blocked" },
      context,
    );
    const protectedWorkspaceConfig = await readFileTool.execute(
      { path: "orbitcode.workspaces.yaml" },
      context,
    );
    const linkedWrite = await writeFileTool.execute(
      { path: "linked.txt", content: "blocked" },
      context,
    );
    const escapedWrite = await writeFileTool.execute(
      { path: "../escaped.txt", content: "blocked" },
      context,
    );
    assert.equal(protectedRead.ok ? undefined : protectedRead.error.kind, "protected-path");
    assert.equal(invalidGlob.ok ? undefined : invalidGlob.error.kind, "invalid-arguments");
    assert.equal(tooLarge.ok ? undefined : tooLarge.error.kind, "limit-exceeded");
    assert.equal(protectedWrite.ok ? undefined : protectedWrite.error.kind, "protected-path");
    assert.equal(
      protectedWorkspaceConfig.ok
        ? undefined
        : protectedWorkspaceConfig.error.kind,
      "protected-path",
    );
    assert.equal(linkedWrite.ok, false);
    assert.equal(escapedWrite.ok, false);
    assert.equal(JSON.stringify(protectedRead).includes("sentinel"), false);
    assert.equal(await readFile(outside, "utf8"), "outside-unchanged");
  } finally {
    await rm(outside, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("查找与搜索强制条目、内容和预览上限", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "orbitcode-search-limits-"));
  try {
    const many = path.join(root, "many");
    await mkdir(many);
    await Promise.all(
      Array.from({ length: 1_001 }, (_, index) =>
        writeFile(path.join(many, `${String(index).padStart(4, "0")}.ts`), "export {};\n"),
      ),
    );
    await writeFile(path.join(root, "matches.ts"), "needle\n".repeat(501));
    await writeFile(path.join(root, "long-line.ts"), `${"x".repeat(600)} needle\n`);
    await writeFile(path.join(root, "too-large.ts"), "x".repeat(1024 * 1024 + 1));
    await writeFile(path.join(root, "unreadable.ts"), "needle\n");
    await chmod(path.join(root, "unreadable.ts"), 0o000);
    const workspace = await createWorkspaceBoundary(root);
    const context = toolContext(workspace);

    const found = await findFilesTool.execute({ pattern: "many/*.ts" }, context);
    assert.equal(found.ok, true);
    assert.equal(found.ok && isRecord(found.output) ? found.output.count : undefined, 1_000);
    assert.equal(found.meta.truncated, true);
    assert.deepEqual(found.meta.truncatedFields, ["paths"]);

    const searched = await searchCodeTool.execute(
      { query: "needle", file_pattern: "*.ts" },
      context,
    );
    assert.equal(searched.ok, true);
    assert.equal(
      searched.ok && isRecord(searched.output) ? searched.output.count : undefined,
      500,
    );
    assert.equal(searched.meta.truncated, true);
    assert.deepEqual(searched.meta.truncatedFields, ["matches"]);

    const longLine = await searchCodeTool.execute(
      { query: "needle", file_pattern: "long-line.ts" },
      context,
    );
    const longLineMatches = longLine.ok && isRecord(longLine.output)
      ? longLine.output.matches
      : undefined;
    assert.equal(
      Array.isArray(longLineMatches) && isRecord(longLineMatches[0])
        ? longLineMatches[0].textTruncated
        : undefined,
      true,
    );

    const skipped = await searchCodeTool.execute(
      { query: "needle", file_pattern: "too-large.ts" },
      context,
    );
    assert.equal(
      skipped.ok && isRecord(skipped.output) ? skipped.output.skippedFiles : undefined,
      1,
    );

    const unreadable = await searchCodeTool.execute(
      { query: "needle", file_pattern: "unreadable.ts" },
      context,
    );
    assert.equal(
      unreadable.ok && isRecord(unreadable.output)
        ? unreadable.output.skippedFiles
        : undefined,
      1,
    );
  } finally {
    await chmod(path.join(root, "unreadable.ts"), 0o600).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

function toolContext(workspace: Awaited<ReturnType<typeof createWorkspaceBoundary>>) {
  return {
    workspace,
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 10_000,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
