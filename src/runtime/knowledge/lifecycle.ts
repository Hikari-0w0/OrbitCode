import { randomUUID } from "node:crypto";
import { acquireLocalFileLock, LocalFileLockError } from "@/lib/local-file-lock";
import { KnowledgeError } from "@/core/retrieval/types";
import type { KnowledgeStore, Operation } from "./store";
export async function beginBuild(store:KnowledgeStore){
  await store.ensure();let release:()=>Promise<void>;
  try{release=await acquireLocalFileLock(store.directory,"build",80);}catch(error){if(error instanceof LocalFileLockError)throw new KnowledgeError("busy","当前工作区已有索引构建。");throw error;}
  try{
    const operation:Operation={id:randomUUID(),pid:process.pid,state:"running"};
    const epoch=await store.mutate(async state=>({state:{...state,operation},value:state.epoch}));
    return {operation,epoch,release};
  }catch(error){await release();throw error;}
}
export async function cancelBuild(store:KnowledgeStore){await store.mutate(async state=>({state:{...state,epoch:randomUUID(),operation:state.operation?{...state.operation,state:"cancelled"}:undefined},value:undefined}));}
export async function recoverStatus(store:KnowledgeStore){
  const control=await store.control();
  if(control.operation?.state!=="running")return control;
  try{process.kill(control.operation.pid,0);return control;}
  catch(error){
    if(!(error instanceof Error)||!("code" in error)||error.code!=="ESRCH")return control;
    return store.mutate(async state=>{
      const next=state.operation && state.operation.id===control.operation?.id && state.operation.state==="running"
        ? {...state,operation:{...state.operation,state:"failed" as const,error:"构建进程中断，未自动重试。"}} : state;
      return {state:next,value:next};
    });
  }
}
