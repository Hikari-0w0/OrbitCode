import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

async function discoverTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return discoverTests(target);
    return entry.isFile() && /\.test\.tsx?$/.test(entry.name) ? [target] : [];
  }));
  return nested.flat().sort();
}

// 显式路径保留定向测试用法；默认只收集仓库测试，避免临时评测项目污染回归。
const requested = process.argv.slice(2);
const targets = requested.filter(argument => !argument.startsWith("-") && /(?:\.test\.tsx?$|^(?:src|tests)(?:[/\\]|$))/.test(argument));
const files = targets.length ? requested : [...requested, ...(await Promise.all(["src", "tests"].map(discoverTests))).flat()];
if (!files.length) throw new Error("没有找到仓库测试。");
const child = spawn(process.execPath, ["--import", "tsx", "--test", ...files], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1); });
