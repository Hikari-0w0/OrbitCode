import path from "node:path";
import {LocalConversationStore} from "@/lib/local-conversation-store";
import type {ManagedContextMessage} from "@/core/context/types";
async function main(){
 const [data,id]=process.argv.slice(2);if(!data||!id)throw new Error("提供隔离 data-dir 与会话标识。");
 const store=new LocalConversationStore(path.join(data,"conversations-v1")),checkpoint=await store.load(id);
 const history:ManagedContextMessage[]=[];
 for(let i=0;i<10;i++)history.push({kind:"user",content:`历史任务 ${i}：${"用户原文".repeat(25)}`},{kind:"assistant",content:`历史工作 ${i}：${"已有工作".repeat(1000)}`});
 const result=await store.save({conversationId:id,expectedRevision:checkpoint.summary.revision,checkpoint:{...checkpoint,lastTurn:{turnId:"historical-test",endedAt:new Date(Date.now()-48*60*60*1000).toISOString(),stopReason:"agent-error",memoryEligibility:false},context:{...checkpoint.context,messages:history}}});
 if(result.status!=="saved")throw new Error("测试会话修订冲突。");process.stdout.write(`已构造 48 小时间隔及压缩历史，revision ${result.checkpoint.summary.revision}\n`);
}
void main();
