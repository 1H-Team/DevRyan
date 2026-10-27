import {test,expect} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const repository=path.resolve(import.meta.dirname,'../..');
test('the captured SDK consumes the broker child interface through final assistant/result and real receipt',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'devryan-claude-sdk-channel-')));
 try{
  const entry=path.join(root,'entry.ts');
  await fs.writeFile(entry,`
import {query} from ${JSON.stringify(path.join(repository,'packages/web/runtime/reviewed-inputs/claude-1.11.2/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'))};
import {createClaudeTransportChannel} from ${JSON.stringify(path.join(repository,'packages/web/server/lib/opencode/runtime-host/native-claude-transport-channel.ts'))};
const scope={attemptID:'a'.repeat(64),sessionID:'ses_fixture',directory:${JSON.stringify(root)},profileID:'fixture'};
let input='',current,argumentsSeen=[];
const output=(value)=>channel.accept({protocol:1,type:'claude-transport-reply',id:current,attemptID:scope.attemptID,action:'stdout',chunk:Buffer.from(JSON.stringify(value)+'\\n').toString('base64')});
const finish=()=>channel.accept({protocol:1,type:'claude-transport-reply',id:current,attemptID:scope.attemptID,action:'settled',receipt:{terminated:true,confined:true,cancelled:false,exitCode:0}});
const channel=createClaudeTransportChannel(frame=>queueMicrotask(()=>{
 if(frame.action==='start'){current=frame.id;argumentsSeen=frame.args;channel.accept({protocol:1,type:'claude-transport-reply',id:frame.id,attemptID:scope.attemptID,action:'started',pid:123,incarnation:{version:1,pid:123,hostId:'a'.repeat(64),bootId:'00000000-0000-4000-8000-000000000001',startId:'123',startIdKind:'linux-proc-start-ticks'}});return;}
 if(frame.action==='stdin'){
  input+=Buffer.from(frame.chunk,'base64').toString();channel.accept({protocol:1,type:'claude-transport-reply',id:frame.id,attemptID:scope.attemptID,action:'input-accepted',sequence:frame.sequence});
  let newline;while((newline=input.indexOf('\\n'))>=0){const value=JSON.parse(input.slice(0,newline));input=input.slice(newline+1);
   if(value.type==='control_request')output({type:'control_response',response:{subtype:'success',request_id:value.request_id,response:{}}});
   if(value.type==='user'){
    output({type:'assistant',session_id:'fixture',uuid:'assistant',parent_tool_use_id:null,message:{id:'msg_fixture',type:'message',role:'assistant',model:'fixture',content:[{type:'text',text:'offline final'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:1,output_tokens:1}}});
    output({type:'result',subtype:'success',session_id:'fixture',uuid:'result',is_error:false,duration_ms:1,duration_api_ms:1,num_turns:1,result:'offline final',total_cost_usd:0,usage:{input_tokens:1,output_tokens:1},modelUsage:{},permission_denials:[]});
    finish();
   }
  }return;
 }
}));
const messages=[];
for await(const message of query({prompt:'offline fixture',options:{model:'claude-opus-5-5',effort:'medium',pathToClaudeCodeExecutable:'/owned/DevRyan-Claude-fixture',settingSources:[],persistSession:false,spawnClaudeCodeProcess:options=>channel.spawn({...scope,args:options.args},options.signal)}}))messages.push(message.type);
await channel.close();process.stdout.write(JSON.stringify({messages,effort:argumentsSeen.includes('--effort')&&argumentsSeen[argumentsSeen.indexOf('--effort')+1],activeRuns:channel.activeRuns})+'\\n');
`);
  const result=await promisify(execFile)(process.execPath,[entry],{cwd:root,env:{PATH:'/usr/bin:/bin',HOME:root,TMPDIR:root},timeout:5000,maxBuffer:65536});
  expect(JSON.parse(result.stdout)).toEqual({messages:['assistant','result'],effort:'medium',activeRuns:0});
 }finally{await fs.rm(root,{recursive:true,force:true});}
},7000);
