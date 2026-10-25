import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, mkdir, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { atomicText, nodeError } from "@/lib/bounded-files";
import { acquireLocalFileLock } from "@/lib/local-file-lock";
import { KnowledgeError, type KnowledgeChunk, type KnowledgeFailure } from "@/core/retrieval/types";
import { record } from "./config";
export type IndexData={version:string;fingerprint:string;dimensions:number;scannedAt:string;chunks:KnowledgeChunk[];vectors:number[][];files:Record<string,string>};
export type BuildReport={files:number;chunks:number;reused:number;requests:number;skippedCount:number;usageTokens:number|null;skipped:readonly {path:string;reason:string}[];elapsedMs:number};
export type Operation={id:string;pid:number;state:"running"|"finished"|"failed"|"cancelled";error?:string;failure?:KnowledgeFailure;report?:BuildReport};
export type IndexControl={epoch:string;version?:string;operation?:Operation};
export class KnowledgeStore {
  readonly directory:string;
  constructor(dataRoot:string,workspaceRoot:string,workspaceId=""){this.directory=path.join(dataRoot,"knowledge-v1",createHash("sha256").update(path.resolve(workspaceRoot)+"|"+workspaceId).digest("hex"));}
  async ensure(){await mkdir(this.directory,{recursive:true,mode:0o700});for(const directory of [path.dirname(this.directory),this.directory]){const info=await lstat(directory);if(!info.isDirectory() || info.isSymbolicLink() || (info.mode&0o077)!==0)throw new KnowledgeError("storage","索引目录类型或权限无效。");}}
  async readPrivate(name:string,maxBytes:number):Promise<Buffer>{
    const handle=await open(path.join(this.directory,name),constants.O_RDONLY|constants.O_NOFOLLOW);
    try {const info=await handle.stat();if(!info.isFile()||(info.mode&0o077)!==0||info.size>maxBytes)throw new KnowledgeError("corrupt-index","索引文件类型、权限或大小无效。");const buffer=Buffer.alloc(info.size+1);let size=0;while(size<buffer.length){const read=await handle.read(buffer,size,buffer.length-size,size);if(!read.bytesRead)break;size+=read.bytesRead;}const after=await handle.stat();if(size!==info.size||after.mtimeMs!==info.mtimeMs)throw new KnowledgeError("corrupt-index","索引读取期间变化。");return buffer.subarray(0,size);}finally{await handle.close();}
  }
  async control():Promise<IndexControl>{
    try{const value:unknown=JSON.parse((await this.readPrivate("current.json",524288)).toString("utf8"));if(!record(value)||typeof value.epoch!=="string"||!/^[-a-z0-9]{1,64}$/.test(value.epoch)||(value.version!==undefined&&(typeof value.version!=="string"||!/^[-a-z0-9]{1,64}$/.test(value.version))))throw new Error();if(value.operation!==undefined&&(!record(value.operation)||typeof value.operation.id!=="string"||!Number.isSafeInteger(value.operation.pid)||!["running","finished","failed","cancelled"].includes(String(value.operation.state))))throw new Error();return value as IndexControl;}
    catch(error){if(nodeError(error,"ENOENT"))return {epoch:"initial"};throw new KnowledgeError("corrupt-index","索引控制文件无效。");}
  }
  async mutate<T>(action:(state:IndexControl)=>Promise<{state:IndexControl;value:T}>):Promise<T>{await this.ensure();const release=await acquireLocalFileLock(this.directory,"control");try{const next=await action(await this.control());await atomicText(this.directory,path.join(this.directory,"current.json"),JSON.stringify(next.state));return next.value;}finally{await release();}}
  async inspect(version:string){
    if(!/^[-a-z0-9]{1,64}$/.test(version))throw new KnowledgeError("corrupt-index","索引版本无效。");
    try{
      const value:unknown=JSON.parse((await this.readPrivate(`${version}.manifest.json`,4096)).toString("utf8"));
      if(!record(value)||value.format!==1||typeof value.fingerprint!=="string"||typeof value.scannedAt!=="string"||!Number.isSafeInteger(value.count)||!Number.isSafeInteger(value.dimensions)||Number(value.count)<0||Number(value.count)>20000||Number(value.dimensions)<1||Number(value.dimensions)>4096)throw new Error();
      const [vectors,chunks]=await Promise.all([lstat(path.join(this.directory,`${version}.vectors`)),lstat(path.join(this.directory,`${version}.chunks.json`))]);
      if(!vectors.isFile()||!chunks.isFile()||(vectors.mode&0o077)!==0||(chunks.mode&0o077)!==0||vectors.size!==Number(value.count)*Number(value.dimensions)*4||chunks.size>96*1024*1024)throw new Error();
      return {fingerprint:value.fingerprint,scannedAt:value.scannedAt,files:typeof value.fileCount==="number"?value.fileCount:0,chunks:Number(value.count)};
    }catch{throw new KnowledgeError("corrupt-index","索引元数据无效。");}
  }
  async load(version:string):Promise<IndexData>{
    if(!/^[-a-z0-9]{1,64}$/.test(version))throw new KnowledgeError("corrupt-index","索引版本无效。");
    try{
      const manifest:unknown=JSON.parse((await this.readPrivate(`${version}.manifest.json`,4096)).toString("utf8"));
      if(!record(manifest)||manifest.format!==1||typeof manifest.fingerprint!=="string"||typeof manifest.scannedAt!=="string"||!Number.isInteger(manifest.dimensions)||Number(manifest.dimensions)<1||Number(manifest.dimensions)>4096||!Number.isInteger(manifest.count)||Number(manifest.count)<0||Number(manifest.count)>20000)throw new Error();
      const source=await this.readPrivate(`${version}.chunks.json`,96*1024*1024),bytes=await this.readPrivate(`${version}.vectors`,128*1024*1024);
      if(hash(source)!==manifest.chunksHash||hash(bytes)!==manifest.vectorsHash||bytes.length!==Number(manifest.count)*Number(manifest.dimensions)*4)throw new Error();
      const data:unknown=JSON.parse(source.toString("utf8"));if(!record(data)||!Array.isArray(data.chunks)||data.chunks.length!==manifest.count||!record(data.files)||!Object.values(data.files).every(value=>typeof value==="string"))throw new Error();
      if(bytes.length*3+source.length*3>256*1024*1024)throw new KnowledgeError("limit-exceeded","索引驻留内存预算不足。");
      const chunks:KnowledgeChunk[]=data.chunks.map((chunk:unknown)=>{if(!record(chunk)||typeof chunk.id!=="string"||typeof chunk.path!=="string"||typeof chunk.label!=="string"||typeof chunk.contentHash!=="string"||typeof chunk.excerpt!=="string"||chunk.excerpt.length>8000||typeof chunk.historical!=="boolean"||!["docs","code","tests"].includes(String(chunk.scope))||!Number.isSafeInteger(chunk.startLine)||!Number.isSafeInteger(chunk.endLine)||Number(chunk.startLine)<1||Number(chunk.endLine)<Number(chunk.startLine))throw new Error();return chunk as KnowledgeChunk;});
      const dimensions=Number(manifest.dimensions),vectors=chunks.map((_,index)=>Array.from({length:dimensions},(_,n)=>bytes.readFloatLE((index*dimensions+n)*4)));
      if(vectors.some(vector=>vector.some(n=>!Number.isFinite(n))||Math.abs(Math.hypot(...vector)-1)>0.01))throw new Error();
      return {version,fingerprint:manifest.fingerprint,scannedAt:manifest.scannedAt,dimensions,chunks,vectors,files:data.files as Record<string,string>};
    }catch{throw new KnowledgeError("corrupt-index","索引数据损坏，请重建。");}
  }
  async stage(data:IndexData){
    const chunks=Buffer.from(JSON.stringify({chunks:data.chunks,files:data.files}));if(chunks.length>96*1024*1024||data.vectors.length*data.dimensions*4>128*1024*1024)throw new KnowledgeError("limit-exceeded","索引存储容量不足。");
    const bytes=Buffer.alloc(data.vectors.length*data.dimensions*4);data.vectors.forEach((vector,i)=>vector.forEach((n,j)=>bytes.writeFloatLE(n,(i*data.dimensions+j)*4)));
    for(const [name,buffer] of [[`${data.version}.chunks.json`,chunks],[`${data.version}.vectors`,bytes]] as const){const handle=await open(path.join(this.directory,name),"wx",0o600);try{await handle.writeFile(buffer);await handle.sync();}finally{await handle.close();}}
    await atomicText(this.directory,path.join(this.directory,`${data.version}.manifest.json`),JSON.stringify({format:1,fileCount:Object.keys(data.files).length,fingerprint:data.fingerprint,dimensions:data.dimensions,scannedAt:data.scannedAt,count:data.chunks.length,chunksHash:hash(chunks),vectorsHash:hash(bytes)}));
    await this.load(data.version);
  }
  async removeVersions(keep?:string){for(const name of await readdir(this.directory)){if(/^[a-f0-9-]+\.(?:chunks\.json|vectors|manifest\.json)$/.test(name)&&!name.startsWith(`${keep}.`))await rm(path.join(this.directory,name),{force:true});}}
  async invalidate(){return this.mutate(async state=>({state:{epoch:randomUUID(),operation:state.operation?{...state.operation,state:"cancelled"}:undefined},value:undefined}));}
}
function hash(bytes:Buffer){return createHash("sha256").update(bytes).digest("hex");}
