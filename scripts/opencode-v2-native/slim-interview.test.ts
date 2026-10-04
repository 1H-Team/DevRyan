import {expect,test} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {rewriteReviewedSlimServer} from '../../packages/web/server/lib/opencode/runtime-host/reviewed-package-transforms.js';
import {createReviewedSlimInterviewService,type NativeSlimInterviewDocuments,type NativeSlimInterviewRecord} from '../../packages/web/server/lib/opencode/runtime-host/native-slim-interview.ts';
import type {ReviewedSlimCommandPart} from '../../packages/web/runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js';

test('actual interview state machine delegates every document/browser/session effect to its constructor owners',async()=>{
 const root=await fs.mkdtemp(path.resolve('.cache/v2-validation/slim-interview-'));
 try{
  const original=new URL('../../packages/web/runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js',import.meta.url);
  const entry=path.join(root,'reviewed.mjs');await fs.writeFile(entry,rewriteReviewedSlimServer(await fs.readFile(original)).contents);
  const reviewed:typeof import('../../packages/web/runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js')=await import(pathToFileURL(entry).href);
  const events:string[]=[],created:NativeSlimInterviewRecord[]=[];
  const documents:NativeSlimInterviewDocuments={
   withLock:async(_file,action)=>{events.push('lock');return action();},
   ensure:async record=>{events.push('ensure');await reviewed.ensureInterviewFile(record);},
   claim:reviewed.claimInterviewDocument,read:reviewed.readInterviewDocument,rewrite:reviewed.rewriteInterviewDocument,rewriteFinal:reviewed.rewriteInterviewDocumentWithFinalSpec,appendAnswers:reviewed.appendInterviewAnswers,
   readText:(file,encoding)=>fs.readFile(file,encoding),list:file=>fs.readdir(file),resolveExisting:async(...args)=>reviewed.resolveExistingInterviewPath(...args),
  };
  const runtime={messages:async()=>[],notify:async()=>{events.push('notify');},continue:async()=>{events.push('continue');},rename:async()=>{events.push('rename');}};
  const input={factory:reviewed.createInterviewService,directory:root,configuration:{autoOpenBrowser:true,outputFolder:'specs'},documents,runtime,openBrowser:()=>{events.push('browser');},env:{NODE_ENV:'production'}};
  const service=createReviewedSlimInterviewService(input);service.setBaseUrlResolver(async()=> 'http://127.0.0.1:12345');service.setOnInterviewCreated(record=>{created.push(record);});
  const output:{parts:ReviewedSlimCommandPart[]}={parts:[]};
  await service.handleCommandExecuteBefore({command:'interview',sessionID:'ses_fixture',arguments:'Exact original idea'},output);
  expect(created).toHaveLength(1);expect(service.getActiveInterviewId('ses_fixture')).toBe(created[0].id);
  expect(events).toEqual(['lock','ensure','browser','notify','rename']);
  expect(await fs.readFile(created[0].markdownPath,'utf8')).toContain('Exact original idea');expect(output.parts[0].text).toContain('Exact original idea');
  await service.handleCommandExecuteBefore({command:'interview',sessionID:'ses_fixture',arguments:''},output);
  expect(created).toHaveLength(1);expect(events.filter(value=>value==='browser')).toHaveLength(1);expect(output.parts[0].text).toContain('reopened');
  await service.handleEvent({event:{type:'session.deleted',properties:{sessionID:'ses_fixture'}}});expect(service.getActiveInterviewId('ses_fixture')).toBeNull();
  expect(()=>createReviewedSlimInterviewService({...input,configuration:{outputFolder:'../outside'}})).toThrow('native_interview_output_unreviewed');
  expect(()=>Reflect.apply(reviewed.createInterviewService,null,[{directory:root},{},undefined])).toThrow('reviewed_interview_owner_required');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('original native interview bridge binds accepted canonical command before state changes and retains text lifecycle',async()=>{
 const {createOwnedSlimInterviewBridge}=await import('../../packages/web/server/lib/opencode/runtime-host/native-slim-interview-bridge.js');
 const root=await fs.mkdtemp(path.resolve('.cache/v2-validation/slim-interview-bridge-'));
 try{
  const entry=path.join(root,'reviewed.mjs');await fs.writeFile(entry,rewriteReviewedSlimServer(await fs.readFile(new URL('../../packages/web/runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js',import.meta.url))).contents);
  const originals:typeof import('../../packages/web/runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js')=await import(pathToFileURL(entry).href);
  let granted=false,revoked=false,active:string|null=null,disposed=false;const commands:string[]=[],proofs:string[]=[],events:unknown[]=[];
  const bridge=createOwnedSlimInterviewBridge({originals,directory:root,owners:{runtime:{},
   assertCurrent:async()=>{if(revoked)throw new Error('current_grant_revoked');},
   assertAcceptedCommand:async input=>{proofs.push(input.messageID);if(!granted||input.directory!==root||input.sessionID!=='ses_owned'||input.messageID!=='msg_accepted'||input.args!=='exact idea')throw new Error('accepted_command_required');},
   service:{getActiveInterviewId:async()=>active,
    handleCommandExecuteBefore:async(input,output)=>{commands.push(input.arguments);active='interview_owned';output.parts=[{type:'text',text:'original owned interview instruction'}];},
    handleEvent:async input=>{events.push(input.event);}},submitCommand:async()=>{throw new Error('command_grant_required');},dispose:async()=>{disposed=true;},
  }});
  const context=()=>({sessionID:'ses_owned',messages:[{id:'msg_accepted',role:'user',content:[{type:'text',text:'<omos-interview-command> exact idea </omos-interview-command>'}]}]});
  await expect(bridge.handleContext(context())).rejects.toThrow('accepted_command_required');expect(commands).toEqual([]);expect(bridge.getTranscript('ses_owned')).toEqual([]);
  granted=true;const accepted=context();await bridge.handleContext(accepted);expect(commands).toEqual(['exact idea']);expect(accepted.messages[0].content[0].text).toBe('original owned interview instruction');expect(proofs).toEqual(['msg_accepted','msg_accepted']);
  await bridge.handleEvent({type:'session.next.text.started',properties:{sessionID:'ses_owned'}});
  await bridge.handleEvent({type:'session.next.text.delta',properties:{sessionID:'ses_owned',delta:'exact '}});
  await bridge.handleEvent({type:'session.next.text.ended',properties:{sessionID:'ses_owned',text:'exact answer'}});
  expect(bridge.getTranscript('ses_owned').at(-1)).toEqual({info:{role:'assistant'},parts:[{type:'text',text:'exact answer'}]});expect(events).toHaveLength(1);
  revoked=true;await expect(bridge.handleContext(context())).rejects.toThrow('current_grant_revoked');expect(commands).toHaveLength(1);
  await bridge.dispose();expect(disposed).toBe(true);expect(bridge.getTranscript('ses_owned')).toEqual([]);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('original interview UI handler uses existing HTTP owner and injected exact resume candidates',async()=>{
 const {createServer}=await import('node:http');
 const root=await fs.mkdtemp(path.resolve('.cache/v2-validation/slim-interview-http-'));
 const reviewedEntry=path.join(root,'reviewed.mjs');
 await fs.writeFile(reviewedEntry,rewriteReviewedSlimServer(await fs.readFile(new URL('../../packages/web/runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js',import.meta.url))).contents);
 const reviewed:typeof import('../../packages/web/runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js')=await import(pathToFileURL(reviewedEntry).href);
 let authorized=true;const actions:unknown[]=[];
 const prefix='/api/openchamber/interviews/owned_location';
 const handler=reviewed.createInterviewHandler({basePrefix:prefix,authorize:async()=>{actions.push('authorize');if(!authorized)throw new Error('original_owner_revoked');},outputFolder:'specs',listInterviews:()=>[{id:'owned-interview',idea:'Exact idea',status:'active'}],listInterviewFiles:async()=>[],getState:async id=>({id,title:'Exact title'}),submitAnswers:async(id,answers)=>{actions.push({id,answers});},submitBlockComment:async()=>{},submitChat:async()=>{},handleNudgeAction:async()=>{}});
 const server=createServer((request,response)=>{void handler(request,response).catch(()=>{response.statusCode=403;response.end('refused');});});
 try{
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('fixture_listener_missing');const url='http://127.0.0.1:'+address.port;
  const page=await fetch(url+'/');expect(page.status).toBe(200);const html=await page.text();expect(html).toContain('Exact idea');expect(html).toContain('href="'+prefix+'/interview/owned-interview"');
  const detail=await fetch(url+'/interview/owned-interview');const detailHtml=await detail.text();expect(detailHtml).toContain('href="'+prefix+'/"');expect(detailHtml).toContain(JSON.stringify(prefix)+" + '/api/interviews/'");expect(detailHtml).toContain('new EventSource(sseUrl)');
  const state=await fetch(url+'/api/interviews/owned-interview/state');expect(await state.json()).toEqual({id:'owned-interview',title:'Exact title'});
  const answers=await fetch(url+'/api/interviews/owned-interview/answers',{method:'POST',body:JSON.stringify({answers:[{questionId:'q1',answer:'Exact answer'}]})});expect(answers.status).toBe(200);expect(actions.at(-1)).toEqual({id:'owned-interview',answers:[{questionId:'q1',answer:'Exact answer'}]});
  const count=actions.length;authorized=false;expect((await fetch(url+'/api/interviews/owned-interview/answers',{method:'POST',body:'malformed'})).status).toBe(403);expect(actions.slice(count)).toEqual(['authorize']);
  const candidates:string[]=[];expect(await reviewed.resolveReviewedExistingInterviewPath(root,'specs','draft',{exists:async file=>{candidates.push(file);return false;}})).toBeNull();expect(candidates).toEqual([path.join(root,'specs','draft.md')]);
  const canonical=path.join(root,'existing.md');expect(await reviewed.resolveReviewedExistingInterviewPath(root,'specs',canonical,{exists:async file=>file===canonical})).toBe(canonical);
  expect(await reviewed.resolveReviewedExistingInterviewPath(root,'specs',path.resolve(root,'../outside.md'),{exists:async()=>{throw new Error('unsafe_candidate_probed');}})).toBeNull();
  const ownerError=new reviewed.InterviewDocumentOwnershipError(canonical,'ses_original');expect(ownerError.markdownPath).toBe(canonical);expect(ownerError.ownerSessionID).toBe('ses_original');
  expect(()=>Reflect.apply(reviewed.createInterviewHandler,null,[{}])).toThrow('reviewed_interview_http_authorization_required');
  for(const basePrefix of ['https://other.test','/../escape','/api?unsafe','/api/%2f'])expect(()=>reviewed.createInterviewHandler({basePrefix,authorize:async()=>{},outputFolder:'specs',listInterviews:()=>[],listInterviewFiles:async()=>[],getState:async()=>null,submitAnswers:async()=>{},submitBlockComment:async()=>{},submitChat:async()=>{},handleNudgeAction:async()=>{}})).toThrow('reviewed_interview_base_prefix_invalid');
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await fs.rm(root,{recursive:true,force:true});}
});
