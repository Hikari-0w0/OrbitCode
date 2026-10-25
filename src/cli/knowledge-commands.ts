import { readBounded } from "@/lib/bounded-files";
import path from "node:path";
import { SettingsService } from "@/runtime/settings-service";
import { parseKnowledgeConfig, record } from "@/runtime/knowledge/config";
import type { AgentRuntime } from "@/runtime/agent-runtime";
export async function runKnowledgeCommand(runtime:Pick<AgentRuntime,"knowledge"|"knowledgeSettingsStore">,workspaceId:string,argument:string){
  const match=/^(\S+)(?:\s+([\s\S]+))?$/.exec(argument.trim());const action=match?.[1]??"status",extra=match?.[2];
  const service=await runtime.knowledge(workspaceId),settings=new SettingsService(runtime.knowledgeSettingsStore);
  if(action==="config"){
    if(!extra)throw new Error("使用 /knowledge config <本地 JSON 文件>，凭据只接受环境变量名。");
    const absolute=path.resolve(extra),value:unknown=JSON.parse((await readBounded(path.dirname(absolute),absolute,65536)).content);
    if(!record(value)||!record(value.credential)||value.credential.kind==="local")throw new Error("CLI 配置凭据只接受 environment 或 none。");
    const config=parseKnowledgeConfig(value),current=await settings.load();if(!current)throw new Error("先配置托管工作区。");
    await settings.apply(current.revision,{type:"knowledge-set",id:workspaceId,config});if(!config.enabled)await service.cancel();
    return {message:"知识配置已保存。远程启用时，构建将发送选定文件片段，检索将发送查询；仅保存不发送正文。",config:await service.status()};
  }
  if(action==="on"||action==="off"){
    const current=await settings.load(),config=current?.workspaces.find(item=>item.id===workspaceId)?.knowledge;if(!current||!config)throw new Error("先 /knowledge config 配置 Embedding 与索引范围。");
    await settings.apply(current.revision,{type:"knowledge-set",id:workspaceId,config:{...config,enabled:action==="on"}});if(action==="off")await service.cancel();return service.status();
  }
  if(extra&&action!=="cancel")throw new Error("知识管理命令参数无效。");
  switch(action){case"status":return service.status();case"build":case"update":return service.start();case"rebuild":return service.start(true);case"cancel":return service.cancel(extra);case"delete":return service.delete();default:throw new Error("使用 /knowledge config|on|off|status|build|update|rebuild|cancel|delete。");}
}
