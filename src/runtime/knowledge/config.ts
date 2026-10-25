import { compileGlob } from "@/tools/glob";
import { createHash } from "node:crypto";
import type { StoredCredential } from "@/runtime/settings-types";
import { KnowledgeError } from "@/core/retrieval/types";
export type KnowledgeConfig = {
  enabled: boolean; endpoint: string; model: string; dimensions: number; credential: StoredCredential;
  remoteEnabled: boolean; include: readonly string[]; exclude: readonly string[]; includeHistorical: boolean;
  documentPrefix: string; queryPrefix: string;
  limits: typeof DEFAULT_KNOWLEDGE_LIMITS;
};
export const DEFAULT_KNOWLEDGE_LIMITS = { maxFiles: 5000, maxFileBytes: 524288, maxScanBytes: 67108864, maxChunks: 10000, concurrency: 2, requestTimeoutMs: 20000, maxRetries: 1, buildTimeoutMs: 600000, maxRequests: 1000, queryTimeoutMs: 25000, evidenceCharacters: 12000 };
const bounds: Record<keyof typeof DEFAULT_KNOWLEDGE_LIMITS, readonly [number, number]> = { maxFiles: [1,10000], maxFileBytes: [1024,1048576], maxScanBytes: [1048576,134217728], maxChunks: [1,20000], concurrency: [1,4], requestTimeoutMs: [1000,30000], maxRetries: [0,1], buildTimeoutMs: [60000,1800000], maxRequests: [1,2000], queryTimeoutMs: [1000,30000], evidenceCharacters: [1000,16000] };
export function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function invalid(): never { throw new KnowledgeError("invalid-arguments", "知识检索配置无效。"); }
export function parseKnowledgeConfig(value: unknown): KnowledgeConfig {
  if (!record(value) || Object.keys(value).some(key => !["enabled","endpoint","model","dimensions","credential","remoteEnabled","include","exclude","includeHistorical","documentPrefix","queryPrefix","limits"].includes(key))) return invalid();
  if (typeof value.enabled !== "boolean" || typeof value.remoteEnabled !== "boolean" || typeof value.includeHistorical !== "boolean" || typeof value.endpoint !== "string" || typeof value.model !== "string" || !value.model.trim() || value.model.length > 256 || !Number.isSafeInteger(value.dimensions) || Number(value.dimensions)<1 || Number(value.dimensions)>4096) return invalid();
  let url: URL; try { url = new URL(value.endpoint); } catch { return invalid(); }
  const local = ["127.0.0.1","localhost","[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(local && url.protocol === "http:")) || (!local && value.enabled && !value.remoteEnabled)) return invalid();
  const credential = value.credential;
  if (!record(credential) || Object.keys(credential).some(key => !["kind","value","variable"].includes(key))) return invalid();
  let parsedCredential: StoredCredential;
  if (credential.kind === "none" && Object.keys(credential).length===1) parsedCredential={kind:"none"};
  else if (credential.kind === "environment" && typeof credential.variable === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(credential.variable) && Object.keys(credential).length===2) parsedCredential={kind:"environment",variable:credential.variable};
  else if (credential.kind === "local" && typeof credential.value === "string" && credential.value.length>0 && credential.value.length<=8192 && !/[\r\n\0]/.test(credential.value) && Object.keys(credential).length===2) parsedCredential={kind:"local",value:credential.value}; else return invalid();
  const patterns = (input: unknown): string[] => {
    if (!Array.isArray(input) || input.length>32 || !input.every((item: unknown): item is string => typeof item === "string" && item.length>0 && item.length<=512 && !item.startsWith("/") && !item.split("/").includes("..") && !/[\\\0]/.test(item))) return invalid();
    try { input.forEach(pattern=>compileGlob(pattern)); } catch { return invalid(); }
    return input;
  };
  if (typeof value.documentPrefix !== "string" || typeof value.queryPrefix !== "string" || value.documentPrefix.length>256 || value.queryPrefix.length>256) return invalid();
  if (!record(value.limits) || Object.keys(value.limits).some(key=>!Object.hasOwn(bounds,key))) return invalid();
  const limits={...DEFAULT_KNOWLEDGE_LIMITS};
  for(const key of Object.keys(bounds) as (keyof typeof bounds)[]) { const n=value.limits[key] ?? limits[key]; if(typeof n!=="number" || !Number.isSafeInteger(n) || n<bounds[key][0] || n>bounds[key][1]) return invalid(); limits[key]=n; }
  return {enabled:value.enabled,endpoint:url.toString(),model:value.model,dimensions:Number(value.dimensions),credential:parsedCredential,remoteEnabled:value.remoteEnabled,include:patterns(value.include),exclude:patterns(value.exclude),includeHistorical:value.includeHistorical,documentPrefix:value.documentPrefix,queryPrefix:value.queryPrefix,limits};
}
export function fingerprint(config: KnowledgeConfig): string { return createHash("sha256").update(JSON.stringify({format:1,chunker:2,tokenizer:1,endpoint:config.endpoint,model:config.model,dimensions:config.dimensions,documentPrefix:config.documentPrefix,queryPrefix:config.queryPrefix})).digest("hex"); }
export function publicKnowledgeConfig(config: KnowledgeConfig) { const {credential,...rest}=config; return {...rest,credential:credential.kind === "environment" ? {kind:credential.kind,configured:true,variable:credential.variable} : {kind:credential.kind,configured:credential.kind!=="none"}}; }
