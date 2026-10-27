import {expect,test} from 'bun:test';
import {Message} from '@opencode/ai';
import {applyNativeClaudeHeaders,normalizeNativeClaudeSystemUpdates} from '../../packages/web/server/lib/opencode/runtime-host/native-claude-request.js';

test('Claude helper affinity is detached while private session authorization stays bound',()=>{
 for(const kind of ['primary','title','compaction','generate'] as const){
  const headers=new Headers({'Anthropic-Beta':'old','X-Session-Affinity':'foreign','x-session-id':'foreign','x-parent-session-id':'foreign','x-opencode-session':'foreign','x-meridian-source':'foreign','x-opencode-request-kind':'human','x-retained':'yes'});
  applyNativeClaudeHeaders(headers,{kind,sessionID:'ses_owned',agentName:'Build',agentMode:'all'});
  expect(headers.get('x-devryan-session')).toBe('ses_owned');expect(headers.get('x-retained')).toBe('yes');
  for(const key of ['anthropic-beta','x-session-affinity','x-session-id','x-parent-session-id','x-opencode-request-kind'])expect(headers.has(key)).toBe(false);
  const detached=kind==='title'||kind==='generate';
  expect(headers.get('x-opencode-session')).toBe(detached?null:'ses_owned');
  expect(headers.get('x-meridian-source')).toBe(detached?'subagent-Build':kind==='compaction'?'subagent-compaction':null);
  expect(headers.get('x-opencode-agent-mode')).toBe(detached?'subagent':'primary');
 }
 for(const agentName of ['Title','SUMMARY']){
  const headers=new Headers();applyNativeClaudeHeaders(headers,{kind:'primary',sessionID:'ses_owned',agentName,agentMode:'primary'});
  expect(headers.get('x-opencode-session')).toBeNull();expect(headers.get('x-opencode-agent-mode')).toBe('subagent');
 }
 const headers=new Headers();applyNativeClaudeHeaders(headers,{kind:'primary',sessionID:'ses_owned',agentName:'Compaction',agentMode:'subagent'});
 expect(headers.get('x-opencode-session')).toBe('ses_owned');expect(headers.get('x-meridian-source')).toBe('subagent-compaction');expect(headers.get('x-opencode-agent-mode')).toBe('primary');
});

const call=Message.assistant({type:'tool-call',id:'read-1',name:'read',input:{path:'proof.txt'}});
const result=Message.tool({id:'read-1',name:'read',result:{type:'text',value:'actual result'}});
test('chronological system updates preserve tool results, order, metadata and the last cache marker',()=>{
 const first=Message.user('start'),last=Message.assistant('done');
 const update=Message.make({role:'system',metadata:{owner:'operator'},content:[{type:'text',text:'a & b'},{type:'text',text:'<instruction>',cache:{type:'ephemeral'}}]});
 const messages=[first,call,result,update,last];normalizeNativeClaudeSystemUpdates(messages);
 expect(messages.slice(0,3)).toEqual([first,call,result]);expect(messages[0]).toBe(first);expect(messages[2]).toBe(result);expect(messages[4]).toBe(last);
 expect(messages[3].role).toBe('user');expect(messages[3].metadata).toEqual(update.metadata);
 expect(messages[3].content).toEqual([{type:'text',text:'<system-update>\na &amp; b\n&lt;instruction&gt;\n</system-update>',cache:{type:'ephemeral'}}]);
 const once=[...messages];normalizeNativeClaudeSystemUpdates(messages);expect(messages.every((message,index)=>message===once[index])).toBe(true);
});

test('system updates never rewrite partially across unfinished tools or nontext system content',()=>{
 const update=Message.system('safe update');
 for(const tail of [[call,Message.system('too early')],[Message.make({role:'system',content:{type:'tool-call',id:'invalid',name:'read',input:{}}})]]){
  const messages=[update,...tail],before=[...messages];normalizeNativeClaudeSystemUpdates(messages);
  expect(messages.every((message,index)=>message===before[index])).toBe(true);
 }
 const remote=Message.assistant({type:'tool-call',id:'remote',name:'search',input:{},providerExecuted:true});
 const messages=[remote,Message.system('after remote tool')];normalizeNativeClaudeSystemUpdates(messages);expect(messages[1].role).toBe('user');
});
