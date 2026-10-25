import test from "node:test";
import assert from "node:assert/strict";
import { knowledgeHandlers } from "./knowledge-http";
import { openSettingsSession } from "./local-management-guard";
import type { KnowledgeService } from "@/runtime/knowledge/service";
test("知识管理接口拒绝跨源、未授权工作区和未知参数",async()=>{
 let resolved=0;const handlers=knowledgeHandlers(async()=>{resolved++;throw new Error("unauthorized");});
 assert.equal((await handlers.GET(new Request("http://localhost/api/knowledge?workspaceId=x",{headers:{host:"evil.com"}}))).status,403);assert.equal(resolved,0);
 assert.equal((await handlers.POST(new Request("http://localhost/api/knowledge",{method:"POST",headers:{host:"localhost",origin:"https://evil.com"},body:"{}"}))).status,403);assert.equal(resolved,0);
 const headers=openSettingsSession(new Request("http://localhost/api/settings",{headers:{host:"localhost"}}));const token=headers.get("x-orbitcode-settings-token")!;const cookie=headers.get("set-cookie")!.split(";")[0];
 const request=(body:unknown)=>new Request("http://localhost/api/knowledge",{method:"POST",headers:{host:"localhost",origin:"http://localhost",cookie,"x-orbitcode-settings-token":token,"content-type":"application/json"},body:JSON.stringify(body)});
 assert.equal((await handlers.POST(request({workspaceId:"unknown",action:"build"}))).status,400);assert.equal(resolved,1);
 assert.equal((await handlers.POST(request({workspaceId:"unknown",action:"build",path:"/etc/passwd"}))).status,400);assert.equal(resolved,1);
});
test("作业控制只向已解析工作区服务转发",async()=>{
 const calls:string[]=[];const fake:Pick<KnowledgeService,"status"|"start"|"cancel"|"delete">={status:async()=>({enabled:true,index:{kind:"absent"},operation:null}),start:async()=>{calls.push("start");return {operationId:"job"};},cancel:async id=>{calls.push(id??"cancel");return {enabled:true,index:{kind:"absent"},operation:null};},delete:async()=>({enabled:true,index:{kind:"absent"},operation:null})};
 const handlers=knowledgeHandlers(async id=>{assert.equal(id,"authorized");return fake as KnowledgeService;});
 const view=await handlers.GET(new Request("http://localhost/api/knowledge?workspaceId=authorized",{headers:{host:"localhost"}}));assert.equal(view.status,200);assert.equal((await view.json()).index.kind,"absent");assert.deepEqual(calls,[]);
});
