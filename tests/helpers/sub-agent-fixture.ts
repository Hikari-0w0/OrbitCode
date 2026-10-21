import { runtimeFixture } from './runtime-fixture';
import { call, say } from './skill-fixture';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
export async function subAgentFixture(kind:'defined'|'fork'='fork', prefixRead=false) {
 let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 let childCalls=0,parentCalls=0;
 const childRequests:unknown[]=[];
 const fixture=await runtimeFixture(async request=>{
   const serialized=JSON.stringify(request.body);
   if(serialized.includes('orbitcode_child_role')) {
     childRequests.push(request.body);
     if(++childCalls===1){await gate;return call('read_file',{path:'evidence.txt'},'child-read');}
     return say('子回复：已观察文件，未单独验收。');
   }
   parentCalls++;
   if(prefixRead&&parentCalls===1)return call('read_file',{path:'evidence.txt'},'parent-read');
   if(parentCalls===(prefixRead?2:1))return call('agent',{operation:'start',task:{kind,prompt:'CHILD_ONLY_TASK',...(kind==='defined'?{role:'explorer'}:{background:true})}},'delegate');
   return say('父回复');
 },{terminal:true});
 await fixture.runtime.memory.setEnabled(false);
 fixture.conversations.configureTasks(cp=>fixture.runtime.invalidateTasks(cp));
 fixture.conversations.configureMemory(fixture.runtime.memory,cp=>fixture.runtime.scheduleSaved(cp));
 await writeFile(path.join(fixture.root,'evidence.txt'),'来自本地文件的证据');
 return {...fixture,release,childRequests,parentCalls:()=>parentCalls,close:async()=>{release();await fixture.close();}};
}
