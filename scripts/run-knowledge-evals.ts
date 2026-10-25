import { tmpdir, cpus, totalmem } from "node:os";
import { readFile, mkdtemp, cp, mkdir, appendFile, rm, realpath } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { tokenize } from "@/core/retrieval/tokenizer";
import { keywordRanking, vectorRanking, fuseRankings } from "@/core/retrieval/ranking";
import { chunkFile } from "@/runtime/knowledge/chunker";
import { contentHash } from "@/runtime/knowledge/access";
import { parseKnowledgeConfig, DEFAULT_KNOWLEDGE_LIMITS, record } from "@/runtime/knowledge/config";
import { HttpEmbeddingProvider } from "@/models/embedding-provider";
import { retrievalMetrics, percentile } from "./knowledge-eval-metrics";
import type { KnowledgeChunk } from "@/core/retrieval/types";
type Question={id:string;category:string;query:string;evidence:string[];answerPoints:string[];split:"dev"|"test"};
function argumentsMap(){const result=new Map<string,string>();for(let i=2;i<process.argv.length;i+=2){if(!["--mode","--config","--split"].includes(process.argv[i])||!process.argv[i+1])throw new Error("使用 --mode fixture|provider [--config 未入库配置文件] [--split dev|test|all]");result.set(process.argv[i],process.argv[i+1]);}return result;}
function fixtureVector(text:string){const vector=Array.from({length:256},()=>0);for(const term of tokenize(text))vector[createHash("sha256").update(term).digest().readUInt16LE(0)%vector.length]++;const norm=Math.hypot(...vector)||1;return vector.map(n=>n/norm);}
async function main(){
 const args=argumentsMap(),mode=args.get("--mode")??"fixture",split=args.get("--split")??"all";if(!["fixture","provider"].includes(mode)||!["all","dev","test"].includes(split))throw new Error("评估参数无效。");
 const root=path.resolve("tests/fixtures/knowledge"),raw=await readFile(path.join(root,"questions.json"),"utf8"),values:unknown=JSON.parse(raw);
 if(!Array.isArray(values)||values.length!==60||!values.every(value=>record(value)&&typeof value.id==="string"&&typeof value.query==="string"&&typeof value.category==="string"&&Array.isArray(value.evidence)&&value.evidence.every((item:unknown)=>typeof item==="string")&&Array.isArray(value.answerPoints)&&["dev","test"].includes(String(value.split))))throw new Error("问题集无效。");
 const questions=values as Question[],selected=questions.filter(q=>split==="all"||q.split===split),chunks:KnowledgeChunk[]=[];
 const files=[...new Set(questions.flatMap(q=>q.evidence))].sort();let corpus="";
 for(const file of files){const content=await readFile(path.join(root,file),"utf8");corpus+=file+content;chunks.push(...chunkFile({path:file,content,hash:contentHash(content)}));}
 let serviceCalls=0,provider:HttpEmbeddingProvider|undefined,documentPrefix="",queryPrefix="";
 if(mode==="provider"){const configPath=args.get("--config");if(!configPath)throw new Error("provider 模式需要显式 --config。");const parsed=parseKnowledgeConfig(JSON.parse(await readFile(configPath,"utf8")));documentPrefix=parsed.documentPrefix;queryPrefix=parsed.queryPrefix;provider=new HttpEmbeddingProvider(parsed,process.env,async()=>{if(++serviceCalls>200)throw new Error("评估请求预算耗尽");});}
 const embed=async(texts:string[])=>{if(!provider)return texts.map(fixtureVector);const vectors:number[][]=[];for(let i=0;i<texts.length;i+=4)vectors.push(...(await provider.embed(texts.slice(i,i+4),AbortSignal.timeout(30000))).vectors);return vectors;};
 const representations=chunks.map(chunk=>`${documentPrefix}${chunk.path}\n${chunk.label}\n${chunk.excerpt}`),vectors=await embed(representations),rows:unknown[]=[],durations:number[]=[];
 for(const question of selected){
  if(!question.evidence.length){rows.push({id:question.id,category:question.category,split:question.split,status:"requires-agent-or-lifecycle-verification"});continue;}
  const started=performance.now();
  try{const query=(await embed([queryPrefix+question.query]))[0],keyword=keywordRanking(representations,question.query).slice(0,20),semantic=vectorRanking(vectors,query).slice(0,20),hybrid=fuseRankings(keyword,semantic);const results=Object.fromEntries([["keyword",keyword],["semantic",semantic],["hybrid",hybrid]].map(([name,ranking])=>{const paths=(ranking as typeof keyword).map(hit=>chunks[hit.index].path);return [String(name),{...retrievalMetrics(question.evidence,paths),paths:paths.slice(0,6)}];}));const elapsedMs=performance.now()-started;durations.push(elapsedMs);rows.push({id:question.id,split:question.split,status:"completed",results,elapsedMs});}
  catch{rows.push({id:question.id,split:question.split,status:"failed"});}
 }
 const lifecycleBenchmark=mode==="fixture"?await benchmark(root):{status:"not-run"};
 process.stdout.write(JSON.stringify({schemaVersion:1,mode,split,lifecycleBenchmark,questionSetHash:contentHash(raw),corpusHash:contentHash(corpus),questionCount:selected.length,developmentCount:questions.filter(q=>q.split==="dev").length,testCount:questions.filter(q=>q.split==="test").length,serviceCalls,fixtureMeaning:mode==="fixture"?"词法哈希向量仅验证流程，不代表模型语义效果。":undefined,rows,p50Ms:percentile(durations,0.5),p95Ms:percentile(durations,0.95),agentComparison:{status:"not-run",command:"npx tsx scripts/run-knowledge-agent-evals.ts --data-dir <隔离配置目录> --workspace <id> --split dev|test",scoring:"按 rubric 人工核对来源与答案，不自动宣称任务通过。"}},null,2)+"\n");
}
async function benchmark(corpusRoot:string){
 const temporary=await realpath(await mkdtemp(path.join(tmpdir(),"orbitcode-rag-benchmark-")));
 try{
  const workspaceRoot=path.join(temporary,"workspace");await mkdir(workspaceRoot);await cp(path.join(corpusRoot,"corpus"),path.join(workspaceRoot,"corpus"),{recursive:true});
  const {createWorkspaceBoundary}=await import("@/tools/workspace"),{PermissionGateway}=await import("@/tools/permission-gateway"),{KnowledgeAccess}=await import("@/runtime/knowledge/access"),{KnowledgeService}=await import("@/runtime/knowledge/service");
  const workspace=await createWorkspaceBoundary(workspaceRoot),gateway=new PermissionGateway({workspace,agentMode:"plan",loadRules:async()=>[]});
  const config=parseKnowledgeConfig({enabled:true,endpoint:"http://127.0.0.1:1/v1",model:"fixture",dimensions:256,credential:{kind:"none"},remoteEnabled:false,include:["corpus/**/*.md"],exclude:[],includeHistorical:false,documentPrefix:"",queryPrefix:"",limits:DEFAULT_KNOWLEDGE_LIMITS});
  const service=new KnowledgeService({dataRoot:path.join(temporary,"private"),access:new KnowledgeAccess(workspace,gateway),loadConfig:async()=>config,provider:(_config,before)=>({embed:async texts=>{await before();return {vectors:texts.map(fixtureVector),usage:{kind:"unknown"}};}})});
  const build=async()=>{await service.start();for(;;){const state=await service.status();if(state.operation?.state==="finished")return state.operation.report;if(state.operation?.state!=="running")throw new Error("build failed");await new Promise(resolve=>setTimeout(resolve,5));}};
  const first=await build(),unchanged=await build();await appendFile(path.join(workspaceRoot,"corpus/workspace.md"),"\n更新后的说明。\n");const changed=await build();
  const queries=[];for(let n=0;n<6;n++){const result=await service.search({query:"工作区隔离",scope:"docs",limit:6},new AbortController().signal);queries.push(result.kind==="results"?{elapsedMs:result.elapsedMs,retrieval:result.retrieval,hits:result.hits.length}:{error:result.code});}
  return {kind:"injected-fixture",node:process.version,cpu:cpus()[0]?.model,totalMemoryBytes:totalmem(),files:12,dimensions:256,first,unchanged,changed,queries,note:"无外部模型延迟；仅用于生命周期与本地开销观测，不能外推生产性能。"};
 }finally{await rm(temporary,{recursive:true,force:true});}
}
void main().catch(()=>{process.stderr.write("知识评估失败，请检查显式参数、配置和本地服务；未输出敏感请求。\n");process.exitCode=1;});
