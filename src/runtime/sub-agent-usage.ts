import type { ModelUsageSummary } from "@/models/usage-tracker";
export function aggregateTaskUsage(parent:ModelUsageSummary,children:readonly {id:string;usage:ModelUsageSummary}[]) {
  const unique=[...new Map(children.map(child=>[child.id,child])).values()];
  const totals={requests:0,reportedRequests:0,failedRequests:0,promptTokens:0,completionTokens:0,totalTokens:0};
  for(const usage of [parent,...unique.map(child=>child.usage)])for(const category of usage.categories)for(const key of Object.keys(totals) as (keyof typeof totals)[])totals[key]+=category[key];
  return {parent,children:unique,total:totals};
}
export function combineModelUsage(left:ModelUsageSummary,right:ModelUsageSummary):ModelUsageSummary {
 const categories=[...left.categories,...right.categories];
 return {scope:'self',categories:[...new Set(categories.map(item=>item.purpose))].map(purpose=>{
  const group=categories.filter(item=>item.purpose===purpose);
  const sum=(key:'requests'|'reportedRequests'|'failedRequests'|'durationMs'|'promptTokens'|'completionTokens'|'totalTokens')=>group.reduce((total,item)=>total+item[key],0);
  const cache=group.flatMap(item=>item.cache?[item.cache]:[]);
  const cacheSum=(key:'tokenRequests'|'cachedTokens'|'hitRequests'|'missRequests'|'unknownRequests')=>cache.reduce((total,item)=>total+item[key],0);
  return {purpose,requests:sum('requests'),reportedRequests:sum('reportedRequests'),failedRequests:sum('failedRequests'),durationMs:sum('durationMs'),promptTokens:sum('promptTokens'),completionTokens:sum('completionTokens'),totalTokens:sum('totalTokens'),...(cache.length?{cache:{tokenRequests:cacheSum('tokenRequests'),cachedTokens:cacheSum('cachedTokens'),hitRequests:cacheSum('hitRequests'),missRequests:cacheSum('missRequests'),unknownRequests:cacheSum('unknownRequests')}}:{})};
 })};
}
