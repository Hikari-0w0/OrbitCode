import path from "node:path";
import type { Environment } from "@/lib/environment";
import type { CommandSandbox, CommandSandboxOptions } from "@/tools/command-sandbox";
import { LinuxBubblewrapCommandSandbox } from "@/tools/linux-bubblewrap-sandbox";
import { MacOsSeatbeltCommandSandbox } from "@/tools/macos-seatbelt-sandbox";
import { SandboxUnavailableError } from "@/tools/sandbox-error";

export function createCommandSandbox(
  environment: Environment = process.env,
  platform: NodeJS.Platform = process.platform,
): CommandSandbox {
  try {
    const options = sandboxOptions(environment);
    if (platform === "darwin") return new MacOsSeatbeltCommandSandbox(options);
    if (platform === "linux") return new LinuxBubblewrapCommandSandbox(options);
    return unavailableSandbox(`平台 ${platform} 尚无命令沙箱后端。`);
  } catch (error) {
    return unavailableSandbox(error instanceof Error ? error.message : "沙箱配置无效。");
  }
}

function sandboxOptions(environment: Environment): CommandSandboxOptions {
  const network = environment.ORBITCODE_SANDBOX_NETWORK ?? "allow";
  if (network !== "allow" && network !== "deny") throw new Error("ORBITCODE_SANDBOX_NETWORK 必须为 allow 或 deny。");
  let roots: unknown;
  try { roots = JSON.parse(environment.ORBITCODE_SANDBOX_READ_ROOTS ?? "[]"); }
  catch { throw new Error("ORBITCODE_SANDBOX_READ_ROOTS 必须为合法 JSON 数组。"); }
  if (!Array.isArray(roots) || !roots.every((root: unknown): root is string => typeof root === "string" && path.isAbsolute(root) && !root.includes("\0"))) {
    throw new Error("ORBITCODE_SANDBOX_READ_ROOTS 必须为绝对目录路径的 JSON 数组。");
  }
  return { network, readOnlyRoots: roots.map(root => path.normalize(root)) };
}

function unavailableSandbox(message: string): CommandSandbox {
  return {
    async probe() { return { available: false, message }; },
    async run() { throw new SandboxUnavailableError(message); },
  };
}
