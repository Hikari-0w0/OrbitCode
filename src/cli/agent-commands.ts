export type AgentCommand={readonly kind:'agents'}|{readonly kind:'tasks'}|{readonly kind:'task';readonly action:'show'|'wait'|'background'|'cancel'|'result';readonly id:string;readonly offset?:number};
export function parseAgentCommand(line:string):AgentCommand|undefined {
 const parts=line.trim().split(/\s+/);
 if(parts[0]==='/agents'||parts[0]==='/tasks'){if(parts.length!==1)throw new Error('列表命令不接受参数。');return {kind:parts[0]==='/agents'?'agents':'tasks'};}
 if(parts[0]!=='/task')return;
 const [,action,id,requestId]=parts;
 if(!id||!['show','wait','background','cancel','result'].includes(action)||parts.length>(action==='result'?4:3))throw new Error('使用 /task show|wait|background|cancel <id>，/task result <id> [offset]。');
 if(action==='result'){if(requestId!==undefined&&(!/^\d+$/.test(requestId)||!Number.isSafeInteger(Number(requestId))))throw new Error('正文 offset 必须是非负整数。');return {kind:'task',action,id,offset:Number(requestId??0)};}
 if(action==='show'||action==='wait'||action==='background'||action==='cancel')return {kind:'task',action,id};
}
