export type CliArguments =
  | { readonly type: "help" }
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

选项：
  --config <path>     YAML 模型配置文件
  --provider <name>   多配置时选择配置名称
  --help              显示帮助
`;

export function parseCliArguments(argv: readonly string[]): CliArguments {
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
