import { KnowledgeError, knowledgeFailure, type KnowledgeReader, type KnowledgeSearchResult, type KnowledgeHit } from "@/core/retrieval/types";
import { keywordRanking, vectorRanking, fuseRankings } from "@/core/retrieval/ranking";
import { selectEvidence } from "@/core/retrieval/evidence";
import { HttpEmbeddingProvider, type EmbeddingProvider, type EmbeddingUsage } from "@/models/embedding-provider";
import { fingerprint, type KnowledgeConfig } from "./config";
import { KnowledgeStore } from "./store";
import { beginBuild, cancelBuild, recoverStatus } from "./lifecycle";
import { buildIndex, representation } from "./indexer";
import type { KnowledgeAccess } from "./access";
import { inScope } from "./scanner";
export type KnowledgeServiceOptions={dataRoot:string;workspaceIdentity?:string;access:KnowledgeAccess;loadConfig:()=>Promise<KnowledgeConfig|undefined>;environment?:Readonly<Record<string,string|undefined>>;provider?:(config:KnowledgeConfig,beforeRequest:()=>Promise<void>)=>EmbeddingProvider};
export class KnowledgeService {
  readonly store:KnowledgeStore;
  private remainingSemanticRequests=8;
  constructor(private readonly options:KnowledgeServiceOptions){this.store=new KnowledgeStore(options.dataRoot,options.access.workspace.root,options.workspaceIdentity);}
  private async config(){const config=await this.options.loadConfig();if(!config?.enabled)throw new KnowledgeError("disabled","当前工作区未启用知识检索。");return config;}
  private provider(config:KnowledgeConfig,beforeRequest:()=>Promise<void>){return this.options.provider?.(config,beforeRequest)??new HttpEmbeddingProvider(config,this.options.environment,beforeRequest);}
  async status(){
    const config=await this.options.loadConfig(),control=await recoverStatus(this.store);let index: {kind:string;version?:string;scannedAt?:string;files?:number;chunks?:number}={kind:"absent"};
    if(control.version)try{const data=await this.store.inspect(control.version);index={kind:config&&data.fingerprint===fingerprint(config)?"ready":"incompatible",version:control.version,scannedAt:data.scannedAt,files:data.files,chunks:data.chunks};}catch{index={kind:"corrupt"};}
    return {enabled:config?.enabled??false,index,operation:control.operation??null};
  }
  async start(rebuild=false){
    const config=await this.config(),lease=await beginBuild(this.store),controller=new AbortController();
    const deadline=Date.now()+config.limits.buildTimeoutMs;
    const timer=setTimeout(()=>controller.abort(),config.limits.buildTimeoutMs);timer.unref();
    // 共享控制文件使另一进程的取消和删除对本进程在途请求生效。
    const poll=setInterval(()=>{void this.store.control().then(state=>{if(state.epoch!==lease.epoch||state.operation?.id!==lease.operation.id||state.operation.state!=="running")controller.abort();}).catch(()=>controller.abort());},100);poll.unref();
    let requests=0;
    const check=async()=>{
      if(controller.signal.aborted)throw new KnowledgeError(Date.now()>=deadline?"timeout":"cancelled","索引构建已取消或超时。");
      const [now,state]=await Promise.all([this.config(),this.store.control()]);
      if(fingerprint(now)!==fingerprint(config)||JSON.stringify(now.include)!==JSON.stringify(config.include)||JSON.stringify(now.exclude)!==JSON.stringify(config.exclude)||now.includeHistorical!==config.includeHistorical)throw new KnowledgeError("incompatible","构建配置已改变。");
      if(state.epoch!==lease.epoch||state.operation?.id!==lease.operation.id||state.operation.state!=="running")throw new KnowledgeError("cancelled","构建作业已失效。");
    };
    void (async()=>{
      try{
        await this.store.removeVersions((await this.store.control()).version);
        const result=await buildIndex({store:this.store,access:this.options.access,config,provider:this.provider(config,async()=>{await check();if(++requests>config.limits.maxRequests)throw new KnowledgeError("limit-exceeded","构建服务请求预算耗尽。");}),signal:controller.signal,check,rebuild});
        await check();result.report.requests=requests;
        await this.store.mutate(async state=>{
          if(state.epoch!==lease.epoch||state.operation?.id!==lease.operation.id||state.operation.state!=="running"||controller.signal.aborted)throw new KnowledgeError("cancelled","构建提交已失效。");
          return {state:{...state,version:result.data.version,operation:{...lease.operation,state:"finished",report:result.report}},value:undefined};
        });
      }catch(error){const failure=knowledgeFailure(Date.now()>=deadline?new KnowledgeError("timeout","索引构建超时。"):error);await this.store.mutate(async state=>({state:state.operation?.id===lease.operation.id&&state.operation.state==="running"?{...state,operation:{...lease.operation,state:"failed",error:failure.message,failure}}:state,value:undefined})).catch(()=>undefined);}
      finally{clearTimeout(timer);clearInterval(poll);await lease.release();}
    })();
    return {operationId:lease.operation.id};
  }
  async cancel(operationId?:string){const state=await this.store.control();if(operationId&&state.operation?.id!==operationId)throw new KnowledgeError("permission-denied","作业不属于当前工作区。");await cancelBuild(this.store);return this.status();}
  async delete(){await this.store.invalidate();await this.store.removeVersions();return this.status();}
  reader():KnowledgeReader{return {search:(input,signal)=>this.search(input,signal)};}
  async search(input:Parameters<KnowledgeReader["search"]>[0],signal:AbortSignal):Promise<KnowledgeSearchResult>{
    const started=Date.now();
    try{
      if(typeof input.query!=="string"||!input.query.trim()||Array.from(input.query).length>1024||!Number.isInteger(input.limit)||input.limit<1||input.limit>10||!["all","code","docs","tests"].includes(input.scope))throw new KnowledgeError("invalid-arguments","检索参数无效。");
      const config=await this.config(),scoped=AbortSignal.any([signal,AbortSignal.timeout(config.limits.queryTimeoutMs)]),initial=await this.store.control();scoped.throwIfAborted();
      if(!initial.version)throw new KnowledgeError("not-indexed","请先构建当前工作区索引。");
      const data=await this.store.load(initial.version);if(data.fingerprint!==fingerprint(config))throw new KnowledgeError("incompatible","索引配置已改变，请重建。");
      const eligible=data.chunks.flatMap((chunk,index)=>(input.scope==="all"||chunk.scope===input.scope)&&inScope(chunk.path,config)?[index]:[]);
      const keyword=keywordRanking(eligible.map(index=>representation(data.chunks[index],config)),input.query).slice(0,20).map(hit=>({...hit,index:eligible[hit.index]}));let semantic:ReturnType<typeof vectorRanking>=[],degradedReason:"provider-unavailable"|"semantic-budget-exhausted"|undefined,usage:EmbeddingUsage={kind:"unknown"},requests=0;
      if(this.remainingSemanticRequests<1)degradedReason="semantic-budget-exhausted";
      else try{
        const result=await this.provider(config,async()=>{scoped.throwIfAborted();await this.config();if(++requests>2||--this.remainingSemanticRequests<0)throw new KnowledgeError("limit-exceeded","语义请求预算耗尽。");}).embed([config.queryPrefix+input.query],scoped);
        usage=result.usage;semantic=vectorRanking(eligible.map(index=>data.vectors[index]),result.vectors[0]).slice(0,20).map(hit=>({...hit,index:eligible[hit.index]}));
      }catch(error){if(scoped.aborted)throw new KnowledgeError(signal.aborted?"cancelled":"timeout","检索服务请求已取消或超时。");degradedReason=error instanceof KnowledgeError&&error.code==="limit-exceeded"?"semantic-budget-exhausted":"provider-unavailable";}
      const ranking=fuseRankings(keyword,semantic),valid:KnowledgeHit[]=[];let staleCount=0;
      for(const candidate of ranking.slice(0,100)){
        scoped.throwIfAborted();const chunk=data.chunks[candidate.index];if((input.scope!=="all"&&chunk.scope!==input.scope)||!inScope(chunk.path,config))continue;
        try{const file=await this.options.access.read(chunk.path,config.limits.maxFileBytes,scoped);if(file.hash!==chunk.contentHash){staleCount++;continue;}}
        catch{scoped.throwIfAborted();staleCount++;continue;}
        valid.push({...chunk,indexVersion:data.version,matchedBy:[...(keyword.some(hit=>hit.index===candidate.index)?["keyword" as const]:[]),...(semantic.some(hit=>hit.index===candidate.index)?["semantic" as const]:[])]});
      }
      const current=await this.store.control(),now=await this.config();scoped.throwIfAborted();
      if(current.epoch!==initial.epoch||current.version!==initial.version)throw new KnowledgeError("cancelled","索引版本已改变，请重新查询。");
      if(JSON.stringify(now)!==JSON.stringify(config))throw new KnowledgeError("incompatible","查询期间配置已改变。");
      const hits=selectEvidence(valid,input.limit,config.limits.evidenceCharacters),omitted=ranking.length-hits.length;
      return {kind:"results",outcome:staleCount||hits.length<valid.length?"partial":hits.length?"matches":"no-match",retrieval:degradedReason?"keyword-fallback":"hybrid",indexVersion:data.version,hits,omitted,staleCount,...(degradedReason?{degradedReason}:{}),elapsedMs:Date.now()-started,usage};
    }catch(error){if(signal.aborted)return knowledgeFailure(new KnowledgeError("cancelled","知识检索已取消。"));if(error instanceof Error&&(error.name==="TimeoutError"||error.name==="AbortError"))return knowledgeFailure(new KnowledgeError("timeout","知识检索超时。"));return knowledgeFailure(error);}
  }
}
