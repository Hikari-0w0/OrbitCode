export type CliArguments =
  | { readonly type: "help" }
  | { readonly type: "export-conversation"; readonly conversationId: string; readonly outputPath?: string }
  | {
      readonly type: "export-run";
      readonly runId: string;
      readonly outputPath?: string;
      readonly includeContext: boolean;
    }
  | {
      readonly type: "run-once";
      readonly parentExecution?: import("@/core/sub-agents/parent-execution").ParentExecutionContract;
      readonly promptFile?: string;
      readonly stdin: boolean;
      readonly outputFormat: "json" | "jsonl";
      readonly providerName?: string;
      readonly workspaceId?: string;
      readonly resumeId?: string;
      readonly dataDir?: string;
      readonly timeoutMs?: number;
      readonly maxIterations?: number;
      readonly policyFile?: string;
      readonly executionId?: string;
    }
  | {
      readonly type: "run";
      readonly configPath: string;
      readonly explicitConfig?: boolean;
      readonly providerName?: string;
      readonly workspaceId?: string;
      readonly resumeId?: string;
      readonly dataDir?: string;
    };

export class ArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgumentError";
  }
}

export const HELP_TEXT = `OrbitCode CLI

用法：
  npm run cli -- [--config <path>] [--provider <name>] [--workspace <id>] [--resume <id>] [--data-dir <path>]
  npm run cli -- export-conversation <id> [--output <path>]
  npm run cli -- export-run <run-id> [--output <path>] [--without-context]
  npm run cli -- run (--prompt-file <path> | --stdin) [--output-format json|jsonl]
    [--provider <name>] [--workspace <id>] [--resume <id>] [--data-dir <path>] [--policy-file <path>] [--timeout-ms <ms>] [--max-iterations <n>]

选项：
  --config <path>     YAML 模型配置文件（默认 orbitcode.yaml）
  --workspace <id>    授权 Workspace ID
  --resume <id>       继续已保存会话（不覆盖原绑定）
  --provider <name>   多配置时选择配置名称
  --output <path>     导出 JSON 路径；默认写入当前目录
  --without-context   不包含卸载的完整工具上下文
  --execution-id <id>  单次运行可传入 UUID，供父执行器关联崩溃证据
  --timeout-ms <ms>    单次运行总时限，默认 180000 毫秒
  --max-iterations <n> 单次运行模型轮数上限（1–32），省略时使用配置
  --delegation-kind <kind> 单次运行新子任务类型：defined 或 fork；省略时由模型选择
  --delegation <mode> 单次运行父级分工：collaborate 或 delegate-only
  --help              显示帮助
`;

export function parseCliArguments(argv: readonly string[]): CliArguments {
  if (argv[0] === "run") return parseRunOnceArguments(argv.slice(1));
  if (argv[0] === "export-conversation") {
    const parsed = parseExportRunArguments(argv.slice(1));
    if (parsed.type !== "export-run" || !parsed.includeContext) throw new ArgumentError("会话导出不支持 --without-context。");
    return { type: "export-conversation", conversationId: parsed.runId, ...(parsed.outputPath ? { outputPath: parsed.outputPath } : {}) };
  }
  if (argv[0] === "export-run") return parseExportRunArguments(argv.slice(1));
  let configPath: string | undefined;
  let providerName: string | undefined;
  let help = false;
  let workspaceId: string | undefined;
  let resumeId: string | undefined;
  let dataDir: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--workspace" || argument === "--resume" || argument === "--data-dir") {
      if (argument === "--workspace") {
        if (workspaceId !== undefined) throw new ArgumentError("--workspace 不能重复。");
        workspaceId = requireValue(argv, ++index, argument);
      } else if (argument === "--resume") {
        if (resumeId !== undefined) throw new ArgumentError("--resume 不能重复。");
        resumeId = requireValue(argv, ++index, argument);
      } else {
        if (dataDir !== undefined) throw new ArgumentError("--data-dir 不能重复。");
        dataDir = requireValue(argv, ++index, argument);
      }
      continue;
    }
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
    if (configPath !== undefined || providerName !== undefined || workspaceId !== undefined || resumeId !== undefined || dataDir !== undefined) {
      throw new ArgumentError("--help 不能与其他参数同时使用。");
    }
    return { type: "help" };
  }
  if (resumeId && (providerName || workspaceId)) throw new ArgumentError("--resume 不能覆盖 Provider 或 Workspace。");
  if (dataDir && configPath) throw new ArgumentError("--data-dir 不能与旧版 --config 同时使用。");
  return { type: "run", configPath: configPath ?? "orbitcode.yaml", ...(configPath === undefined ? {} : { explicitConfig: true }), providerName,
    ...(workspaceId ? { workspaceId } : {}), ...(resumeId ? { resumeId } : {}), ...(dataDir ? { dataDir } : {}) };
}

function parseRunOnceArguments(argv: readonly string[]): Extract<CliArguments, { type: "run-once" }> {
  const values = new Map<string, string>();
  let stdin = false;
  const known = new Set(["--prompt-file", "--output-format", "--provider", "--workspace", "--resume", "--data-dir", "--policy-file", "--timeout-ms", "--execution-id", "--max-iterations", "--delegation", "--delegation-kind"]);
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index];
    if (item === "--stdin") { if (stdin) throw new ArgumentError("--stdin 不能重复。"); stdin = true; continue; }
    if (!known.has(item)) throw new ArgumentError(`未知参数：${item}`);
    if (values.has(item)) throw new ArgumentError(`${item} 不能重复。`);
    values.set(item, requireValue(argv, ++index, item));
  }
  const promptFile = values.get("--prompt-file");
  const delegation=values.get("--delegation");
  const delegationKind=values.get("--delegation-kind");
  if(delegationKind!==undefined&&delegationKind!=="defined"&&delegationKind!=="fork")throw new ArgumentError("--delegation-kind 只支持 defined 或 fork。");
  if(delegation!==undefined&&delegation!=="collaborate"&&delegation!=="delegate-only")throw new ArgumentError("--delegation 只支持 collaborate 或 delegate-only。");
  if (Boolean(promptFile) === stdin) throw new ArgumentError("必须且只能选择 --prompt-file 或 --stdin。");
  const outputFormat = values.get("--output-format") ?? "json";
  if (outputFormat !== "json" && outputFormat !== "jsonl") throw new ArgumentError("--output-format 只支持 json 或 jsonl。");
  const maxIterations = values.get("--max-iterations");
  if (maxIterations && (!/^[1-9]\d*$/.test(maxIterations) || Number(maxIterations) > 32)) throw new ArgumentError("--max-iterations 必须在 1 到 32 之间。");
  const timeout = values.get("--timeout-ms");
  if (timeout && (!/^[1-9]\d*$/.test(timeout) || Number(timeout) < 100 || Number(timeout) > 86_400_000)) throw new ArgumentError("--timeout-ms 必须在 100 到 86400000 之间。");
  if (values.has("--resume") && (values.has("--provider") || values.has("--workspace"))) throw new ArgumentError("--resume 不能覆盖已有 Provider 或 Workspace。");
  if (values.has("--policy-file") && !values.has("--data-dir")) throw new ArgumentError("--policy-file 需要 --data-dir 隔离运行。");
  if (values.has("--execution-id") && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(values.get("--execution-id") ?? ""))
    throw new ArgumentError("--execution-id 必须是 UUID。");
  return { type: "run-once", stdin, outputFormat,
    ...(delegation||delegationKind?{parentExecution:{version:1,mode:delegation??"collaborate",...(delegationKind?{delegationKind}:{})}}:{}),
    ...(promptFile ? { promptFile } : {}),
    ...(values.get("--provider") ? { providerName: values.get("--provider") } : {}),
    ...(values.get("--workspace") ? { workspaceId: values.get("--workspace") } : {}),
    ...(values.get("--resume") ? { resumeId: values.get("--resume") } : {}),
    ...(values.get("--data-dir") ? { dataDir: values.get("--data-dir") } : {}),
    ...(values.get("--policy-file") ? { policyFile: values.get("--policy-file") } : {}),
    ...(values.get("--execution-id") ? { executionId: values.get("--execution-id") } : {}),
    ...(timeout ? { timeoutMs: Number(timeout) } : {}),
    ...(maxIterations ? { maxIterations: Number(maxIterations) } : {}),
  };
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
