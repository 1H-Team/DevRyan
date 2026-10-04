import {test,expect,afterAll} from 'bun:test';
import fs from 'node:fs/promises';import path from 'node:path';import {Readable} from 'node:stream';import {createServer} from 'node:http';
import {prepareReviewedNativeInputs,reviewedNativeInputPlugin} from '../native-runtime-assets.mjs';
import {createNativeAssetFixturePlugin,writeNativeFixtureOutputs} from './native-asset-fixture.mjs';
import {createSessionExecutionHost} from '../../packages/web/server/lib/opencode/session-execution-host.js';
import {createNativeInterviewOwner} from '../../packages/web/server/lib/opencode/runtime-host/native-interview-owner.js';
import {git} from '../../packages/harness-runtime/lib/session-changes-git.js';
const repository=path.resolve(import.meta.dirname,'../..');
const root=await fs.mkdtemp(path.join(repository,'.cache/v2-validation/interview-owner-'));
const reviewed=await prepareReviewedNativeInputs(repository);
const worker=await Bun.build({entrypoints:[path.join(repository,'packages/web/server/lib/opencode/runtime-host/writer-worker.ts')],external:['effect','@opencode/core/*','@opencode/schema/*','@opencode/plugin/*','@opencode/util/*'],target:'bun',outdir:root,naming:{entry:'worker.mjs',asset:'[name]-[hash].[ext]'},plugins:[await createNativeAssetFixturePlugin(repository),{name:'owned-sdk-source-entry',setup(builder){builder.onResolve({filter:/^@opencode\/sdk\/effect$/},async()=>({path:await fs.realpath(path.join(repository,'packages/web/node_modules/@opencode/sdk/dist/effect/index.js'))}));}},reviewedNativeInputPlugin(reviewed)]});
const asset=await Bun.build({entrypoints:[path.join(repository,'packages/web/server/lib/opencode/runtime-host/reviewed-configuration-entry.ts')],target:'node',plugins:[reviewedNativeInputPlugin(reviewed)]});
if(!worker.success||!asset.success)throw new AggregateError([...worker.logs,...asset.logs],'Interview original graph failed');
const workerPath=path.join(root,'worker.mjs'),assetPath=path.join(root,'originals.mjs');await writeNativeFixtureOutputs(worker.outputs);await fs.writeFile(assetPath,await asset.outputs[0].text());
const {reviewedSlimInterviewOriginals:originals}=await import(assetPath);afterAll(()=>fs.rm(root,{recursive:true,force:true}));
const origin={kind:'plugin',id:'devryan.slim',manifestDigest:'a'.repeat(64),capabilities:['read','write','process','network','control']};
async function fixture({revokeAfterReceipt=false,onMaterialize,trustedDeletedEvent=false}={}){
 const directory=await fs.mkdtemp(path.join(root,'project-'));await git(directory,['init','--quiet']);await fs.writeFile(path.join(directory,'keep.txt'),'Preserve workspace bytes');
 let live=true;const controller=new AbortController(),receipts=[],effects=[],messages=[{info:{id:'msg_interview_user',sessionID:'ses_interview',role:'user'},parts:[{type:'text',text:'/interview Owned product'}]}];
 const recheck=async()=>{if(!live)throw Object.assign(Error('original_grant_revoked'),{code:'original_grant_revoked'});};
 const host=createSessionExecutionHost({dataDirectory:directory+'-data',onMaterialize,getLauncher:()=>path.join(repository,'packages/web/runtime/darwin-arm64/DevRyan-execution-darwin-arm64'),openCodeClient:{generation:()=>2},nativeExecution:{reviewedAstOrigin:origin,workerCommand:process.execPath,workerArgs:[workerPath],workerEnvironment:{PATH:'/usr/bin:/bin',GIT_CEILING_DIRECTORIES:directory},socketDirectory:null,onTermination:record=>{receipts.push(record);if(revokeAfterReceipt)live=false;},isReady:async()=>true}});
 const owner=createNativeInterviewOwner({locations:[{directory,basePrefix:'/api/openchamber/interviews/owned-location',configuration:{autoOpenBrowser:false,outputFolder:'interview',maxQuestions:2}}],originals,origin,
  captureInterviewAuthorization:async()=>({authorizationID:'auth_original',recheck,signal:controller.signal}),captureInterviewUIAuthorization:async()=>({recheck}),captureInterviewEventAuthorization:async input=>({recheck:trustedDeletedEvent&&input.event.type==='session.deleted'?async()=>{if(input.sessionID!=='ses_interview')throw Error('Untrusted deletion');}:recheck}),
  runtime:{messages:async scope=>{effects.push({kind:'messages',scope});return messages;},continue:async(scope,input)=>effects.push({kind:'continue',scope,input}),notify:async(scope,input)=>effects.push({kind:'notify',scope,input}),rename:async(scope,input)=>effects.push({kind:'rename',scope,input})},
  executeDocument:(input,authority)=>host.nativeInterviewDocument(input,authority),baseURL:async()=>'/owned/interview',openBrowser:async()=>{throw Error('No external browser');}});
 return {directory,host,owner,messages,receipts,effects,revoke:()=>{live=false;},abort:()=>controller.abort(Object.assign(Error('original_command_cancelled'),{code:'original_command_cancelled'}))};
}
const command=(directory,sessionID='ses_interview',args='Owned product')=>({directory,sessionID,messageID:'msg_interview_user',args,permit:{token:'private_command'}});
async function request(owner,directory,url,method='GET',body,parsed=false){
 const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);req.url=url;req.method=method;
 if(parsed){req.body=body;req.resume();}
 let status,bytes;const headers={};const response={set statusCode(value){status=value;},setHeader(key,value){headers[key]=value;},end(value){bytes=Buffer.from(value);}};
 await owner.handleRequest({directory,request:req,response});return {status,headers,bytes,json:()=>JSON.parse(bytes.toString())};
}

test('actual original interview service/UI/answer flow publishes Markdown only after real supervisor receipts',async()=>{
 const f=await fixture();try{
  const parts=[],requestLifetime=new AbortController();await f.owner.handleCommand(command(f.directory),parts,{signal:requestLifetime.signal});requestLifetime.abort(Error('Completed RPC request'));
  const id=await f.owner.getActiveInterviewId({directory:f.directory,sessionID:'ses_interview'});
  const files=await fs.readdir(path.join(f.directory,'interview'));expect(files).toHaveLength(1);const file=path.join(f.directory,'interview',files[0]);
  expect(await fs.readFile(file,'utf8')).toContain('sessionID: ses_interview');expect(parts[0].text).toContain('Owned product');
  expect(f.receipts).toHaveLength(1);expect(f.receipts[0].receipt).toMatchObject({terminated:true,confined:true,cancelled:false,exitCode:0});
  expect(f.effects.find(e=>e.kind==='notify').scope).toMatchObject({directory:f.directory,sessionID:'ses_interview',messageID:'msg_interview_user',authorizationID:'auth_original'});
  expect(f.effects.some(e=>e.kind==='rename')).toBe(true);
  f.messages.push({info:{id:'msg_assistant',sessionID:'ses_interview',role:'assistant'},parts:[{type:'text',text:'<interview_state>'+JSON.stringify({summary:'Actual canonical spec',questions:[{id:'q-1',question:'Who uses it?',options:[]} ]})+'</interview_state>'}]});
  await f.owner.handleEvent({directory:f.directory,sessionID:'ses_interview',event:{type:'session.status',properties:{sessionID:'ses_interview',status:{type:'idle'}}}});
  const state=await request(f.owner,f.directory,`/api/interviews/${id}/state`);expect(state.status).toBe(200);expect(state.json().questions[0].question).toBe('Who uses it?');
  const answer=await request(f.owner,f.directory,`/api/interviews/${id}/answers`,'POST',{answers:[{questionId:'q-1',answer:'Engineers'}]});expect(answer.status).toBe(200);
  expect(await fs.readFile(file,'utf8')).toContain('Q: Who uses it?\nA: Engineers');expect(f.effects.find(e=>e.kind==='continue').input.text).toContain('Engineers');
  expect(f.receipts.every(record=>record.receipt.terminated&&record.receipt.confined&&record.receipt.exitCode===0)).toBe(true);
  expect(await fs.readFile(path.join(f.directory,'keep.txt'),'utf8')).toBe('Preserve workspace bytes');
  const dashboard=await request(f.owner,f.directory,'/');expect(dashboard.status).toBe(200);expect(dashboard.bytes.toString()).toContain('Owned product');
  expect(dashboard.bytes.toString()).toContain('/api/openchamber/interviews/owned-location/interview/');
  const page=await request(f.owner,f.directory,`/interview/${id}`),html=page.bytes.toString();
  const refresh=html.slice(html.indexOf('async function refresh()')),expression=refresh.match(/const url\s*=\s*([\s\S]*?);/)[1];
  // Execute the exact original renderer's URL expression, then make its real
  // same-origin state fetch through the prefixed existing-server shape.
  const url=Function('interviewId','return '+expression)(id),prefix='/api/openchamber/interviews/owned-location';
  expect(url).toBe(prefix+`/api/interviews/${id}/state`);
  const server=createServer((req,res)=>{if(!req.url.startsWith(prefix+'/')){res.statusCode=404;res.end();return;}req.url=req.url.slice(prefix.length);void f.owner.handleRequest({directory:f.directory,request:req,response:res}).catch(cause=>{res.statusCode=cause.statusCode??500;res.end(cause.code);});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{const response=await fetch(`http://127.0.0.1:${server.address().port}`+url);expect(response.status).toBe(200);expect((await response.json()).questions[0].question).toBe('Who uses it?');}
  finally{await new Promise(resolve=>server.close(resolve));}
  await f.owner.handleEvent({directory:f.directory,sessionID:'ses_interview',event:{type:'session.status',properties:{sessionID:'ses_interview',status:{type:'idle'}}}});
  const chat=await request(f.owner,f.directory,`/api/interviews/${id}/chat`,'POST',{message:'Parsed Express body'},true);expect(chat.status).toBe(200);
  expect(f.effects.filter(e=>e.kind==='continue').at(-1).input.text).toContain('Parsed Express body');
 }finally{await f.owner.close();await f.host.drain();}
},60_000);

test('revocation at actual process exit prevents interview publication and any UI notification',async()=>{
 const f=await fixture({revokeAfterReceipt:true});try{
  await expect(f.owner.handleCommand(command(f.directory),[])).rejects.toMatchObject({code:'original_grant_revoked'});
  expect(f.receipts).toHaveLength(1);expect(f.receipts[0].receipt).toMatchObject({terminated:true,confined:true,cancelled:false,exitCode:0});
  expect(await fs.stat(path.join(f.directory,'interview')).catch(()=>null)).toBeNull();expect(f.effects.some(e=>e.kind==='notify'||e.kind==='rename')).toBe(false);
  expect(await f.host.runtime.activeLeases({directory:f.directory})).toEqual([]);
 }finally{await f.owner.close();await f.host.drain();}
},60_000);

test('actual original resume ownership refusal and project-relative existing Markdown behavior are preserved',async()=>{
 const f=await fixture();try{
  const existing=path.join(f.directory,'existing.md');await fs.writeFile(existing,'# Existing project spec\n\n## Current spec\n\nOriginal summary\n');
  await f.owner.handleCommand(command(f.directory,'ses_interview','existing.md'),[]);expect(await fs.readFile(existing,'utf8')).toContain('sessionID: ses_interview');
  const before=await fs.readFile(existing),parts=[];await f.owner.handleCommand(command(f.directory,'ses_other','existing.md'),parts);
  expect(parts[0].text).toContain('already owned by another');expect(await f.owner.getActiveInterviewId({directory:f.directory,sessionID:'ses_other'})).toBeNull();expect(await fs.readFile(existing)).toEqual(before);
  expect(f.receipts.at(-1).receipt).toMatchObject({terminated:true,confined:true,cancelled:false,exitCode:1});
  expect((await f.host.runtime.activeLeases({directory:f.directory}))).toEqual([]);
 }finally{await f.owner.close();await f.host.drain();}
},60_000);

test('lost materialization recovers durable interview contribution and revoked UI sends no response/body effects',async()=>{
 let interruptions=0;const f=await fixture({onMaterialize:()=>{if(interruptions++===0)throw Error('Owned materialization interruption');}});try{
  await f.owner.handleCommand(command(f.directory),[]);expect(interruptions).toBeGreaterThan(1);expect(f.receipts).toHaveLength(1);
  const id=await f.owner.getActiveInterviewId({directory:f.directory,sessionID:'ses_interview'});f.revoke();
  await expect(f.owner.getActiveInterviewId({directory:f.directory,sessionID:'ses_interview'})).rejects.toMatchObject({code:'original_grant_revoked'});
  await expect(request(f.owner,f.directory,`/api/interviews/${id}/chat`,'POST',{message:'Must not deliver'})).rejects.toMatchObject({code:'original_grant_revoked'});
  expect(f.effects.some(e=>e.kind==='continue')).toBe(false);expect(await f.host.runtime.activeLeases({directory:f.directory})).toEqual([]);
 }finally{await f.owner.close();await f.host.drain();}
},60_000);

test('interview canonical paths reject protected metadata/symlink escapes before any worker or publication',async()=>{
 const f=await fixture();try{
  const outside=path.join(root,'outside.md');await fs.writeFile(outside,'Outside canonical bytes');await fs.symlink(outside,path.join(f.directory,'escaped.md'));
  await expect(f.owner.handleCommand(command(f.directory,'ses_interview','escaped.md'),[])).rejects.toMatchObject({code:'native_read_root_denied'});
  await expect(f.owner.handleCommand(command(f.directory,'ses_interview','.git/secret.md'),[])).rejects.toMatchObject({code:'native_read_root_denied'});
  expect(f.receipts).toEqual([]);expect(await fs.readFile(outside,'utf8')).toBe('Outside canonical bytes');
 }finally{await f.owner.close();await f.host.drain();}
},60_000);

test('actual waiting original document worker cancellation settles before return and publishes no bytes',async()=>{
 const f=await fixture();try{
  const file=path.join(f.directory,'waiting.md');await fs.writeFile(file,'# Waiting original document\n');
  await fs.writeFile(file+'.lock',JSON.stringify({pid:1,startedAt:Date.now(),token:'owned-lock'}));
  const requestLifetime=new AbortController(),work=f.owner.handleCommand(command(f.directory,'ses_interview','waiting.md'),[],{signal:requestLifetime.signal});void work.catch(()=>{});
  const deadline=Date.now()+10_000;let claimed=false;
  while(Date.now()<deadline){if((await f.host.runtime.activeLeases({directory:f.directory})).some(lease=>lease.executionKind==='process')){claimed=true;break;}await new Promise(resolve=>setTimeout(resolve,25));}
  expect(claimed).toBe(true);await new Promise(resolve=>setTimeout(resolve,1000));requestLifetime.abort(Object.assign(Error('original_command_cancelled'),{code:'original_command_cancelled'}));
  await expect(work).rejects.toMatchObject({code:'original_command_cancelled'});
  expect(f.receipts).toHaveLength(1);expect(f.receipts[0].receipt).toMatchObject({terminated:true,confined:true,cancelled:true});
  expect(await fs.readFile(file,'utf8')).toBe('# Waiting original document\n');expect(await f.host.runtime.activeLeases({directory:f.directory})).toEqual([]);
 }finally{await f.owner.close();await f.host.drain();}
},60_000);

test('trusted current-controller deletion abandons original ephemeral state after original command authority expires, without IO',async()=>{
 const f=await fixture({trustedDeletedEvent:true});try{
  await f.owner.handleCommand(command(f.directory),[]);const count=f.receipts.length,effects=f.effects.length;f.revoke();
  await f.owner.handleEvent({directory:f.directory,sessionID:'ses_interview',event:{type:'session.deleted',properties:{info:{id:'ses_interview'}}}});
  expect(await f.owner.getActiveInterviewId({directory:f.directory,sessionID:'ses_interview'})).toBeNull();expect(f.receipts).toHaveLength(count);expect(f.effects).toHaveLength(effects);
 }finally{await f.owner.close();await f.host.drain();}
},60_000);
