import assert from "node:assert/strict";
import test from "node:test";

import { compileGlob, GlobPatternError } from "@/tools/glob";

test("受限 Glob 支持星号、问号与跨目录双星号", () => {
  assert.equal(compileGlob("*.ts").matches("index.ts"), true);
  assert.equal(compileGlob("*.ts").matches("src/index.ts"), false);
  assert.equal(compileGlob("src/?.ts").matches("src/a.ts"), true);
  assert.equal(compileGlob("**/*.ts").matches("index.ts"), true);
  assert.equal(compileGlob("**/*.ts").matches("src/core/index.ts"), true);
  assert.equal(compileGlob("src/**").matches("src/core/index.ts"), true);
  assert.equal(compileGlob("src/**/test?.ts").matches("src/test1.ts"), true);
});

test("受限 Glob 拒绝越界、空段和歧义模式", () => {
  for (const value of [
    "",
    "/src/*",
    "src/",
    "../*",
    "src//*.ts",
    "ab**cd",
    "a\\b",
    "**/*.{ts,tsx,css}",
  ]) {
    assert.throws(() => compileGlob(value), GlobPatternError);
  }
  assert.throws(
    () => compileGlob("**/*.{ts,tsx,css}"),
    /不支持花括号扩展/u,
  );
  assert.throws(() => compileGlob("x".repeat(513)), /过长/);
});

test("目录剪枝保留所有可匹配后代，精确路径排除无关兄弟目录", () => {
  const exact = compileGlob("src/core/agent.ts");
  assert.equal(exact.canDescend(""), true);
  assert.equal(exact.canDescend("src"), true);
  assert.equal(exact.canDescend("src/core"), true);
  assert.equal(exact.canDescend("src/core/extra"), false);
  assert.equal(exact.canDescend("tests"), false);
  for (const pattern of ["**", "**/*.ts", "src/**/?.ts", "src/*/*.ts", "**/core/**"])
    for (const file of ["src/core/a.ts", "src/a.ts", "src/core/deep/a.ts", "test/core/b.ts"])
      if (compileGlob(pattern).matches(file)) {
        const parents = file.split("/").slice(0, -1);
        for (let i = 0; i <= parents.length; i++) assert.equal(compileGlob(pattern).canDescend(parents.slice(0, i).join("/")), true, `${pattern} / ${file}`);
      }
});
