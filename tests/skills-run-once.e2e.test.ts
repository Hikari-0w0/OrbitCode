import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable,Writable} from 'node:stream';
import path from 'node:path';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {runtimeFixture} from './helpers/runtime-fixture';
import {writeSkill,say,call} from './helpers/skill-fixture';
import {SettingsService} from '@/runtime/settings-service';
import {LocalSettingsStore} from '@/lib/local-settings-store';
import {runOnce} from '@/cli/run-once';
for(const blocked of [false,true]) test(`单次 CLI 独立 Skill JSONL ${blocked?'显式deny禁止写入':'包含子执行事件且可逐行解析'}`,async()=>{
 let count=0;const fixture=await runtimeFixture(()=>++count===1?call(blocked?'write_file':'read_file',blocked?{path:'blocked.txt',content:'no'}:{path:'README.md'}):say('完成'));
 try{
 await writeFile(path.join(fixture.root,'README.md'),'read evidence');await writeSkill(fixture,'worker',{mode:'isolated',tools:[blocked?'write_file':'read_file']});const dataDir=path.join(fixture.root,'.single-data');const settings=new SettingsService(new LocalSettingsStore(dataDir));await settings.apply(0,{type:'provider-add',displayName:'测试替身',model:'test-model',baseUrl:fixture.server.baseUrl,windowTokens:128000,credential:{kind:'local',value:'synthetic-single-run-secret'}});await settings.apply(1,{type:'workspace-add',name:'隔离测试',rootPath:fixture.root});await mkdir(path.join(dataDir,'memory-state-v1'),{recursive:true});await writeFile(path.join(dataDir,'memory-state-v1/settings.json'),'{"enabled":false}');
 if(blocked)await writeFile(path.join(fixture.root,'.orbitcode/permissions.yaml'),'rules:\n  "write_file(blocked.txt)": deny\n');
 let stdout='',stderr='';const output=new Writable({write(chunk,_encoding,done){stdout+=chunk.toString();done();}}),errors=new Writable({write(chunk,_encoding,done){stderr+=chunk.toString();done();}});
 const status=await runOnce({arguments:{type:'run-once',stdin:true,outputFormat:'jsonl',dataDir},cwd:fixture.root,environment:{},input:Readable.from(['/skill run worker']),output,errorOutput:errors});const lines=stdout.trim().split('\n').map(line=>JSON.parse(line));assert.equal(status,0,stderr);assert.ok(lines.some(line=>line.eventType==='skill-run'&&line.skillRun));assert.equal(lines.at(-1).result.outcome,'completed');assert.doesNotMatch(stdout,/synthetic-single-run-secret/);if(blocked)await assert.rejects(readFile(path.join(fixture.root,'blocked.txt')));
 }finally{await fixture.close();}
});
