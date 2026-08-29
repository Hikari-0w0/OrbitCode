import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DONE_EVENT,
  startOpenAIMockServer,
  textDelta,
  type MockRequest,
} from "./helpers/openai-mock";

const projectRoot = process.cwd();
const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const cliEntry = path.join(projectRoot, "src", "cli", "main.ts");

type RunningCli = {
  readonly process: ChildProcessWithoutNullStreams;
  readonly exit: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  stdout(): string;
  stderr(): string;
};

test(
  "真实 CLI 子进程从 .env 加载凭据并完成恢复与取消闭环",
  { timeout: 15_000 },
  async () => {
    const server = await startOpenAIMockServer((request) => {
      const prompt = lastUserContent(request);
      switch (prompt) {
        case "第一问":
          return {
            chunks: [
              { data: textDelta("代号是 ") },
              { data: textDelta("ORBIT-42"), delayMs: 60 },
              { data: DONE_EVENT, delayMs: 60 },
            ],
          };
        case "第二问":
          return {
            chunks: [
              { data: textDelta("记得 ORBIT-42") },
              { data: DONE_EVENT },
            ],
          };
        case "失败":
          return { status: 503, chunks: [{ data: "untrusted body" }] };
        case "取消":
          return {
            chunks: [
              { data: textDelta("正在生成") },
              { data: DONE_EVENT, delayMs: 2_000 },
            ],
          };
        case "恢复":
          return {
            chunks: [{ data: textDelta("已恢复") }, { data: DONE_EVENT }],
          };
        default:
          return { status: 400 };
      }
    });
    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "orbitcode-cli-e2e-"),
    );

    try {
      await writeFile(
        path.join(temporaryDirectory, ".env"),
        "ORBITCODE_E2E_KEY=file-only-secret\n",
      );
      await writeFile(
        path.join(temporaryDirectory, "orbitcode.yaml"),
        yamlConfig(server.baseUrl, "ORBITCODE_E2E_KEY"),
      );
      const environment = { ...process.env };
      delete environment.ORBITCODE_E2E_KEY;
      const cli = startCli(temporaryDirectory, environment);

      await waitFor(() => count(cli.stdout(), "你> ") >= 1);
      cli.process.stdin.write("   \n");
      await waitFor(() => count(cli.stdout(), "你> ") >= 2);
      assert.equal(server.requests.length, 0);

      cli.process.stdin.write("第一问\n");
      await waitFor(() => cli.stdout().includes("代号是 "));
      assert.equal(cli.stdout().includes("ORBIT-42"), false);
      await waitFor(() => count(cli.stdout(), "你> ") >= 3);

      cli.process.stdin.write("第二问\n");
      await waitFor(() => count(cli.stdout(), "你> ") >= 4);
      assert.deepEqual(messagesOf(server.requests[1]), [
        { role: "user", content: "第一问" },
        { role: "assistant", content: "代号是 ORBIT-42" },
        { role: "user", content: "第二问" },
      ]);

      cli.process.stdin.write("失败\n");
      await waitFor(() => cli.stderr().includes("HTTP 503"));
      await waitFor(() => count(cli.stdout(), "你> ") >= 5);

      cli.process.stdin.write("取消\n");
      await waitFor(() => cli.stdout().includes("正在生成"));
      cli.process.kill("SIGINT");
      await waitFor(() => cli.stdout().includes("[当前回复已取消]"));
      await waitFor(() => count(cli.stdout(), "你> ") >= 6);

      cli.process.stdin.write("恢复\n");
      await waitFor(() => count(cli.stdout(), "你> ") >= 7);
      const recoveredMessages = messagesOf(server.requests.at(-1));
      assert.equal(
        recoveredMessages.some(
          (message) => message.content === "失败" || message.content === "取消",
        ),
        false,
      );
      assert.equal(
        server.requests.every(
          (request) => request.authorization === "Bearer file-only-secret",
        ),
        true,
      );

      cli.process.stdin.write("/exit\n");
      const result = await cli.exit;
      assert.deepEqual(result, { code: 0, signal: null });
      assert.match(cli.stdout(), /再见。/);
      assert.equal(cli.stderr().includes("file-only-secret"), false);
      assert.equal(cli.stdout().includes("file-only-secret"), false);
    } finally {
      await server.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  },
);

test("进程环境优先于 .env", { timeout: 8_000 }, async () => {
  const server = await startOpenAIMockServer(() => ({
    chunks: [{ data: textDelta("完成") }, { data: DONE_EVENT }],
  }));
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "orbitcode-env-priority-"),
  );
  try {
    await writeFile(
      path.join(temporaryDirectory, ".env"),
      "ORBITCODE_E2E_KEY=file-secret\n",
    );
    await writeFile(
      path.join(temporaryDirectory, "orbitcode.yaml"),
      yamlConfig(server.baseUrl, "ORBITCODE_E2E_KEY"),
    );
    const cli = startCli(temporaryDirectory, {
      ...process.env,
      ORBITCODE_E2E_KEY: "process-secret",
    });
    await waitFor(() => count(cli.stdout(), "你> ") >= 1);
    cli.process.stdin.write("问题\n");
    await waitFor(() => count(cli.stdout(), "你> ") >= 2);
    cli.process.stdin.write("/exit\n");
    assert.deepEqual(await cli.exit, { code: 0, signal: null });
    assert.equal(server.requests[0].authorization, "Bearer process-secret");
  } finally {
    await server.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("启动配置失败时返回非零退出码且不请求模型", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "orbitcode-config-error-"),
  );
  try {
    const cli = startCli(temporaryDirectory, { ...process.env }, "missing.yaml");
    const result = await cli.exit;
    assert.deepEqual(result, { code: 1, signal: null });
    assert.match(cli.stderr(), /无法读取模型配置文件/);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

function startCli(
  cwd: string,
  environment: NodeJS.ProcessEnv,
  configFile = "orbitcode.yaml",
): RunningCli {
  const child = spawn(
    process.execPath,
    [
      tsxCli,
      "--tsconfig",
      path.join(projectRoot, "tsconfig.json"),
      cliEntry,
      "--config",
      configFile,
      "--provider",
      "primary",
    ],
    { cwd, env: environment, stdio: "pipe" },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exit = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    process: child,
    exit,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function yamlConfig(baseUrl: string, environmentVariable: string): string {
  return [
    "providers:",
    "  - name: primary",
    "    protocol: openai",
    "    model: e2e-model",
    `    base_url: ${baseUrl}`,
    `    api_key: ${environmentVariable}`,
    "    context:",
    "      window_tokens: 128000",
    "  - name: unused",
    "    protocol: openai",
    "    model: unused-model",
    "    base_url: http://127.0.0.1:1/v1",
    "    api_key: UNUSED_API_KEY",
    "    context:",
    "      window_tokens: 128000",
    "",
  ].join("\n");
}

function lastUserContent(request: MockRequest): string | undefined {
  return messagesOf(request).at(-1)?.content;
}

function messagesOf(
  request: MockRequest | undefined,
): Array<{ readonly role: string; readonly content: string }> {
  if (!request || !isRecord(request.body) || !Array.isArray(request.body.messages)) {
    return [];
  }
  return request.body.messages.filter(isMessage);
}

function isMessage(
  value: unknown,
): value is { readonly role: string; readonly content: string } {
  return (
    isRecord(value) &&
    typeof value.role === "string" &&
    typeof value.content === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(source: string, value: string): number {
  return source.split(value).length - 1;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("等待 CLI 输出超时。");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
