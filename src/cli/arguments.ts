export type CliArguments =
  | { readonly type: "help" }
  | {
      readonly type: "export-run";
      readonly runId: string;
      readonly outputPath?: string;
      readonly includeContext: boolean;
    }
  | {
      readonly type: "run";
      readonly configPath: string;
      readonly providerName?: string;
    };

export class ArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgumentError";
  }
}

export const HELP_TEXT = `OrbitCode CLI

用法：
  npm run cli -- --config <path> [--provider <name>]
  npm run cli -- export-run <run-id> [--output <path>] [--without-context]

选项：
  --config <path>     YAML 模型配置文件
  --provider <name>   多配置时选择配置名称
  --output <path>     导出 JSON 路径；默认写入当前目录
  --without-context   不包含卸载的完整工具上下文
  --help              显示帮助
`;

export function parseCliArguments(argv: readonly string[]): CliArguments {
  if (argv[0] === "export-run") return parseExportRunArguments(argv.slice(1));
  let configPath: string | undefined;
  let providerName: string | undefined;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      if (help) {
        throw new ArgumentError("--help 不能重复指定。");
      }
      help = true;
      continue;
    }
    if (argument === "--config") {
      if (configPath !== undefined) {
        throw new ArgumentError("--config 不能重复指定。");
      }
      configPath = requireValue(argv, ++index, "--config");
      continue;
    }
    if (argument === "--provider") {
      if (providerName !== undefined) {
        throw new ArgumentError("--provider 不能重复指定。");
      }
      providerName = requireValue(argv, ++index, "--provider");
      continue;
    }
    throw new ArgumentError(`未知参数：${argument}`);
  }

  if (help) {
    if (configPath !== undefined || providerName !== undefined) {
      throw new ArgumentError("--help 不能与其他参数同时使用。");
    }
    return { type: "help" };
  }
  if (configPath === undefined) {
    throw new ArgumentError("缺少必填参数 --config。");
  }
  return { type: "run", configPath, providerName };
}

function parseExportRunArguments(argv: readonly string[]): CliArguments {
  const runId = argv[0];
  if (runId === undefined || runId.startsWith("--") || runId.trim().length === 0) {
    throw new ArgumentError("export-run 缺少 run-id。");
  }
  let outputPath: string | undefined;
  let includeContext = true;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") {
      if (outputPath !== undefined) throw new ArgumentError("--output 不能重复指定。");
      outputPath = requireValue(argv, ++index, "--output");
      continue;
    }
    if (argument === "--without-context") {
      if (!includeContext) throw new ArgumentError("--without-context 不能重复指定。");
      includeContext = false;
      continue;
    }
    throw new ArgumentError(`未知参数：${argument}`);
  }
  return {
    type: "export-run",
    runId,
    ...(outputPath === undefined ? {} : { outputPath }),
    includeContext,
  };
}

function requireValue(
  argv: readonly string[],
  index: number,
  option: string,
): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--") || value.trim().length === 0) {
    throw new ArgumentError(`${option} 缺少参数值。`);
  }
  return value;
}
