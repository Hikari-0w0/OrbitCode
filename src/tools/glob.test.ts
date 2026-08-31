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
