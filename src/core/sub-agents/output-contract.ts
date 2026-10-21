export type ChildOutputContract = {
  readonly version: 1;
  readonly files: readonly { readonly path: string; readonly contains?: string; readonly sha256?: string }[];
};
export type ChildOutputAssessment = {
  readonly version: 1;
  readonly scope: "declared-file-checks-only";
  readonly checkedAt: string;
  readonly status: "passed" | "failed" | "not-run";
  readonly artifacts: readonly {
    readonly path: string;
    readonly status: "passed" | "failed" | "not-run";
    readonly sha256?: string;
    readonly byteLength?: number;
    readonly errorKind?: string;
  }[];
};

export function parseChildOutputContract(value: unknown): ChildOutputContract {
  if (!record(value) || Object.keys(value).some(key => !["version", "files"].includes(key)) || value.version !== undefined && value.version !== 1 ||
      !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 8) throw new Error("产物契约必须包含1–8个文件。");
  const seen = new Set<string>();
  const files = value.files.map((file: unknown) => {
    if (!record(file) || Object.keys(file).some(key => !["path", "contains", "sha256"].includes(key)) ||
        typeof file.path !== "string" || !file.path || new TextEncoder().encode(file.path).length > 256 ||
        /[\\:\x00-\x1f]/.test(file.path) || file.path.split("/").some(part => !part || part === "." || part === "..") || seen.has(file.path) ||
        file.contains !== undefined && (typeof file.contains !== "string" || !file.contains || new TextEncoder().encode(file.contains).length > 256) ||
        file.sha256 !== undefined && (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256))) throw new Error("产物路径、字面量或哈希无效。");
    seen.add(file.path);
    return { path: file.path, ...(typeof file.contains === "string" ? { contains: file.contains } : {}), ...(typeof file.sha256 === "string" ? { sha256: file.sha256 } : {}) };
  });
  const contract: ChildOutputContract = { version: 1, files };
  if (new TextEncoder().encode(JSON.stringify(contract)).length > 6000) throw new Error("产物契约超过字节上限。");
  return contract;
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
