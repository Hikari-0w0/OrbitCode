import ts from "typescript";
import type { KnowledgeChunk } from "@/core/retrieval/types";
import { contentHash } from "./access";
import { fileScope, historical, type ScannedFile } from "./scanner";
export function chunkFile(file:ScannedFile):KnowledgeChunk[] {
  const lines=file.content.split(/\r?\n/),starts=new Map<number,string>([[0,file.path]]);
  if(file.path.endsWith(".md")) {
    let fenced=false;for(let i=0;i<lines.length;i++){if(/^\s*(```|~~~)/.test(lines[i]))fenced=!fenced;if(!fenced && /^#{1,6}\s/.test(lines[i]))starts.set(i,lines[i].replace(/^#+\s*/,""));}
  } else {
    const source=ts.createSourceFile(file.path,file.content,ts.ScriptTarget.Latest,true,file.path.endsWith(".tsx")?ts.ScriptKind.TSX:ts.ScriptKind.TS);
    for(const statement of source.statements) {
      const start=source.getLineAndCharacterOfPosition(statement.getStart(source)).line;
      const label=ts.isFunctionDeclaration(statement)||ts.isClassDeclaration(statement)?statement.name?.text??file.path:file.path;
      starts.set(start,label);
      if(ts.isClassDeclaration(statement))for(const member of statement.members)if(ts.isMethodDeclaration(member))starts.set(source.getLineAndCharacterOfPosition(member.getStart(source)).line,`${label}.${member.name.getText(source)}`);
    }
  }
  const boundaries=[...starts.keys()].sort((a,b)=>a-b),chunks:KnowledgeChunk[]=[];
  for(let b=0;b<boundaries.length;b++) {
    const from=boundaries[b],until=boundaries[b+1]??lines.length;let start=from,size=0;
    for(let i=from;i<until;i++){
      const length=Array.from(lines[i]).length+1;
      if(length>4000)throw new Error("line-too-long");
      if(size+length>2400 && i>start){add(start,i-1);start=i;size=0;}
      size+=length;
    }
    if(start<until)add(start,until-1);
    function add(start:number,end:number){const excerpt=lines.slice(start,end+1).join("\n");if(!excerpt.trim())return;chunks.push({id:contentHash(`${file.path}:${start}:${starts.get(from)??file.path}:${excerpt}`),path:file.path,startLine:start+1,endLine:end+1,excerpt,label:starts.get(from)??file.path,contentHash:file.hash,historical:historical(file.path),scope:fileScope(file.path)});}
  }
  return chunks;
}
