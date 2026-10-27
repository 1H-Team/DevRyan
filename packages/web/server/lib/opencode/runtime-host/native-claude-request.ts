import {Message} from '@opencode/ai/effect';
import type {NativeProviderAttempt} from './native-provider-runtime-owner.js';

/** v1.11.2's V2 routing, with private authorization independent of resume affinity. */
export function applyNativeClaudeHeaders(headers:Headers,input:{kind:NativeProviderAttempt['kind'];sessionID:string;agentName:string;agentMode:'primary'|'subagent'|'all'}){
 const name=input.agentName.replace(/[^\x20-\x7e]/g,'').trim()||'unknown',lower=name.toLowerCase();
 const detached=input.kind==='title'||input.kind==='generate'||lower==='title'||lower==='summary';
 const compaction=input.kind==='compaction'||lower==='compaction';
 for(const key of ['anthropic-beta','x-opencode-session','x-session-affinity','x-session-id','x-parent-session-id','x-meridian-source','x-opencode-agent-mode','x-opencode-agent-name','x-opencode-request-kind'])headers.delete(key);
 headers.set('x-devryan-session',input.sessionID);
 if(detached)headers.set('x-meridian-source','subagent-'+name);
 else{
  headers.set('x-opencode-session',input.sessionID);
  if(compaction)headers.set('x-meridian-source','subagent-compaction');
 }
 headers.set('x-opencode-agent-name',name);
 headers.set('x-opencode-agent-mode',detached?'subagent':compaction?'primary':input.agentMode==='subagent'?'subagent':'primary');
}

/** Preserve chronological updates without hoisting them into the cached system prefix.
 * Like upstream V2, refuse the entire rewrite across an unresolved local tool call. */
export function normalizeNativeClaudeSystemUpdates(messages:Message[]){
 if(!messages.some(message=>message.role==='system'))return;
 const pending=new Set<string>();
 for(const message of messages){
  if(message.role==='assistant'){
   for(const part of message.content)if(part.type==='tool-call'&&part.providerExecuted!==true)pending.add(part.id);
  }else if(message.role==='tool'){
   for(const part of message.content)if(part.type==='tool-result')pending.delete(part.id);
  }else if(message.role==='system'&&(pending.size>0||message.content.some(part=>part.type!=='text')))return;
 }
 for(const [index,message] of messages.entries())if(message.role==='system'){
  const text=message.content.flatMap(part=>part.type==='text'?[part.text]:[]).join('\n').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const last=message.content.at(-1),cache=last?.type==='text'?last.cache:undefined;
  messages[index]=Message.make({...message,role:'user',content:[{type:'text',text:`<system-update>\n${text}\n</system-update>`,...cache===undefined?{}:{cache}}]});
 }
}
