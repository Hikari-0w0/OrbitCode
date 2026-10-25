import { KnowledgeError, knowledgeFailure } from "@/core/retrieval/types";
import type { KnowledgeService } from "@/runtime/knowledge/service";
import { assertLocalRequest, assertSettingsMutation, LocalManagementError } from "@/web/local-management-guard";
import { readBoundedJsonBody } from "@/web/request-security";
import { record } from "@/runtime/knowledge/config";
export function knowledgeHandlers(resolve:(workspaceId:string)=>Promise<KnowledgeService>){
  return {
    async GET(request:Request){try{assertLocalRequest(request);const id=new URL(request.url).searchParams.get("workspaceId");if(!id)throw new KnowledgeError("invalid-arguments","需要工作区标识。");return Response.json(await(await resolve(id)).status(),{headers:{"cache-control":"no-store"}});}catch(error){return failure(error);}},
    async POST(request:Request){try{
      assertSettingsMutation(request);const value=await readBoundedJsonBody(request,4096);
      if(!record(value)||Object.keys(value).some(key=>!["workspaceId","action","operationId"].includes(key))||typeof value.workspaceId!=="string"||typeof value.action!=="string"||value.operationId!==undefined&&typeof value.operationId!=="string")throw new KnowledgeError("invalid-arguments","知识管理请求无效。");
      const service=await resolve(value.workspaceId);let result:unknown;
      switch(value.action){case"build":case"update":result=await service.start();break;case"rebuild":result=await service.start(true);break;case"cancel":result=await service.cancel(typeof value.operationId==="string"?value.operationId:undefined);break;case"delete":result=await service.delete();break;default:throw new KnowledgeError("invalid-arguments","未知知识管理操作。");}
      return Response.json(result,{headers:{"cache-control":"no-store"}});
    }catch(error){return failure(error);}}
  };
}
function failure(error:unknown){const status=error instanceof LocalManagementError?403:error instanceof KnowledgeError&&error.code==="busy"?409:400;return Response.json(knowledgeFailure(error),{status,headers:{"cache-control":"no-store"}});}
