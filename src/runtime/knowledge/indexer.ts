import { randomUUID } from "node:crypto";
import { KnowledgeError, type KnowledgeChunk } from "@/core/retrieval/types";
import type { EmbeddingProvider } from "@/models/embedding-provider";
import { fingerprint, type KnowledgeConfig } from "./config";
import type { KnowledgeAccess } from "./access";
import { scanFiles } from "./scanner";
import type { BuildReport, IndexData, KnowledgeStore } from "./store";
export async function buildIndex(input:{store:KnowledgeStore;access:KnowledgeAccess;config:KnowledgeConfig;provider:EmbeddingProvider;signal:AbortSignal;check:()=>Promise<void>;rebuild:boolean}) {
  const {store,access,config,provider,signal,check}=input,started=Date.now();
  const {chunkFile}=await import("./chunker");
  await check();const scan=await scanFiles(access,config,signal);const chunks:KnowledgeChunk[]=[];
  for(const file of scan.files){try{chunks.push(...chunkFile(file));}catch{scan.skipped.push({path:file.path,reason:"parse-or-line-limit"});}if(chunks.length>config.limits.maxChunks||chunks.length*config.dimensions*4>128*1024*1024)throw new KnowledgeError("limit-exceeded","片段或向量容量达到上限。");}
  const state=await store.control();let previous:IndexData|undefined;
  if(!input.rebuild&&state.version){previous=await store.load(state.version);if(previous.fingerprint!==fingerprint(config))throw new KnowledgeError("incompatible","索引配置已改变，请重建。");}
  const old=new Map(previous?.chunks.map((chunk,i)=>[chunk.id,previous!.vectors[i]]));let reused=0;
  const vectors:number[][]=new Array(chunks.length),pending:number[]=[];
  chunks.forEach((chunk,i)=>{const vector=old.get(chunk.id);if(vector){vectors[i]=vector;reused++;}else pending.push(i);});
  if(chunks.length*config.dimensions*24+Buffer.byteLength(JSON.stringify(chunks))*5>256*1024*1024)throw new KnowledgeError("limit-exceeded","索引构建内存预算不足。");
  let usageTokens:number|null=0;
  for(let at=0;at<pending.length;){
    await check();const indexes:number[]=[];let size=0;
    while(at<pending.length&&indexes.length<16){const index=pending[at],text=representation(chunks[index],config);const count=Array.from(text).length;if(count>16000)throw new KnowledgeError("limit-exceeded","单片段向量输入超限。");if(size+count>16000)break;indexes.push(index);size+=count;at++;}
    const result=await provider.embed(indexes.map(i=>representation(chunks[i],config)),signal);indexes.forEach((index,i)=>vectors[index]=result.vectors[i]);usageTokens=usageTokens===null||result.usage.kind==="unknown"?null:usageTokens+result.usage.inputTokens;
  }
  for(const file of scan.files){await check();const now=await access.read(file.path,config.limits.maxFileBytes,signal);if(now.hash!==file.hash)throw new KnowledgeError("busy","文件在构建期间改变，请重新更新。");}
  await check();
  const data:IndexData={version:randomUUID(),fingerprint:fingerprint(config),dimensions:config.dimensions,scannedAt:new Date().toISOString(),chunks,vectors,files:Object.fromEntries(scan.files.map(file=>[file.path,file.hash]))};
  await store.stage(data);
  const report:BuildReport={files:scan.files.length,chunks:chunks.length,reused,requests:0,skippedCount:scan.skipped.length,usageTokens,skipped:scan.skipped.slice(0,100),elapsedMs:Date.now()-started};
  return {data,report};
}
export function representation(chunk:KnowledgeChunk,config:KnowledgeConfig){return `${config.documentPrefix}${chunk.path}\n${chunk.label}\n${chunk.excerpt}`;}
