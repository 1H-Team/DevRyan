import {test,expect,afterAll} from 'bun:test';
import fs from 'node:fs/promises';import path from 'node:path';import {randomUUID,createHash} from 'node:crypto';
import {prepareReviewedNativeInputs,reviewedNativeInputPlugin} from '../native-runtime-assets.mjs';
import {createNativeAssetFixturePlugin,writeNativeFixtureOutputs} from './native-asset-fixture.mjs';
import {createSessionExecutionHost} from '../../packages/web/server/lib/opencode/session-execution-host.js';
import {createNativeImageRuntime} from '../../packages/web/server/lib/opencode/runtime-host/native-image-runtime.js';
import {createControllerImages} from '../../packages/web/server/lib/opencode/runtime-host/controller-images.ts';
import {createPrivilegedOpenCodeClient} from '../../packages/web/server/lib/opencode/opencode-client/privileged.js';
import {toLLMMessages as toLLMMessages2} from '@opencode/core/session/runner/to-llm-message';
import {git} from '../../packages/harness-runtime/lib/session-changes-git.js';
import {createSessionChangeHost} from '../../packages/harness-runtime/lib/session-changes-host.js';
const repository=path.resolve(import.meta.dirname,'../..');
const root=await fs.mkdtemp(path.join(repository,'.cache/v2-validation/image-worker-'));
const built=await Bun.build({entrypoints:[path.join(repository,'packages/web/server/lib/opencode/runtime-host/writer-worker.ts')],external:['effect','@opencode/core/*','@opencode/schema/*','@opencode/plugin/*','@opencode/util/*'],target:'bun',outdir:root,naming:{entry:'worker.mjs',asset:'[name]-[hash].[ext]'},plugins:[await createNativeAssetFixturePlugin(repository),{name:'owned-sdk-source-entry',setup(builder){builder.onResolve({filter:/^@opencode\/sdk\/effect$/},async()=>({path:await fs.realpath(path.join(repository,'packages/web/node_modules/@opencode/sdk/dist/effect/index.js'))}));}},reviewedNativeInputPlugin(await prepareReviewedNativeInputs(repository))]});
if(!built.success)throw new AggregateError(built.logs,'Original image worker graph failed');
const bundle=path.join(root,'worker.mjs');await writeNativeFixtureOutputs(built.outputs);
afterAll(()=>fs.rm(root,{recursive:true,force:true}));
const origin={kind:'plugin',id:'devryan.slim',manifestDigest:'a'.repeat(64),capabilities:['read','write','process','network','control']};
const bytes=Buffer.from('Exact original image bytes'),sha=createHash('sha1').update(bytes).digest('hex').slice(0,8);
const message={info:{id:'msg_user',sessionID:'ses_images',role:'user'},parts:[{type:'text',text:'Keep this canonical user text'},{id:'prt_image',type:'file',mime:'image/png',filename:'report.png',url:'data:image/png;base64,'+bytes.toString('base64')}]};
async function fixture({imageRouting='auto',disabledAgents=[],revokeAfterReceipt=false,onMaterialize,captureBarrier,readContext}={}){
 const directory=await fs.mkdtemp(path.join(root,'project-'));await git(directory,['init','--quiet']);
 await fs.mkdir(path.join(directory,'.opencode'));await fs.writeFile(path.join(directory,'.opencode/.gitignore'),'*\n');
 await fs.writeFile(path.join(directory,'keep.txt'),'Canonical workspace bytes');
 const receipts=[],changes=[];let live=true,checks=0;
 const dataDirectory=path.join(directory,'..',path.basename(directory)+'-data'),changeHost=createSessionChangeHost({dataDirectory});
 const host=createSessionExecutionHost({dataDirectory,onMaterialize,getLauncher:()=>path.join(repository,'packages/web/runtime/darwin-arm64/DevRyan-execution-darwin-arm64'),
  openCodeClient:{generation:()=>2},recordReceipt:async record=>{changes.push(record);await changeHost.recordReceipt(record);},
  nativeExecution:{reviewedAstOrigin:origin,workerCommand:process.execPath,workerArgs:[bundle],workerEnvironment:{PATH:'/usr/bin:/bin',GIT_CEILING_DIRECTORIES:directory},socketDirectory:null,
   captureContextAssets:async input=>{await captureBarrier?.();const snapshot=readContext?await readContext(input):{records:[message],latestTurnParent:{id:'msg_user',type:'user',fingerprint:'a'.repeat(64)}};
    if(snapshot.latestTurnParent?.id!==input.messageID)throw Error('native_context_message_stale');
    return {contextAssetID:randomUUID(),anchor:snapshot.latestTurnParent,messageIDs:input.messageIDs,origin,messages:snapshot.records.filter(row=>input.messageIDs.includes(row.info.id)),imageRouting,disabledAgents,recheck:async()=>{checks++;if(!live)throw Object.assign(Error('original_grant_revoked'),{code:'original_grant_revoked'});if(readContext&&JSON.stringify(await readContext(input))!==JSON.stringify(snapshot))throw Error('native_context_message_changed');}};},
   onTermination:event=>{receipts.push(event);if(revokeAfterReceipt)live=false;},isReady:async()=>true}});
 return {host,directory,receipts,changes,changeHost,checks:()=>checks};
}

test('whole original image worker publishes canonical user-boundary assets after actual receipt and preserves original notices/backup',async()=>{
 const {host,directory,receipts,changes,changeHost,checks}=await fixture();
 try{
  const result=await host.nativeContextAssets({directory,sessionID:'ses_images',messageID:'msg_user',messageIDs:['msg_user'],permit:{token:'private'}});
  const file=path.join(directory,'.opencode/images/ses_images',`report-${sha}.png`);
  expect(receipts).toHaveLength(1);expect(receipts[0].receipt).toMatchObject({terminated:true,confined:true,cancelled:false,exitCode:0});
  expect(result.receipt).toEqual(receipts[0].receipt);expect(result.publication.files.map(file=>file.path).sort()).toEqual(['.opencode/.gitignore','.opencode/.gitignore.oh-my-opencode-slim-legacy',`.opencode/images/ses_images/report-${sha}.png`]);
  expect(await fs.readFile(file)).toEqual(bytes);expect(await fs.readFile(path.join(directory,'.opencode/.gitignore'),'utf8')).toBe('images/\n');
  expect(await fs.readFile(path.join(directory,'.opencode/.gitignore.oh-my-opencode-slim-legacy'),'utf8')).toBe('*\n');
  expect(result.messages[0].parts[0]).toEqual(message.parts[0]);expect(result.messages[0].parts[1].text).toContain('Saved to: '+file);
  const lease=await host.runtime.leaseForCall({directory,sessionID:'ses_images',messageID:'msg_user',callID:receipts[0].callID});
  expect(result.messages[0].parts[1].text).not.toContain(lease.viewDirectory);expect(result.imagesSkipped).toBe(false);
  expect(changes).toHaveLength(1);expect(changes[0]).toMatchObject({tool:'context-assets',sessionID:'ses_images',messageID:'msg_user',userMessageID:'msg_user'});
  const summary=await changeHost.summarize({directory,rootSessionID:'ses_images',firstUserMessageID:'msg_user'});
  expect(summary.coverage).toBe('complete');expect(summary.files.map(file=>file.path).sort()).toEqual(result.publication.files.map(file=>file.path).sort());
  expect(checks()).toBeGreaterThan(7);expect(await fs.readFile(path.join(directory,'keep.txt'),'utf8')).toBe('Canonical workspace bytes');
  expect(lease).toMatchObject({state:'published',publicationPolicy:'context-images'});
 }finally{await host.drain();}
},60_000);

test.each([{imageRouting:'direct',disabledAgents:[],skipped:false},{imageRouting:'auto',disabledAgents:['observer'],skipped:true}])('original direct/disabled-observer policy preserves canonical image parts %#',async({imageRouting,disabledAgents,skipped})=>{
 const {host,directory,receipts}=await fixture({imageRouting,disabledAgents});
 try{
  const result=await host.nativeExecution({action:'context-assets',directory,sessionID:'ses_images',messageID:'msg_user',messageIDs:['msg_user'],permit:{token:'private'}});
  expect(result.messages).toEqual([message]);expect(result.imagesSkipped).toBe(skipped);
  expect(receipts[0].receipt).toMatchObject({terminated:true,confined:true,cancelled:false,exitCode:0});
  expect(await fs.stat(path.join(directory,'.opencode/images')).catch(()=>null)).toBeNull();
  expect(await fs.readFile(path.join(directory,'.opencode/.gitignore.oh-my-opencode-slim-legacy'),'utf8')).toBe('*\n');
 }finally{await host.drain();}
},60_000);

test('revocation at actual termination refuses publication and discards the real settled private view',async()=>{
 const {host,directory,receipts,changes}=await fixture({revokeAfterReceipt:true});
 try{
  await expect(host.nativeContextAssets({directory,sessionID:'ses_images',messageID:'msg_user',messageIDs:['msg_user'],permit:{token:'private'}})).rejects.toMatchObject({code:'original_grant_revoked'});
  expect(receipts).toHaveLength(1);expect(receipts[0].receipt).toMatchObject({terminated:true,confined:true,cancelled:false,exitCode:0});
  expect(changes).toEqual([]);expect(await fs.stat(path.join(directory,'.opencode/images')).catch(()=>null)).toBeNull();
  expect(await fs.readFile(path.join(directory,'.opencode/.gitignore'),'utf8')).toBe('*\n');
  expect(await host.runtime.activeLeases({directory})).toEqual([]);
 }finally{await host.drain();}
},60_000);

test('actual image publication recovers its committed materialization before returning canonical paths',async()=>{
 let interruptions=0;const {host,directory,receipts,changes}=await fixture({onMaterialize:()=>{if(interruptions++===0)throw Error('owned materialization failure');}});
 try{
  const result=await host.nativeContextAssets({directory,sessionID:'ses_images',messageID:'msg_user',messageIDs:['msg_user'],permit:{token:'private'}});
  expect(interruptions).toBeGreaterThan(1);expect(receipts).toHaveLength(1);expect(changes).toHaveLength(1);
  expect(result.receipt).toMatchObject({terminated:true,confined:true,cancelled:false,exitCode:0});
  const file=path.join(directory,'.opencode/images/ses_images',`report-${sha}.png`);
  expect(result.messages[0].parts[1].text).toContain(file);expect(await fs.readFile(file)).toEqual(bytes);
  const lease=await host.runtime.leaseForCall({directory,sessionID:'ses_images',messageID:'msg_user',callID:receipts[0].callID});
  expect(lease.state).toBe('published');await expect(host.runtime.cancelLease({directory,token:lease.token})).rejects.toMatchObject({code:'execution_already_published'});
 }finally{await host.drain();}
},60_000);

test('caller-provided context asset identity or worker messages are refused before effects',async()=>{
 const {host,directory,receipts}=await fixture();
 try{
  await expect(host.nativeContextAssets({directory,sessionID:'ses_images',messageID:'msg_user',messageIDs:['msg_user'],permit:{token:'private'},contextAssetID:randomUUID()})).rejects.toMatchObject({code:'native_image_scope_invalid'});
  await expect(host.nativeExecution({action:'context-assets',directory,sessionID:'ses_images',messageID:'msg_user',messageIDs:['msg_user'],permit:{token:'private'},messages:[message]})).rejects.toMatchObject({code:'native_image_scope_invalid'});
  expect(receipts).toEqual([]);expect(await host.runtime.activeLeases({directory})).toEqual([]);
 }finally{await host.drain();}
},60_000);

test('fresh worker processes preserve original per-location one-toast state in concurrent context calls',async()=>{
 const {host,directory,receipts}=await fixture({disabledAgents:['observer']});
 try{
  const scope={directory,sessionID:'ses_images',messageID:'msg_user',messageIDs:['msg_user'],permit:{token:'private'}};
  const results=await Promise.all([host.nativeContextAssets(scope),host.nativeContextAssets(scope)]);
  expect(results.map(result=>result.imagesSkipped)).toEqual([true,false]);expect(receipts).toHaveLength(2);
  expect(receipts.every(event=>event.receipt.terminated&&event.receipt.confined&&!event.receipt.cancelled&&event.receipt.exitCode===0)).toBe(true);
  expect(results[0].contextAssetID).not.toBe(results[1].contextAssetID);
  expect(results.map(result=>result.messages)).toEqual([[message],[message]]);
 }finally{await host.drain();}
},60_000);


test('controller settlement cancels paused old capture, reaps its keeper and permits a fresh real worker before terminal drain',async()=>{
 let captures=0;const entered=Promise.withResolvers(),release=Promise.withResolvers();
 const {host,directory,receipts}=await fixture({captureBarrier:async()=>{if(++captures===2){entered.resolve();await release.promise;}}});
 const scope={directory,sessionID:'ses_images',messageID:'msg_user',messageIDs:['msg_user'],permit:{token:'private'}};
 try{
  await host.nativeContextAssets(scope);
  const first=await host.runtime.leaseForCall({directory,sessionID:scope.sessionID,messageID:scope.messageID,callID:receipts[0].callID});
  const stale=host.nativeContextAssets(scope);const rejected=stale.then(()=>null,error=>error);
  await entered.promise;
  let completed=false;const settlement=host.settleController().then(()=>{completed=true;});
  await expect(host.nativeContextAssets(scope)).rejects.toMatchObject({code:'execution_cancelled'});
  await new Promise(resolve=>setTimeout(resolve,20));expect(completed).toBe(false);expect(captures).toBe(2);
  release.resolve();expect(await rejected).toMatchObject({code:'execution_cancelled'});await settlement;
  await host.nativeContextAssets(scope);
  expect(receipts).toHaveLength(2);expect(receipts.every(row=>row.receipt.terminated&&row.receipt.confined&&row.receipt.exitCode===0)).toBe(true);
  const next=await host.runtime.leaseForCall({directory,sessionID:scope.sessionID,messageID:scope.messageID,callID:receipts[1].callID});
  expect(next.ownerID).not.toBe(first.ownerID);expect(next.state).toBe('published');
  await host.drain();
  await expect(host.nativeContextAssets(scope)).rejects.toMatchObject({code:'execution_cancelled'});
  await host.settleController();expect(captures).toBe(3);
 }finally{release.resolve();await host.drain();}
},60_000);

// These are canonical record/renderer graph fixtures. The independent shell
// completion owner tests cover creation of the same source= shell record.
for(const tail of ['shell','status','compaction'])test(`original native ${tail} context selects canonical active images before the actual worker`,async()=>{
 let directory;const sessionID='ses_images';
 const user={id:'msg_user',type:'user',text:'Keep this canonical user text',time:{created:1},files:[{mime:'image/png',name:'report.png',data:bytes.toString('base64'),source:{type:'data'}}]};
 const continuation=tail==='compaction'?{id:'msg_summary',type:'compaction',status:'completed',reason:'auto',summary:'Canonical text summary',recent:'',time:{created:2}}:
  {id:'msg_notice',type:'synthetic',text:tail==='shell'?'<shell id="job_native" state="completed" command="owned command">\nCompleted\n</shell>':'Original status notice',time:{created:2},metadata:tail==='shell'?{source:'shell',jobID:'job_native',shellID:'job_native',state:'completed'}:{devryan:{v:1,origin:'interview',statusOnly:true}}};
 const raw=[user,continuation],privileged=createPrivilegedOpenCodeClient({getRuntime:()=>({generation:2,baseUrl:'http://127.0.0.1:1'}),fetchImpl:async url=>{
  const body=new URL(url).pathname.endsWith('/message')?{data:[...raw].reverse()}:{data:{id:sessionID,location:{directory},agent:'build',model:{providerID:'fixture',model:'fixture'}}};
  return Response.json(body);
 }});
 const readContext=async()=>{const page=await privileged.readCanonicalUserPage(sessionID,{limit:200},{directory});return {records:page.records,latestTurnParent:page.latestTurnParent};};
 const fixtureResult=await fixture({readContext});directory=fixtureResult.directory;const {host,receipts}=fixtureResult;
 const images=createNativeImageRuntime({locations:[{directory}],readContext,admissionOwner:{captureSessionHookAuthorization:async()=>async()=>{}},executionHost:host});
 const transform=createControllerImages(async(method,input)=>method==='native.slim.images'?images.transform(input):images.settle(input),async()=>{});
 try{
  const active=tail==='compaction'?[continuation]:raw;
  const output={messages:toLLMMessages2(active,{providerID:'openai'}).map(info=>({info,parts:info.content}))};
  expect(output.messages.at(-1).info.id).toBe(continuation.id);
  await transform({directory,sessionID,permit:{token:'private'},domain:'session',phase:'context',signal:new AbortController().signal,event:{}},{},output);
  expect(receipts).toHaveLength(1);expect(receipts[0].receipt).toMatchObject({terminated:true,confined:true,cancelled:false,exitCode:0});
  expect(receipts[0].messageID).toBe(tail==='status'?user.id:continuation.id);
  if(tail==='compaction'){
   expect(await fs.stat(path.join(directory,'.opencode/images')).catch(()=>null)).toBeNull();
   expect(output.messages).toHaveLength(1);expect(output.messages[0].info.id).toBe(continuation.id);
  }else{
   const file=path.join(directory,'.opencode/images/ses_images',`report-${sha}.png`);
   expect(await fs.readFile(file)).toEqual(bytes);
   expect(output.messages[0].parts.some(part=>part.type==='media')).toBe(false);
   expect(output.messages[0].parts.some(part=>part.type==='text'&&part.text.includes('Saved to: '+file))).toBe(true);
   expect(output.messages[1].info.id).toBe(continuation.id);
  }
 }finally{await images.close();await host.drain();}
},60_000);
