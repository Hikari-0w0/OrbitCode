import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { HttpEmbeddingProvider } from "./embedding-provider";
import { parseKnowledgeConfig, DEFAULT_KNOWLEDGE_LIMITS } from "@/runtime/knowledge/config";
async function serverFixture(){let requests=0;let mode="ok";const server=createServer((request,response)=>{requests++;request.resume();if(mode==="retry"&&requests===1){response.writeHead(429);response.end();return;}if(mode==="redirect"){response.writeHead(302,{location:"http://127.0.0.1:1/stolen"});response.end();return;}if(mode==="hang")return;response.setHeader("content-type","application/json");response.end(JSON.stringify({data:mode==="invalid"?[{index:0,embedding:[0,0]}]:[{index:1,embedding:[0,2]},{index:0,embedding:[3,0]}],usage:{prompt_tokens:5}}));});await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();if(!address||typeof address==="string")throw new Error();return {url:`http://127.0.0.1:${address.port}/v1`,set:(value:string)=>{mode=value;requests=0;},count:()=>requests,close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};}
test("HTTP 向量归位归一化、重试、坏向量、重定向与取消",async()=>{
 const server=await serverFixture();try{const config=parseKnowledgeConfig({enabled:true,endpoint:server.url,model:"fixture",dimensions:2,credential:{kind:"local",value:"SYNTHETIC_SECRET"},remoteEnabled:false,include:["**/*.ts"],exclude:[],includeHistorical:false,documentPrefix:"",queryPrefix:"",limits:DEFAULT_KNOWLEDGE_LIMITS});const provider=new HttpEmbeddingProvider(config);const signal=new AbortController().signal;
 assert.deepEqual((await provider.embed(["a","b"],signal)).vectors,[[1,0],[0,1]]);
 server.set("retry");await provider.embed(["a","b"],signal);assert.equal(server.count(),2);
 server.set("invalid");await assert.rejects(provider.embed(["a"],signal),error=>error instanceof Error&&!error.message.includes("SYNTHETIC_SECRET"));assert.equal(server.count(),1);
 server.set("redirect");await assert.rejects(provider.embed(["a","b"],signal));assert.ok(server.count()<=2);
 server.set("hang");const controller=new AbortController();const request=provider.embed(["a","b"],controller.signal);setTimeout(()=>controller.abort(),30);await assert.rejects(request,/取消/);assert.equal(server.count(),1);
 server.set("hang");const bounded=new HttpEmbeddingProvider({...config,limits:{...config.limits,requestTimeoutMs:1000,maxRetries:0}});await assert.rejects(bounded.embed(["a","b"],new AbortController().signal),/超时/);assert.equal(server.count(),1);
 }finally{await server.close();}
});
