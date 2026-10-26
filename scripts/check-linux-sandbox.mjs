import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseImage = process.argv[2] ?? "node:24-bookworm-slim";
const platform = process.env.ORBITCODE_SANDBOX_TEST_PLATFORM;
if (platform && !["linux/arm64", "linux/amd64"].includes(platform)) throw new Error("专项测试平台必须为 linux/arm64 或 linux/amd64。");
const platformArguments = platform ? ["--platform", platform] : [];
const context = await mkdtemp(path.join(tmpdir(), "orbitcode-linux-check-"));
const image = `orbitcode-linux-sandbox-check:${platform?.replace("/", "-") ?? "local"}`;

function run(executable, args) {
  const result = spawnSync(executable, args, { cwd: projectRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} 检查失败，退出码 ${result.status ?? result.signal}`);
}

try {
  // 只复制测试 bundle 和内置能力资源，避免把项目环境文件或用户数据带入镜像。
  for (const [source, output] of [["src/tools/linux-bubblewrap-sandbox.test.ts", "linux-tests.cjs"], ["src/tools/sandbox-security.test.ts", "security-tests.cjs"], ["tests/linux-sandbox-cli.e2e.test.ts", "cli-tests.cjs"]]) {
    run(path.join(projectRoot, "node_modules/.bin/esbuild"), [source, "--bundle", "--platform=node", "--format=cjs", "--log-level=error", `--outfile=${path.join(context, output)}`]);
  }
  run(path.join(projectRoot, "node_modules/.bin/esbuild"), ["src/cli/main.ts", "--bundle", "--platform=node", "--format=esm", "--log-level=error", '--banner:js=import { createRequire } from "node:module"; const require = createRequire(import.meta.url);', `--outfile=${path.join(context, "cli.mjs")}`]);
  await cp(path.join(projectRoot, "agents"), path.join(context, "agents"), { recursive: true });
  await cp(path.join(projectRoot, "skills"), path.join(context, "skills"), { recursive: true });
  const namespacePolicy = path.join(context, "blocked-namespaces.json");
  await writeFile(namespacePolicy, JSON.stringify({ defaultAction: "SCMP_ACT_ALLOW", syscalls: [
    { names: ["unshare"], action: "SCMP_ACT_ERRNO", errnoRet: 1 },
    { names: ["clone3"], action: "SCMP_ACT_ERRNO", errnoRet: 38 },
    { names: ["clone"], action: "SCMP_ACT_ERRNO", errnoRet: 1, args: [{ index: 0, value: 268435456, valueTwo: 268435456, op: "SCMP_CMP_MASKED_EQ" }] },
  ] }));
  await writeFile(path.join(context, "Dockerfile"), `ARG BASE_IMAGE=node:24-bookworm-slim
FROM ${"${BASE_IMAGE}"}
USER root
RUN if ! command -v bwrap || ! command -v git || ! command -v c++ || ! command -v python3; then apt-get update && apt-get install -y --no-install-recommends bubblewrap git g++ make python3 && rm -rf /var/lib/apt/lists/*; fi
WORKDIR /checks
COPY . /checks
ENV NEXT_RUNTIME=nodejs
ENV ORBITCODE_TEST_CLI_ENTRY=/checks/cli.mjs
ENTRYPOINT ["node", "--test"]
CMD ["linux-tests.cjs", "security-tests.cjs", "cli-tests.cjs"]
`);
  run("docker", ["build", ...platformArguments, "--build-arg", `BASE_IMAGE=${baseImage}`, "-t", image, context]);
  for (const user of ["0:0", "1000:1000"]) {
    console.log(`Linux 隔离与 CLI 检查，UID/GID=${user}`);
    run("docker", ["run", "--rm", ...platformArguments, "--user", user, "--security-opt", "seccomp=unconfined", "--security-opt", "systempaths=unconfined", "-e", `ORBITCODE_SANDBOX_PUBLIC_NETWORK_TEST=${process.env.ORBITCODE_SANDBOX_PUBLIC_NETWORK_TEST ?? "0"}`, image]);
  }
  console.log("显式禁止 namespace，验证拒绝执行，不依赖Docker默认策略");
  run("docker", ["run", "--rm", ...platformArguments, "--security-opt", `seccomp=${namespacePolicy}`, "-e", "ORBITCODE_EXPECT_SANDBOX_UNAVAILABLE=1", image, "--test-name-pattern=外层容器", "linux-tests.cjs"]);
} finally {
  await rm(context, { recursive: true, force: true });
}
