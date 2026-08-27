import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse } from "dotenv";

export type Environment = Readonly<Record<string, string | undefined>>;

type EnvironmentLoaderOptions = {
  readonly cwd: string;
  readonly processEnvironment: Environment;
  readonly readTextFile?: (filePath: string) => Promise<string>;
  readonly parseEnvironment?: (source: string) => Record<string, string>;
};

export class EnvironmentLoadError extends Error {
  readonly filePath: string;

  constructor(filePath: string, reason: "read" | "parse", cause?: unknown) {
    super(
      reason === "read"
        ? `无法读取本地环境文件：${filePath}`
        : `无法解析本地环境文件：${filePath}`,
      { cause },
    );
    this.name = "EnvironmentLoadError";
    this.filePath = filePath;
  }
}

export async function loadLocalEnvironment({
  cwd,
  processEnvironment,
  readTextFile = (filePath) => readFile(filePath, "utf8"),
  parseEnvironment = parse,
}: EnvironmentLoaderOptions): Promise<Environment> {
  const filePath = path.join(cwd, ".env");
  let source: string;

  try {
    source = await readTextFile(filePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return { ...processEnvironment };
    }
    throw new EnvironmentLoadError(filePath, "read", error);
  }

  let localEnvironment: Record<string, string>;
  try {
    localEnvironment = parseEnvironment(source);
  } catch (error) {
    throw new EnvironmentLoadError(filePath, "parse", error);
  }

  const mergedEnvironment: Record<string, string | undefined> = {
    ...processEnvironment,
  };
  for (const [name, value] of Object.entries(localEnvironment)) {
    if (mergedEnvironment[name] === undefined) {
      mergedEnvironment[name] = value;
    }
  }
  return mergedEnvironment;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
