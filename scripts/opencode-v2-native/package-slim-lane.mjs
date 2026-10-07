import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {resolveSqliteDriver} from '../../packages/web/server/lib/opencode/db-maintenance-core.js';

const repository=fileURLToPath(new URL('../../',import.meta.url)).replace(/\/$/,'');
const originalPath='packages/web/runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js';
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const slices=[
 ['// src/hooks/command-hook-utils.ts','// src/hooks/deepwork/index.ts'],
 ['// src/hooks/deepwork/index.ts','// src/hooks/types.ts'],
 ['// src/hooks/loop-command/index.ts','// src/hooks/task-session-manager/continuation-model-selection.ts'],
 ['// src/hooks/reflect/index.ts','// src/hooks/search-path-guard/index.ts'],
];
function exactSlice(source,start,end){
 assert.equal(source.split(start).length,2,`Original command anchor changed: ${start}`);
 const offset=source.indexOf(start),stop=source.indexOf(end,offset);
 assert.ok(stop>offset,`Original command boundary changed: ${end}`);
 return source.slice(offset,stop);
}
/** Execute only the original pure command factories, never the package module
 * or its setup. Production evidence additionally binds these bytes to the
 * already verified compiled artifact's complete source inventory. */
export async function loadOriginalSlimCommandOracle({artifacts}={}){
 const capture=JSON.parse(await fs.readFile(path.join(repository,'packages/web/runtime/reviewed-inputs/manifest.json'),'utf8'));
 const pinned=capture.inputs.find(row=>row.id==='slim-2.2.25').files.find(row=>row.path==='dist/server/index.js');
 const bytes=await fs.readFile(path.join(repository,originalPath));assert.equal(sha256(bytes),pinned.sha256);
 if(artifacts){
  const compiled=artifacts.manifest.inputs.sourceFiles.find(row=>row.path===originalPath);
  assert.ok(compiled,'Original Slim source absent from compiled evidence');assert.equal(compiled.sha256,pinned.sha256);
 }
 const source=bytes.toString('utf8');
 const context=vm.createContext(Object.create(null),{codeGeneration:{strings:false,wasm:false}});
 const factories=new vm.Script(slices.map(([start,end])=>exactSlice(source,start,end)).join('\n')+
  '\n({deepwork:createDeepworkCommandHook,loop:createLoopCommandHook,reflect:createReflectCommandHook})').runInContext(context,{timeout:1000});
 return {sourceSha256:pinned.sha256,async prompt(command,args){
  assert.ok(Object.hasOwn(factories,command));assert.equal(typeof args,'string');
  // These positive cases avoid the internal synthetic help branch; that
  // branch is already covered by the actual SDK command contract tests.
  if(command!=='reflect')assert.ok(args.trim());
  const hook=factories[command]();hook.registerCommand({});const output={parts:[]};
  await hook.handleCommandExecuteBefore({command,sessionID:'oracle_only',arguments:args},output);
  assert.equal(output.parts.length,1);assert.equal(output.parts[0].type,'text');
  return output.parts[0].text;
 }};
}

/** The original loop factory chooses one random history directory and uses it
 * twice. Only that spelling is nondeterministic; everything else stays exact. */
export function normalizeOriginalLoopPrompt(text){
 assert.equal(typeof text,'string');
 const paths=text.match(/\.opencode\/loop-history\/loop-[a-z0-9]+-[a-z0-9]+/g)??[];
 assert.equal(paths.length,2,'Original loop history references changed');assert.equal(paths[0],paths[1]);
 return text.replaceAll(paths[0],'.opencode/loop-history/loop-<original-random-id>');
}
const model={providerID:'devryan-smoke',modelID:'smoke-write'};
const contentText=value=>typeof value==='string'?value:Array.isArray(value)
 ?value.filter(part=>part?.type==='text'&&typeof part.text==='string').map(part=>part.text).join('\n'):'';
async function enrolledSession(client,directory,admitPrimary,title){
 assert.equal(typeof admitPrimary,'function');
 const session=await client.sessions.create({title,agent:'orchestrator',model},{directory});await admitPrimary(session.id);return session;
}

/** Real compiled SDK command factories, exact canonical user bytes, and actual
 * HTTP model inference. Fixture responses do not execute or replace hooks. */
export async function runCompiledSlimCommands({provider,client,runtimeOwner,directory,admitPrimary,onCase,waitFor,artifacts}){
 assert.ok(artifacts,'Verified compiled artifact evidence required');
 const oracle=await loadOriginalSlimCommandOracle({artifacts}),cases=[];
 const location=runtimeOwner.getConfigurationSnapshot().locations.find(row=>row.directory===directory);assert.ok(location);
 for(const [command,args]of [['deepwork','Verify the isolated local fixture without changing files'],
  ['loop','Verify the isolated fixture; successCriteria: exact local checks pass; maxAttempts: 1'],
  ['reflect','--sessions --last 7 repeated isolated test friction']]){
  assert.equal(location.compatibility.commands[command],undefined,'Saved override shadows original Slim factory');
  const expected=await oracle.prompt(command,args),session=await enrolledSession(client,directory,admitPrimary,`Compiled original ${command}`);
  let requests=0,wirePrompt;const result=`compiled original ${command} completed`;
  await provider.setResponder(request=>{
   assert.equal(++requests,1,'Original command duplicated inference');assert.equal(request.body.model,model.modelID);
   const user=request.body.messages.filter(message=>message.role==='user').at(-1);assert.ok(user);
   wirePrompt=contentText(user.content);
   assert.ok(command==='loop'?normalizeOriginalLoopPrompt(wirePrompt).includes(normalizeOriginalLoopPrompt(expected)):wirePrompt.includes(expected),'Original command activation missing from physical request');
   return {items:[{type:'textDelta',text:result}],reason:'stop'};
  });
  await client.prompts.command(session.id,{command,arguments:args,agent:'orchestrator',model},{directory,timeoutMs:30000});
  const page=await waitFor(()=>client.sessions.messages(session.id,{}, {directory}),page=>page.records.some(row=>row.info.role==='assistant'
   &&row.info.time?.completed&&row.parts.some(part=>part.type==='text'&&part.text===result)),`Original ${command} did not complete`);
  const users=page.records.filter(row=>row.info.role==='user');assert.equal(users.length,1);assert.equal(requests,1);
  const assistant=page.records.find(row=>row.info.role==='assistant'&&row.parts.some(part=>part.type==='text'&&part.text===result));
  assert.equal(assistant.info.agent,'orchestrator');assert.equal(assistant.info.providerID,model.providerID);assert.equal(assistant.info.modelID,model.modelID);
  assert.equal(assistant.info.variant,'default');assert.equal(assistant.turnOwnership?.source,'native-sequence');assert.equal(assistant.turnOwnership.userMessageID,users[0].info.id);
  const actual=users[0].parts.filter(part=>part.type==='text').map(part=>part.text).join('\n');
  if(command==='loop')assert.equal(normalizeOriginalLoopPrompt(actual),normalizeOriginalLoopPrompt(expected));else assert.equal(actual,expected);
  assert.ok(wirePrompt.includes(actual),'Physical model request lost canonical original activation');
  const row={id:`compiled-active-command-${command}`,status:'passed',sessionID:session.id,userMessageID:users[0].info.id,
   promptSha256:sha256(actual),originalSourceSha256:oracle.sourceSha256,source:'actual-original-sdk-command-factory-canonical-user-and-http-inference',personalProviderParity:false};
  onCase?.(row);cases.push(row);
 }
 return cases;
}

/** Existing owned interview handler mounted on a private fixture HTTP server.
 * The runtime's original constructor authorization remains the sole authority.
 * This is not the legacy standalone interview listener/dashboard manager. */
export async function createCompiledSlimWebBridge(){
 let owner,closed=false,closing;const events=[],active=new Set();
 const server=createServer((request,response)=>{
  const work=(async()=>{
   if(!owner||closed){response.writeHead(503).end();return;}
   const handled=await owner.handleInterviewRequest(request,response);if(!handled)response.writeHead(404).end();
  })().catch(cause=>{if(!response.headersSent)response.writeHead(cause.statusCode??500);response.end('Owned interview fixture request refused');})
   .finally(()=>active.delete(work));active.add(work);
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
 const baseURL=`http://127.0.0.1:${server.address().port}`;
 return {getWebBaseURL:()=>baseURL,events,
  emitIntegrationEvent:async event=>{assert.equal(closed,false);assert.ok(event&&typeof event.directory==='string'&&typeof event.sessionID==='string');
   assert.ok(['interview-open','images-skipped'].includes(event.kind));
   if(event.kind==='interview-open')assert.match(event.path,/^\/api\/openchamber\/interviews\/[a-f0-9]{64}(?:\/.*)?$/);
   events.push(structuredClone(event));},
  bindRuntimeOwner:runtime=>{assert.equal(owner,undefined);assert.equal(typeof runtime.handleInterviewRequest,'function');owner=runtime;},
  async request(directory,suffix,options={}){
   assert.equal(closed,false);assert.ok(suffix.startsWith('/')&&!suffix.includes('..'));
   const prefix='/api/openchamber/interviews/'+sha256(directory);
   try { return await fetch(baseURL+prefix+suffix,{...options,signal:AbortSignal.timeout(10000)}); }
   catch(error) {
    error.protocolEvidence={lane:'compiled-slim-interview',method:options.method??'GET',route:suffix,timeoutMs:10000};
    throw error;
   }
  },
  close:()=>closing??=(async()=>{closed=true;await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await Promise.allSettled(active);})(),
 };
}

async function interviewState(bridge,directory,sessionID){
 const listed=await bridge.request(directory,'/api/interviews');assert.equal(listed.status,200);
 const rows=await listed.json();assert.ok(Array.isArray(rows.active));
 const active=[];
 for(const row of rows.active){
  assert.equal(typeof row.id,'string');
  const response=await bridge.request(directory,`/api/interviews/${encodeURIComponent(row.id)}/state`);assert.equal(response.status,200);
  const state=await response.json();if(state.interview?.sessionID===sessionID)active.push({id:row.id,state});
 }
 assert.ok(active.length<=1,'Original interview created duplicate session state');return active[0]??null;
}
// The facade intentionally projects a standalone native synthetic as role=user.
// Count the actual accepted command and original no-reply notice independently.
export function assertCompiledInterviewUsers({records,canonical,sessionID,idea}){
 const accepted=canonical.filter(row=>row.type==='user');
 assert.equal(accepted.length,1,'Interview must have exactly one native accepted user');
 const command=accepted[0],proof=command.metadata?.devryan?.command;
 assert.equal(proof?.name,'interview');assert.equal(proof.sessionID,sessionID);assert.equal(proof.messageID,command.id);
 assert.equal(command.text,`<omos-interview-command>${idea}</omos-interview-command>`);
 const notices=canonical.filter(row=>row.type==='synthetic');
 assert.equal(notices.length,1,'Original interview must emit exactly one native no-reply UI notification');
 const notice=notices[0];assert.equal(notice.metadata?.devryan?.origin,'interview');
 assert.ok(notice.text.startsWith('⎔ Interview UI ready\n\nOpen: '));
 assert.ok(notice.text.endsWith('[system status: continue without acknowledging this notification]'));
 const users=records.filter(row=>row.info.role==='user');
 assert.equal(users.length,2,'Facade must preserve one accepted command and one standalone synthetic notification');
 const user=users.find(row=>row.info.id===command.id),projectedNotice=users.find(row=>row.info.id===notice.id);
 assert.ok(user,'Accepted native command identity missing from facade');
 assert.ok(user.parts.some(part=>part.type==='text'&&part.synthetic!==true&&part.text===command.text));
 assert.ok(projectedNotice,'Original no-reply notification identity missing from facade');
 assert.equal(projectedNotice.parts.length,1);assert.equal(projectedNotice.parts[0].synthetic,true);
 assert.equal(projectedNotice.parts[0].text,notice.text);return user;
}

async function documentWitness({executionHost,observations,directory,sessionID,file}){
 const rows=observations.filter(row=>row.sessionID===sessionID&&row.publicationPolicy==='interview-document'&&row.phase==='termination_verified');
 assert.ok(rows.length,'Interview document has no actual supervised process receipt');
 for(const row of rows){assert.match(row.callID,/^interview_document_/);assert.equal(row.receipt.terminated,true);assert.equal(row.receipt.confined,true);assert.equal(row.receipt.cancelled,false);assert.equal(row.receipt.exitCode,0);}
 assert.deepEqual(await executionHost.runtime.activeLeases({directory,sessionID}),[]);
 const outcomes=await executionHost.runtime.executionOutcomes({directory,sessionID,calls:rows.map(row=>({callID:row.callID,messageID:row.messageID}))});
 assert.equal(outcomes.length,rows.length);assert.ok(outcomes.every(row=>row.outcome==='finished'),'Interview contribution not durably published');
 for(const row of rows){const lease=await executionHost.runtime.leaseForCall({directory,sessionID,callID:row.callID});
  assert.equal(lease?.publicationPolicy,'interview-document');assert.equal(lease.scope.messageID,row.messageID);assert.equal(lease.state,'published');}
 const canonical=await fs.realpath(file);assert.ok(canonical.startsWith(directory+path.sep));assert.equal(canonical,file);
 assert.equal((await fs.lstat(file)).isSymbolicLink(),false);
 return {receiptCount:rows.length,documentSha256:sha256(await fs.readFile(file))};
}

/** Original interview marker→accepted context→owned state machine→Markdown
 * worker→existing same-origin UI. Stop covers a real blocked physical request;
 * it preserves the already published draft and forbids a completed response. */
export async function runCompiledSlimInterview({provider,client,runtimeOwner,directory,admitPrimary,onCase,waitFor,
 bridge,executionHost,observations,databasePath}){
 assert.equal(typeof bridge?.request,'function');assert.ok(executionHost?.runtime);assert.ok(Array.isArray(observations));
 assert.ok(path.isAbsolute(databasePath)&&databasePath.startsWith(repository+path.sep));
 const cases=[],idea='An isolated local specification with one verified question',summary='## Objective\nCompiled original interview specification';
 const reply='<interview_state>'+JSON.stringify({summary,questions:[{id:'local-owner',question:'Who uses this isolated tool?',options:['Engineers','Reviewers'],suggested:'Engineers'}]})+'</interview_state>';
 const session=await enrolledSession(client,directory,admitPrimary,'Compiled original interview');let requests=0;
 await provider.setResponder(request=>{
  assert.equal(++requests,1);assert.equal(request.body.model,model.modelID);
  const prompt=contentText(request.body.messages.filter(row=>row.role==='user').at(-1)?.content);
  assert.ok(prompt.includes('You are running an interview q&a session'));assert.ok(prompt.includes(`Initial idea: ${idea}`));
  assert.equal(prompt.includes('<omos-interview-command>'),false,'Private accepted marker was not transformed');
  return {items:[{type:'textDelta',text:reply}],reason:'stop'};
 });
 await client.prompts.command(session.id,{command:'interview',arguments:idea,agent:'orchestrator',model},{directory,timeoutMs:30000});
 const page=await waitFor(()=>client.sessions.messages(session.id,{}, {directory}),value=>value.records.some(row=>row.info.role==='assistant'
  &&row.info.time?.completed&&row.parts.some(part=>part.type==='text'&&part.text===reply))
  &&value.records.some(row=>row.parts.some(part=>part.type==='text'&&part.synthetic===true&&part.text.startsWith('⎔ Interview UI ready\n'))),
  'Compiled original interview did not complete with its original no-reply UI notification');
 const canonicalDb=resolveSqliteDriver().open(databasePath,{readonly:true});let canonical;
 try{
  const rows=canonicalDb.prepare('SELECT id,type,data FROM session_message WHERE session_id=? ORDER BY seq LIMIT 65').all(session.id);
  assert.ok(rows.length<=64&&Buffer.byteLength(JSON.stringify(rows))<=1024*1024,'Interview transcript exceeded its inspection bound');
  canonical=rows.map(row=>({...JSON.parse(row.data),id:row.id,type:row.type}));
 }finally{canonicalDb.close();}
 const user=assertCompiledInterviewUsers({records:page.records,canonical,sessionID:session.id,idea});
 assert.equal(requests,1,'Original no-reply UI notification must not trigger another physical model request');
 const active=await waitFor(()=>interviewState(bridge,directory,session.id),value=>value?.state.summary===summary
  &&value.state.questions[0]?.id==='local-owner','Original interview UI did not expose committed assistant state');
 assert.equal(active.state.questions[0].question,'Who uses this isolated tool?');
 const witness=await documentWitness({executionHost,observations,directory,sessionID:session.id,file:active.state.interview.markdownPath});
 const bytes=await fs.readFile(active.state.interview.markdownPath,'utf8');assert.ok(bytes.includes(summary));assert.ok(bytes.includes(`sessionID: ${session.id}`));
 const rendered=await bridge.request(directory,`/interview/${encodeURIComponent(active.id)}`);assert.equal(rendered.status,200);
 assert.ok((await rendered.text()).includes('/api/openchamber/interviews/'+sha256(directory)));
 const row={id:'compiled-active-interview',status:'passed',sessionID:session.id,userMessageID:user.info.id,interviewID:active.id,
  ...witness,source:'original-accepted-command-context-state-machine-supervised-markdown-and-owned-http-ui',personalProviderParity:false};
 onCase?.(row);cases.push(row);

 const cancelled=await enrolledSession(client,directory,admitPrimary,'Compiled original interview Stop');
 let calls=0,didStart=false,didAbort=false,dispatchFailure;
 await provider.setResponder((request,signal)=>{
  assert.equal(++calls,1);const prompt=contentText(request.body.messages.filter(row=>row.role==='user').at(-1)?.content);
  assert.ok(prompt.includes('Initial idea: Cancel this isolated interview'));didStart=true;
  return new Promise((resolve,reject)=>{
   const stop=()=>{didAbort=true;reject(signal.reason);};signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
  });
 });
 const dispatch=client.prompts.command(cancelled.id,{command:'interview',arguments:'Cancel this isolated interview',agent:'orchestrator',model},{directory,timeoutMs:30000});
 // Observe rejection immediately; callers never leave a rejected dispatch
 // promise unhandled while waiting for the real physical request.
 const dispatchResult=dispatch.then(()=>({ok:true}),cause=>{dispatchFailure=cause;return {ok:false,cause};});
 await waitFor(()=>{if(dispatchFailure)throw dispatchFailure;return didStart;},Boolean,'Original interview did not reach cancellable HTTP');
 const draft=await waitFor(()=>interviewState(bridge,directory,cancelled.id),Boolean,'Original interview did not create its owned draft');
 const before=await fs.readFile(draft.state.interview.markdownPath);
 const stopped=await runtimeOwner.stopSessions({sessions:[cancelled.id]});assert.equal(stopped.terminated,true);
 await waitFor(()=>didAbort,Boolean,'Stop did not abort original interview physical request');
 await dispatchResult;
 const db=resolveSqliteDriver().open(databasePath,{readonly:true});
 try{
  await waitFor(()=>db.prepare("SELECT data FROM session_message WHERE session_id=? AND type='idle' ORDER BY seq DESC LIMIT 1").get(cancelled.id),
   value=>value&&JSON.parse(value.data).outcome==='interrupted','Stop did not commit actual interrupted native idle');
  const state=db.prepare('SELECT idle_outcome,time_suspended,resume_attempts FROM session_v2 WHERE id=?').get(cancelled.id);
  assert.equal(state.idle_outcome,'interrupted');assert.equal(state.time_suspended,null);assert.equal(state.resume_attempts,0);
  const assistant=db.prepare("SELECT data FROM session_message WHERE session_id=? AND type='assistant' ORDER BY seq DESC LIMIT 1").get(cancelled.id);
  assert.ok(assistant);const data=JSON.parse(assistant.data);assert.equal(data.error?.type,'aborted');assert.ok(Number.isFinite(data.time?.completed));
 }finally{db.close();}
 const cancelledPage=await client.sessions.messages(cancelled.id,{}, {directory});
 assert.equal(cancelledPage.records.some(message=>message.info.role==='assistant'&&message.parts.some(part=>part.type==='text'&&part.text.includes('<interview_state>'))),false);
 assert.deepEqual(await fs.readFile(draft.state.interview.markdownPath),before,'Stop mutated the already published original draft');
 assert.deepEqual(await executionHost.runtime.activeLeases({directory,sessionID:cancelled.id}),[]);
 // setResponder awaits the real HTTP fixture work, so cancellation cannot
 // pass while its response writer or original responder remains outstanding.
 await provider.setResponder(()=>{throw Error('Unexpected post-Stop inference');});assert.equal(calls,1);
 const cancelledRow={id:'compiled-active-interview-cancel',status:'passed',sessionID:cancelled.id,documentSha256:sha256(before),
  source:'actual-original-interview-blocked-http-Stop-interrupted-native-idle-and-preserved-published-draft',personalProviderParity:false};
 onCase?.(cancelledRow);cases.push(cancelledRow);return cases;
}
