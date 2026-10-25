import { KnowledgeError } from "@/core/retrieval/types";
import type { KnowledgeConfig } from "@/runtime/knowledge/config";
export type EmbeddingUsage = { kind: "reported"; inputTokens: number } | { kind: "unknown" };
export interface EmbeddingProvider { embed(texts: readonly string[], signal: AbortSignal): Promise<{vectors: number[][]; usage: EmbeddingUsage}>; }
export class HttpEmbeddingProvider implements EmbeddingProvider {
  constructor(private readonly config: KnowledgeConfig, private readonly environment: Readonly<Record<string,string|undefined>> = process.env, private readonly beforeRequest: () => Promise<void> = async()=>{}) {}
  async embed(texts: readonly string[], signal: AbortSignal) {
    const config=this.config;
    if(!texts.length || texts.length>32 || texts.reduce((sum,text)=>sum+Array.from(text).length,0)>16000) throw new KnowledgeError("limit-exceeded","Embedding 批次超过上限。");
    const secret=config.credential.kind === "local" ? config.credential.value : config.credential.kind === "environment" ? this.environment[config.credential.variable] : undefined;
    if(config.credential.kind!=="none" && !secret) throw new KnowledgeError("provider-unavailable","Embedding 凭据未配置。");
    for(let attempt=0;;attempt++) {
      signal.throwIfAborted(); await this.beforeRequest(); signal.throwIfAborted();
      const scoped=AbortSignal.any([signal,AbortSignal.timeout(config.limits.requestTimeoutMs)]);
      try {
        const response=await fetch(config.endpoint.replace(/\/$/,"")+"/embeddings",{method:"POST",redirect:"error",headers:{"content-type":"application/json",...(secret?{authorization:`Bearer ${secret}`}:{})},body:JSON.stringify({model:config.model,input:texts,dimensions:config.dimensions}),signal:scoped});
        if(!response.ok) { await response.body?.cancel(); if((response.status===429 || response.status>=500) && attempt<config.limits.maxRetries) continue; throw new KnowledgeError("provider-unavailable","Embedding 服务返回错误。"); }
        const reader=response.body?.getReader(); if(!reader) throw new KnowledgeError("provider-unavailable","Embedding 响应为空。");
        const buffers: Uint8Array[]=[]; let bytes=0;
        try { for(;;) { const part=await reader.read(); if(part.done)break; bytes+=part.value.byteLength; if(bytes>8*1024*1024) throw new KnowledgeError("provider-unavailable","Embedding 响应过大。"); buffers.push(part.value); } } finally { await reader.cancel().catch(()=>undefined); }
        let value: unknown;try{value=JSON.parse(Buffer.concat(buffers).toString("utf8"));}catch{throw new KnowledgeError("provider-unavailable","Embedding 响应不是有效 JSON。");}
        if(!isRecord(value) || !Array.isArray(value.data) || value.data.length!==texts.length) throw new KnowledgeError("provider-unavailable","Embedding 响应结构无效。");
        const vectors: number[][]=new Array(texts.length); const seen=new Set<number>();
        for(const item of value.data) {
          if(!isRecord(item) || typeof item.index!=="number" || !Number.isInteger(item.index) || item.index<0 || item.index>=texts.length || seen.has(item.index) || !Array.isArray(item.embedding) || item.embedding.length!==config.dimensions || !item.embedding.every((n:unknown):n is number=>typeof n==="number" && Number.isFinite(n))) throw new KnowledgeError("provider-unavailable","Embedding 向量结构无效。");
          const norm=Math.hypot(...item.embedding); if(!Number.isFinite(norm) || norm===0) throw new KnowledgeError("provider-unavailable","Embedding 向量范数无效。");
          seen.add(item.index); vectors[item.index]=item.embedding.map(n=>n/norm);
        }
        const usage: EmbeddingUsage=isRecord(value.usage) && typeof value.usage.prompt_tokens==="number" && Number.isSafeInteger(value.usage.prompt_tokens) && value.usage.prompt_tokens>=0 ? {kind:"reported",inputTokens:value.usage.prompt_tokens} : {kind:"unknown"};
        return {vectors,usage};
      } catch(error) {
        if(signal.aborted) throw new KnowledgeError("cancelled","Embedding 请求已取消。");
        if(scoped.aborted) throw new KnowledgeError("timeout","Embedding 服务超时。");
        if(error instanceof KnowledgeError) throw error;
        if(attempt>=config.limits.maxRetries) throw new KnowledgeError("provider-unavailable","无法连接 Embedding 服务或响应无效。");
      }
    }
  }
}
function isRecord(value:unknown):value is Record<string,unknown> {return typeof value==="object" && value!==null && !Array.isArray(value);}
