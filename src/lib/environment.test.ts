import assert from "node:assert/strict";
import test from "node:test";

import {
  EnvironmentLoadError,
  loadLocalEnvironment,
} from "@/lib/environment";

test(".env 不存在时保留进程环境", async () => {
  const environment = await loadLocalEnvironment({
    cwd: "/virtual/project",
    processEnvironment: { EXISTING: "process-value" },
    readTextFile: async () => {
      const error = new Error("missing");
      Object.assign(error, { code: "ENOENT" });
      throw error;
    },
  });

  assert.deepEqual(environment, { EXISTING: "process-value" });
});

test("加载 dotenv 引号和注释且不覆盖进程变量", async () => {
  const environment = await loadLocalEnvironment({
    cwd: "/virtual/project",
    processEnvironment: {
      EXISTING: "process-value",
      EMPTY_IN_PROCESS: "",
    },
    readTextFile: async (filePath) => {
      assert.equal(filePath, "/virtual/project/.env");
      return [
        "# 本地配置",
        "EXISTING=file-value",
        'QUOTED="hello world"',
        "EMPTY_IN_PROCESS=replaced",
        "NEW_VALUE=available",
      ].join("\n");
    },
  });

  assert.deepEqual(environment, {
    EXISTING: "process-value",
    EMPTY_IN_PROCESS: "",
    QUOTED: "hello world",
    NEW_VALUE: "available",
  });
});

test("读取失败只暴露文件路径和安全原因", async () => {
  const sentinel = "sentinel-secret-read";
  await assert.rejects(
    loadLocalEnvironment({
      cwd: "/virtual/project",
      processEnvironment: {},
      readTextFile: async () => {
        throw new Error(sentinel);
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof EnvironmentLoadError);
      assert.equal(error.message.includes(sentinel), false);
      assert.match(error.message, /无法读取本地环境文件/);
      return true;
    },
  );
});

test("解析失败不暴露文件内容或凭据", async () => {
  const sentinel = "sentinel-secret-parse";
  await assert.rejects(
    loadLocalEnvironment({
      cwd: "/virtual/project",
      processEnvironment: {},
      readTextFile: async () => `KEY=${sentinel}`,
      parseEnvironment: () => {
        throw new Error(sentinel);
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof EnvironmentLoadError);
      assert.equal(error.message.includes(sentinel), false);
      assert.match(error.message, /无法解析本地环境文件/);
      return true;
    },
  );
});
