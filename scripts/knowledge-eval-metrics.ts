export function retrievalMetrics(relevant:readonly string[],retrieved:readonly string[],k=6){
  const expected=new Set(relevant);if(!expected.size)return {recall:null,mrr:null};
  const selected=retrieved.slice(0,k),hits=new Set(selected.filter(path=>expected.has(path))),first=selected.findIndex(path=>expected.has(path));
  return {recall:hits.size/expected.size,mrr:first<0?0:1/(first+1)};
}
export function percentile(values:readonly number[],percent:number){if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(percent*sorted.length)-1)];}
