"use client";
import { useEffect, useState } from "react";
import type { useSettings } from "./use-settings";
import type { PublicSettings } from "@/runtime/settings-types";
type Controller=ReturnType<typeof useSettings>;
export function KnowledgeSettings({controller}:{readonly controller:Controller}){
  if(controller.state.kind!=="ready")return null;
  return <section><h2>仓库知识检索</h2><p>索引文档、源码与测试，帮助 Agent 按自然语言定位材料。构建和更新由你发起。</p>{controller.state.settings.workspaces.filter(item=>item.enabled).map(workspace=><WorkspaceKnowledge key={workspace.id} workspace={workspace} controller={controller} token={controller.state.kind==="ready"?controller.state.token:""}/>)}</section>;
}
function WorkspaceKnowledge({workspace,controller,token}:{readonly workspace:PublicSettings["workspaces"][number];readonly controller:Controller;readonly token:string}){
  const config=workspace.knowledge;
  const [endpoint,setEndpoint]=useState(config?.endpoint??"http://127.0.0.1:8000/v1"),[model,setModel]=useState(config?.model??""),[dimensions,setDimensions]=useState(config?.dimensions??1024),[variable,setVariable]=useState(config?.credential.kind==="environment"?config.credential.variable??"":""),[enabled,setEnabled]=useState(config?.enabled??false),[remote,setRemote]=useState(config?.remoteEnabled??false),[historical,setHistorical]=useState(config?.includeHistorical??false),[include,setInclude]=useState((config?.include??["README.md","AGENTS.md","docs/**/*.md","src/**/*.ts","src/**/*.tsx","tests/**/*.ts","tests/**/*.tsx"]).join("\n")),[exclude,setExclude]=useState((config?.exclude??[]).join("\n")),[status,setStatus]=useState("尚未读取状态"),[notice,setNotice]=useState(""),[pending,setPending]=useState(false),[documentPrefix,setDocumentPrefix]=useState(config?.documentPrefix??""),[queryPrefix,setQueryPrefix]=useState(config?.queryPrefix??""),[limits,setLimits]=useState(JSON.stringify(config?.limits??{},null,2));
  useEffect(()=>{const abort=new AbortController();let running=false;const update=async()=>{if(running)return;running=true;try{const response=await fetch(`/api/knowledge?workspaceId=${encodeURIComponent(workspace.id)}`,{signal:abort.signal,cache:"no-store"});const value:unknown=await response.json();if(!abort.signal.aborted)setStatus(statusText(value));}catch{if(!abort.signal.aborted)setStatus("状态暂不可用");}finally{running=false;}};void update();const timer=setInterval(()=>void update(),1500);return()=>{abort.abort();clearInterval(timer);};},[workspace.id]);
  async function manage(action:string){setPending(true);setNotice("");try{const response=await fetch("/api/knowledge",{method:"POST",headers:{"content-type":"application/json","x-orbitcode-settings-token":token},body:JSON.stringify({workspaceId:workspace.id,action})});const value:unknown=await response.json();setNotice(managementText(value,response.ok));}catch{setNotice("知识管理请求失败。");}finally{setPending(false);}}
  return <section className="settingsCard"><h3>{workspace.name}</h3><form onSubmit={event=>{event.preventDefault();let parsedLimits:unknown;try{parsedLimits=JSON.parse(limits);}catch{controller.setNotice("资源限制必须为有效 JSON 对象。");return;}void controller.apply({type:"knowledge-set",id:workspace.id,config:{enabled,endpoint,model,dimensions,credential:variable?{kind:"environment",variable}:config?.credential.kind==="local"?undefined:{kind:"none"},remoteEnabled:remote,include:include.split(/\r?\n/).filter(Boolean),exclude:exclude.split(/\r?\n/).filter(Boolean),includeHistorical:historical,documentPrefix,queryPrefix,limits:parsedLimits}});}}>
    <label>Embedding API 地址<input value={endpoint} onChange={event=>setEndpoint(event.target.value)} required/></label>
    <label>Embedding 模型<input value={model} onChange={event=>setModel(event.target.value)} required/></label>
    <label>向量维度<input type="number" min={1} max={4096} value={dimensions} onChange={event=>setDimensions(Number(event.target.value))} required/></label>
    <label>凭据环境变量名<input value={variable} onChange={event=>setVariable(event.target.value)} placeholder="本地无鉴权服务可留空"/></label>
    <label>包含范围（每行一个 glob）<textarea value={include} onChange={event=>setInclude(event.target.value)}/></label>
    <label>排除范围（每行一个 glob）<textarea value={exclude} onChange={event=>setExclude(event.target.value)}/></label>
    <label><input type="checkbox" checked={historical} onChange={event=>setHistorical(event.target.checked)}/>包含并标记历史资料</label>
    <p>远程服务启用后，选定范围的文本片段与查询会发送到该服务。保存设置不发送正文；构建与更新会发送片段。</p>
    <label><input type="checkbox" checked={remote} onChange={event=>setRemote(event.target.checked)}/>允许向配置的远程服务发送上述内容</label>
    <label><input type="checkbox" checked={enabled} onChange={event=>setEnabled(event.target.checked)}/>启用当前工作区知识检索</label>
    <details><summary>高级检索配置</summary><label>文档向量前缀<input value={documentPrefix} onChange={event=>setDocumentPrefix(event.target.value)}/></label><label>查询向量前缀<input value={queryPrefix} onChange={event=>setQueryPrefix(event.target.value)}/></label><label>资源限制（JSON，空对象使用默认值）<textarea value={limits} onChange={event=>setLimits(event.target.value)}/></label></details>
    <button type="submit">保存知识设置</button>
  </form>{config&&<details><summary>当前生效配置（凭据已隐藏）</summary><pre>{JSON.stringify(config,null,2)}</pre></details>}<div>{[["build","构建"],["update","更新"],["rebuild","重建"],["cancel","取消作业"],["delete","删除索引"]].map(([action,label])=><button key={action} type="button" disabled={pending||controller.dirty} onClick={()=>void manage(action)}>{label}</button>)}</div><pre aria-label={`${workspace.name} 索引状态`}>{status}</pre>{notice&&<pre role="status">{notice}</pre>}</section>;
}

function object(value:unknown):value is Record<string,unknown>{return typeof value==="object"&&value!==null&&!Array.isArray(value);}
function statusText(value:unknown):string{
  if(!object(value)||!object(value.index))return "索引状态暂不可用";
  const index=value.index,labels:Record<string,string>={absent:"尚未构建",ready:"可查询（仅代表最近扫描版本）",incompatible:"配置已变化，需要重建",corrupt:"索引损坏，需要重建"};
  const lines=[`知识检索：${value.enabled?"已启用":"已停用"}`,`索引：${labels[String(index.kind)]??"未知"}`];
  if(typeof index.files==="number")lines.push(`文件 ${index.files} 个，片段 ${index.chunks} 个`);
  if(typeof index.scannedAt==="string")lines.push(`最近扫描：${new Date(index.scannedAt).toLocaleString()}`);
  if(typeof index.version==="string")lines.push(`版本：${index.version}`);
  if(object(value.operation)){const operation=value.operation,states:Record<string,string>={running:"构建中",finished:"完成",failed:"失败",cancelled:"已取消"};lines.push(`最近作业：${states[String(operation.state)]??"未知"}`);if(typeof operation.error==="string")lines.push(operation.error);if(object(operation.report))lines.push(`复用 ${operation.report.reused} 个片段，跳过 ${typeof operation.report.skippedCount==="number"?operation.report.skippedCount:Array.isArray(operation.report.skipped)?operation.report.skipped.length:0} 个文件`);}
  return lines.join("\n");
}
function managementText(value:unknown,ok:boolean):string{if(!ok)return object(value)&&typeof value.message==="string"?value.message:"操作失败，请重试。";return object(value)&&typeof value.operationId==="string"?"索引作业已启动，可查看下方状态或取消。":"操作已完成。";}
