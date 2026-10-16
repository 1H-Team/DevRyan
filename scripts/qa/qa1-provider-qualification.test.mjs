import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { projectQa1ProviderJournal, readQa1ProviderJournal, gradeQa1SilenceSample, gradeQa1HelperSample,
  runQa1ProviderQualification, QA1_HIGH_PROMPTS } from './qa1-provider-qualification.mjs';
import { assertQa1ProviderIdle, waitQa1TitleSettlement, createQa1HighPrompt, assertQa1MediumSample } from './qa1-provider-qualification.mjs';
import { assertQaSubmittedPlanMode } from './submitted-turn.mjs';
import { createNativeProviderTiming } from '../../packages/web/server/lib/opencode/runtime-host/native-provider-timing.js';
import { createTurnTimingRuntime } from '../../packages/web/server/lib/opencode/turn-timing.js';
import { createDiagnosticSanitizer } from '../../packages/harness-runtime/lib/sanitizer.js';

const directory=path.resolve('.cache/qa/qualification-fixture/project'),sessionID='ses_qa1',messageID='msg_qa1';
const marker=`<WORKTREE_${createHash('sha256').update(directory).digest('hex').slice(0,12)}>`;
const common={schema:1,controllerInstanceID:'controller_1',configurationDigest:'a'.repeat(64),sessionID,directory:marker};
const execution={agent:'builder',providerID:'openai',modelID:'gpt-6-astra',variant:'high'};
const attempt={traceID:'trace_1',spanID:'span_1'};
const native=(stage,payload,at)=>({type:'lifecycle',event:'native_observation',sessionID,directory:marker,at,payload:{...common,stage,...payload}});
const sample={sessionID,messageID,variant:'high'};
const selection={sessionIDs:[sessionID],directory,since:0,until:20};
const body=()=>({type:'timing',mark:'turn.provider_body_end',sessionID,at:8,payload:{kind:'primary',transport:'http',requestID:'request_1',bytes:100,chunks:2,maxGapMs:45000}});
const summary=()=>({type:'timing',mark:'turn.summary',sessionID,messageID,directory:marker,at:10,
  payload:{assistantMessageID:'msg_assistant',bridge:{count:70,failedCount:0}}});
function source(){return [
  native('accepted-user',{messageID,fingerprint:'b'.repeat(64),intent:{source:'prompt',variantPresent:true,variant:'high',agent:'builder',model:{providerID:'openai',modelID:'gpt-6-astra'}},execution},1),
  native('model-prepared',{requestID:'request_1',kind:'primary',execution,options:{reasoningEffort:'high'},hookOptions:{},modelLimits:{context:1000,input:900,output:100}},2),
  native('physical',{requestID:'request_1',kind:'primary',transport:'http',wireOptions:{reasoning:{effort:'high'}},ordinal:1,attempt},3),
  native('step-link',{eventID:'event_1',sequence:1,created:4,assistantMessageID:'msg_assistant',userMessageID:messageID,execution,attempt},4),body(),
].map(row=>structuredClone(row));}
const project=rows=>projectQa1ProviderJournal(rows,selection);

test('exact accepted source, attempt, effort and HTTP body witness grade measured gap without changing 300 seconds',()=>{
  const result=gradeQa1SilenceSample(project(source()),sample);
  assert.equal(result.status,'qualified');assert.equal(result.maxGapMs,45000);assert.equal(result.productTimeoutSeconds,300);
  assert.equal(result.requests.length,1);
  const medium=source();for(const row of medium){if(row.payload.execution)row.payload.execution.variant='medium';
    if(row.payload.intent)row.payload.intent.variant='medium';if(row.payload.options)row.payload.options.reasoningEffort='medium';
    if(row.payload.wireOptions)row.payload.wireOptions.reasoning.effort='medium';}
  assert.equal(gradeQa1SilenceSample(project(medium),{...sample,variant:'medium'}).status,'qualified');
});

test('missing, mismatched, websocket, duplicate attempts, wide gaps and partial journals never qualify',()=>{
  const changes=[rows=>rows.splice(0,1),rows=>rows.splice(1,1),rows=>rows.splice(2,1),rows=>rows.splice(3,1),rows=>rows.pop(),
    rows=>rows[3].payload.userMessageID='msg_foreign',rows=>rows[3].payload.attempt.spanID='span_foreign',
    rows=>rows[0].payload.execution.variant='medium',rows=>delete rows[0].payload.execution,
    rows=>rows[2].payload.transport='ws',rows=>rows[2].payload.wireOptions.reasoning.effort='medium',
    rows=>rows[1].payload.execution.modelID='wrong',rows=>rows[2].payload.configurationDigest='c'.repeat(64),
    rows=>rows[4].payload.maxGapMs=60001,rows=>rows[4].payload.bytes=0,rows=>rows.push(structuredClone(rows[2])),rows=>rows.push(body()),
    rows=>rows.push({type:'gap',at:0,sessionID:'foreign',reason:'private gap prose'}),
  ];
  for(const [index,change] of changes.entries()){const rows=source();change(rows);assert.equal(gradeQa1SilenceSample(project(rows),sample).status,'unqualified',`negative case ${index}`);}
  assert.equal(gradeQa1SilenceSample({...project(source()),complete:false},sample).status,'unqualified');
});

test('private journal projection emits no raw title, body, auth, directory, fingerprint or configuration hashes',()=>{
  const rows=source();rows[4].payload.text='PRIVATE_BODY';rows[4].payload.headers='PRIVATE_AUTH';
  rows[1].payload.execution.modelID='PRIVATE_MODEL';rows[1].payload.execution.providerID='PRIVATE_ACCOUNT';
  rows.push({type:'lifecycle',event:'session_title_generation',sessionID,at:9,payload:{stage:'session_model',outcome:'complete',providerID:'opencode',modelID:'deepseek-v4.1-flash',title:'PRIVATE_TITLE',hash:'PRIVATE_HASH'}});
  rows.push({type:'log',event:'provider',sessionID,at:10,payload:{body:'PRIVATE_BODY',auth:'PRIVATE_AUTH'}});
  const result=project(rows),text=JSON.stringify(result);
  assert.doesNotMatch(text,/PRIVATE_|WORKTREE|fingerprint|configurationDigest|a{64}|b{64}|directory/);
  assert.equal(result.records.find(row=>row.type==='title').outcome,'complete');
  const malformed=source();malformed[1].directory='<WORKTREE_aaaaaaaaaaaa>';
  assert.throws(()=>project(malformed),/qa_provider_journal_scope_invalid/);
});

test('receipt opt-in projects scoped finite turn summaries without private fields or hidden duplicates',()=>{
  const row=summary();Object.assign(row.payload,{title:'PRIVATE_TITLE',text:'PRIVATE_BODY',model:{name:'PRIVATE_MODEL'}});
  row.payload.bridge.methods=[{method:'PRIVATE_METHOD',count:70}];
  assert.deepEqual(project([row]).records,[],'Default projection remains unchanged');
  const enabled=rows=>projectQa1ProviderJournal(rows,{...selection,receiptSettlement:true});
  const expected={type:'turn-summary',at:10,sessionID,messageID,assistantMessageID:'msg_assistant',bridge:{count:70,failedCount:0}};
  assert.deepEqual(enabled([row]).records,[expected]);
  assert.doesNotMatch(JSON.stringify(enabled([row])),/PRIVATE_|WORKTREE|directory|methods|model/);
  const absentDirectory=summary();delete absentDirectory.directory;
  assert.deepEqual(enabled([absentDirectory]).records,[expected]);
  const conflicting=summary();conflicting.payload.assistantMessageID='msg_other_assistant';
  assert.deepEqual(enabled([row,conflicting]).records,[expected,{...expected,assistantMessageID:'msg_other_assistant'}],
    'Exact-user uniqueness must remain visible to the consumer before matching the final assistant');
  const foreign={...summary(),sessionID:'ses_foreign',payload:null};
  const outsideWindow={...summary(),at:21,payload:null};
  assert.deepEqual(enabled([foreign,outsideWindow,row]).records,[expected]);
});

test('receipt opt-in explicitly refuses applicable malformed turn summaries and wrong directory markers',()=>{
  const changes=[row=>row.messageID='',row=>delete row.messageID,row=>row.payload=null,row=>row.payload=[],
    row=>row.payload.assistantMessageID='PRIVATE invalid ID',row=>delete row.payload.assistantMessageID,
    row=>row.payload.bridge=null,row=>row.payload.bridge=[],row=>row.payload.bridge.count=-1,
    row=>row.payload.bridge.count=0.5,row=>row.payload.bridge.count=Infinity,row=>row.payload.bridge.count=Number.MAX_SAFE_INTEGER+1,
    row=>row.payload.bridge.failedCount=-1,row=>row.payload.bridge.failedCount=0.5,row=>row.payload.bridge.failedCount=Infinity,
    row=>row.payload.bridge.failedCount=71,row=>row.at=NaN,row=>row.at=0.5];
  for(const change of changes){const row=summary();change(row);
    assert.throws(()=>projectQa1ProviderJournal([summary(),row],{...selection,receiptSettlement:true}),/qa_provider_turn_summary_invalid/,String(change));
    assert.deepEqual(project([row]).records,[],'Opt-out never starts projecting or validating summaries');
  }
  for(const directory of [null,'/private/wrong','<WORKTREE_aaaaaaaaaaaa>'])assert.throws(
    ()=>projectQa1ProviderJournal([{...summary(),directory}],{...selection,receiptSettlement:true}),/qa_provider_journal_scope_invalid/);
});

test('actual settled turn producer and sanitizer preserve the lean original-user bridge summary',()=>{
  let now=1;const rows=[],sanitizer=createDiagnosticSanitizer();
  const turns=createTurnTimingRuntime({now:()=>now,onTurnSettled:entry=>rows.push(sanitizer.sanitizeRecord({
    type:'timing',mark:`turn.${entry.mark}`,at:entry.at,sessionID:entry.sessionId,messageID:entry.userMessageId,
    directory:entry.directory,payload:entry.payload}))});
  turns.recordClientMark({sessionId:sessionID,messageId:messageID,mark:'send_started',directory});
  turns.recordClientMark({sessionId:sessionID,messageId:messageID,mark:'prompt_accepted',directory});
  turns.recordBridgeCall({sessionId:sessionID,method:'PRIVATE_METHOD',durationMs:1,statusCode:200});
  turns.recordBridgeCall({sessionId:sessionID,method:'PRIVATE_METHOD',durationMs:1,statusCode:503});
  turns.processOpenCodeEvent({type:'message.updated',properties:{info:{id:'msg_assistant',sessionID,role:'assistant',parentID:messageID,time:{created:2}}}});
  now=10;turns.processOpenCodeEvent({type:'session.status',properties:{sessionID,status:{type:'idle'}}});
  assert.equal(rows.length,1);assert.equal(rows[0].directory,marker);
  assert.deepEqual(projectQa1ProviderJournal(rows,{...selection,receiptSettlement:true}).records,[{
    type:'turn-summary',at:10,sessionID,messageID,assistantMessageID:'msg_assistant',bridge:{count:2,failedCount:1}}]);
});

test('helper physical tuple/default options are observed but missing tools/revision remain an honest gap',()=>{
  const helper={providerID:'opencode',modelID:'deepseek-v4.1-flash',revision:'4f460d83-389a-42a5-93cb-23cd7c5dbd64'};
  const rows=[native('model-prepared',{requestID:'helper_request',kind:'generate',execution:{agent:'devryan-commit',providerID:helper.providerID,modelID:helper.modelID,variant:null},options:{},hookOptions:{},modelLimits:{context:1000,input:null,output:100}},1),
    native('physical',{requestID:'helper_request',kind:'generate',transport:'http',wireOptions:{},ordinal:1,attempt:null},2)];
  const result=gradeQa1HelperSample(project(rows),{sessionID,agent:'devryan-commit',helper});
  assert.equal(result.status,'unqualified');assert.equal(result.reason,'helper-tools-or-revision-unconfirmed');
  assert.equal(result.modelAndDefaultReasoningObserved,true);assert.equal(result.selectionRevision,helper.revision);
  for(const row of rows)Object.assign(row.payload,{toolCount:0,helperSelectionMode:'configured',helperSelectionRevision:helper.revision});
  rows[1].payload.wireToolCount=0;
  assert.equal(gradeQa1HelperSample(project(rows),{sessionID,agent:'devryan-commit',helper}).status,'qualified');
  const fallbackRevision={...helper,revision:'helper_4f460d83-389a-42a5-93cb-23cd7c5dbd64'};
  for(const row of rows)row.payload.helperSelectionRevision=fallbackRevision.revision;
  assert.equal(gradeQa1HelperSample(project(rows),{sessionID,agent:'devryan-commit',helper:fallbackRevision}).status,'qualified');
  for(const [index,extra] of [[0,{toolCount:1}],[1,{wireToolCount:1}],[1,{wireToolCount:null}],[1,{helperSelectionRevision:'default'}],[1,{helperSelectionMode:'active'}]]){
    const changed=structuredClone(rows);Object.assign(changed[index].payload,extra);assert.equal(gradeQa1HelperSample(project(changed),{sessionID,agent:'devryan-commit',helper:fallbackRevision}).status,'unqualified');
  }
  const active=structuredClone(rows);active[0].payload.helperSelectionMode='active';active[0].payload.helperSelectionRevision='active-session';active[0].payload.execution.modelID='gpt-6-astra';
  assert.equal(gradeQa1HelperSample(project(active),{sessionID,agent:'devryan-commit',helper:fallbackRevision}).reason,'helper-active-fallback');
  rows[0].payload.execution.variant='high';assert.equal(gradeQa1HelperSample(project(rows),{sessionID,agent:'devryan-commit',helper}).modelAndDefaultReasoningObserved,false);
});

test('ordinary naming requires model settlement and persisted source, never a derived title',()=>{
  const helper={providerID:'opencode',modelID:'deepseek-v4.1-flash',revision:'default'};
  const rows=[native('model-prepared',{requestID:'title_request',kind:'generate',execution:{agent:'devryan-title',providerID:helper.providerID,modelID:helper.modelID,variant:null},options:{},hookOptions:{},modelLimits:{context:1000,input:null,output:100}},1),
    native('physical',{requestID:'title_request',kind:'generate',transport:'http',wireOptions:{},ordinal:1,attempt:null},2),
    {type:'lifecycle',event:'session_title_generation',sessionID,at:3,payload:{stage:'session_model',outcome:'complete',providerID:helper.providerID,modelID:helper.modelID}},
    {type:'lifecycle',event:'session_title_generation',sessionID,at:4,payload:{stage:'persistence',outcome:'complete',source:'session_model',sourceMessageID:messageID}}];
  const input={sessionID,agent:'devryan-title',helper,sourceMessageID:messageID};
  assert.equal(gradeQa1HelperSample(project(rows),input).namingObserved,true);
  rows[3].payload.stage='projection';assert.equal(gradeQa1HelperSample(project(rows),input).namingObserved,false);
  rows[3].payload.stage='persistence';
  const failed=structuredClone(rows[3]);failed.payload.outcome='failed';rows.splice(3,0,failed);
  assert.equal(gradeQa1HelperSample(project(rows),input).namingObserved,true,'recovered persistence attempt');
  rows.push(structuredClone(rows.at(-1)));assert.equal(gradeQa1HelperSample(project(rows),input).namingObserved,false,'ambiguous persistence completion');
  rows.pop();rows.at(-1).payload.sourceMessageID='msg_foreign';assert.equal(gradeQa1HelperSample(project(rows),input).namingObserved,false);
  rows.at(-1).payload.sourceMessageID=messageID;rows.at(-1).payload.source='derived';assert.equal(gradeQa1HelperSample(project(rows),input).namingObserved,false);
});

test('helper grading accounts for every send, allows retries and excludes only attributable other helpers',()=>{
  const helper={providerID:'opencode',modelID:'deepseek-v4.1-flash',revision:'default'};
  const input={sessionID,agent:'devryan-commit',helper};
  const rows=[native('model-prepared',{requestID:'helper_request',kind:'generate',execution:{agent:input.agent,providerID:helper.providerID,modelID:helper.modelID,variant:null},options:{},hookOptions:{},modelLimits:{context:1000,input:null,output:100},toolCount:0,helperSelectionMode:'configured',helperSelectionRevision:'default'},1),
    native('physical',{requestID:'helper_request',kind:'generate',transport:'http',wireOptions:{},ordinal:1,attempt:null,toolCount:0,wireToolCount:0,helperSelectionMode:'configured',helperSelectionRevision:'default'},2)];
  const grade=values=>gradeQa1HelperSample(project(values),input);
  assert.equal(grade(rows).status,'qualified');
  const retry=structuredClone(rows[1]);retry.payload.ordinal=2;
  assert.equal(grade([...rows,retry]).requests.length,2);
  for(const change of [extra=>extra.payload.execution.variant='high',extra=>extra.payload.options={reasoningEffort:'high'},extra=>extra.payload.requestID='orphan']){
    const extra=structuredClone(rows[0]);change(extra);assert.equal(grade([...rows,extra]).status,'unqualified');
  }
  for(const extra of [structuredClone(rows[0]),structuredClone(rows[1]),{...structuredClone(rows[1]),payload:{...rows[1].payload,requestID:'orphan'}}])assert.equal(grade([...rows,extra]).status,'unqualified');
  const badRetry=structuredClone(retry);badRetry.payload.wireOptions={reasoning:{effort:'high'}};
  assert.equal(grade([...rows,badRetry]).status,'unqualified');
  const other=structuredClone(rows);other[0].payload.execution.agent='devryan-pr';
  for(const row of other)row.payload.requestID='other_request';
  assert.equal(grade([...rows,...other]).status,'qualified');
});

test('silence grading rejects hidden wrong-effort steps and orphan requests while retaining known Implement traffic',()=>{
  const rows=source(),wrong=structuredClone(rows[3]);wrong.payload.execution.variant='medium';wrong.payload.attempt={traceID:'trace_wrong',spanID:'span_wrong'};
  assert.equal(gradeQa1SilenceSample(project([...rows,wrong]),sample).status,'unqualified');
  const orphan=structuredClone(rows[2]);orphan.payload.requestID='orphan';orphan.payload.attempt={traceID:'trace_orphan',spanID:'span_orphan'};orphan.payload.transport='ws';
  assert.equal(gradeQa1SilenceSample(project([...rows,orphan]),sample).reason,'physical-step-scope');
  const nextSend=structuredClone(rows[2]),nextStep=structuredClone(rows[3]);
  for(const row of [nextSend,nextStep])row.payload.attempt={traceID:'trace_next',spanID:'span_next'};
  nextStep.payload.assistantMessageID='msg_next_assistant';
  assert.equal(gradeQa1SilenceSample(project([...rows,nextSend,nextStep]),sample).reason,'body-end');
  const implement=source();for(const row of implement){
    if(row.payload.messageID)row.payload.messageID='msg_implement';if(row.payload.userMessageID)row.payload.userMessageID='msg_implement';
    if(row.payload.requestID)row.payload.requestID='request_implement';if(row.payload.attempt)row.payload.attempt={traceID:'trace_implement',spanID:'span_implement'};
  }
  assert.equal(gradeQa1SilenceSample(project([...rows,...implement]),sample).status,'qualified');
  implement.splice(0,1);assert.equal(gradeQa1SilenceSample(project([...rows,...implement]),sample).status,'unqualified');
});

test('reader refuses incomplete/malformed/gapped/symlink journals and unflushed status in a disposable private fixture',async t=>{
  const root=await fs.mkdtemp(path.resolve('.cache/qa/qa1-journal-contract-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const journal=path.join(root,'harness/journal');await fs.mkdir(path.join(journal,'runtime'),{recursive:true,mode:0o700});
  await fs.mkdir(path.join(journal,'sessions',sessionID),{recursive:true,mode:0o700});
  const file=path.join(journal,'sessions',sessionID,'000001.ndjson.open');
  const input={runtimeRoot:root,journalDirectory:journal,coverage:{enabled:true,gapRecords:0,queuedRecords:0,lastError:false},...selection};
  await fs.writeFile(file,[...source(),summary()].map(row=>JSON.stringify(row)).join('\n')+'\n');
  assert.equal((await readQa1ProviderJournal(input)).records.length,5);
  assert.equal((await readQa1ProviderJournal({...input,receiptSettlement:true})).records.filter(row=>row.type==='turn-summary').length,1);
  await assert.rejects(readQa1ProviderJournal({...input,coverage:{...input.coverage,queuedRecords:1}}),/status_invalid/);
  await fs.appendFile(file,'{"incomplete"');await assert.rejects(readQa1ProviderJournal(input),/incomplete/);
  await fs.writeFile(file,'bad\n');await assert.rejects(readQa1ProviderJournal(input),/malformed/);
  await fs.writeFile(file,JSON.stringify({type:'gap'})+'\n');assert.equal((await readQa1ProviderJournal(input)).gapCount,1);
  await fs.unlink(file);await fs.symlink(path.join(root,'missing'),file);await assert.rejects(readQa1ProviderJournal(input),/path_invalid/);
});

test('no manual admission or invalid full gate does no API/fixture/paid work',async()=>{
  let calls=0;const api=async()=>{calls++;};
  await assert.rejects(runQa1ProviderQualification({api,admitted:()=>false}),/qa_profile_manual_admission_required/);
  await assert.rejects(runQa1ProviderQualification({api,admitted:()=>true}),/qa_provider_original_medium_unavailable/);
  const mediumSample={...sample,variant:'medium',providerID:'openai',modelID:'gpt-6-astra',canonicalSelectionVerified:true,directory,since:0,until:20};
  assertQa1MediumSample(mediumSample);
  for(const extra of [{variant:'high'},{messageID:null},{until:-1},{canonicalSelectionVerified:false}])assert.throws(()=>assertQa1MediumSample({...mediumSample,...extra}),/original_medium_unavailable/);
  await assert.rejects(runQa1ProviderQualification({api,admitted:()=>true,mediumSample,qualificationReport:'/outside/result.json'}),/qa_profile_native_qualification_required/);
  assert.equal(calls,0);assert.equal(QA1_HIGH_PROMPTS.length,3);
  for(const prompt of QA1_HIGH_PROMPTS){assert.match(prompt,/Read /);assert.match(prompt,/Do not edit/);assert.ok(prompt.length<500);}
});

test('fresh idle guard refuses newly active or invalid sessions before every paid dispatch',()=>{
  assertQa1ProviderIdle({});assertQa1ProviderIdle({ses_owned:{type:'idle'}});
  for(const status of [null,[],{ses_new:{type:'busy'}},{ses_new:{type:'retry'}},{ses_new:{type:'unknown'}},{ses_new:null}]){
    assert.throws(()=>assertQa1ProviderIdle(status),/qa_profile_runtime_not_idle/);
  }
});

test('all frozen High inspection inputs carry canonical Plan admission and synthetic original instruction',()=>{
  for(const prompt of QA1_HIGH_PROMPTS){const body=createQa1HighPrompt(messageID,prompt);
    assert.equal(body.planMode,true);assert.equal(body.variant,'high');assert.deepEqual(body.model,{providerID:'openai',modelID:'gpt-6-astra'});
    assert.equal(assertQaSubmittedPlanMode(body,true),true);
    assert.throws(()=>assertQaSubmittedPlanMode({...body,parts:[body.parts[1]]},true),/Canonical submission/);
  }
  assert.throws(()=>createQa1HighPrompt(messageID,'Unreviewed task'),/qa_provider_sample_invalid/);
});

test('bounded ordinary title wait observes asynchronous persistence and exits on failure, pause, deadline or cancellation',async()=>{
  let now=0,calls=0;const signal=new AbortController().signal;
  const completed={complete:true,gapCount:0,records:[{type:'title',sessionID,stage:'session_model',outcome:'complete'},
    {type:'title',sessionID,sourceMessageID:messageID,stage:'persistence',outcome:'complete',source:'session_model'}]};
  const result=await waitQa1TitleSettlement({sessionID,sourceMessageID:messageID,signal,deadline:30000,now:()=>now,pause:async ms=>{now+=ms;},
    read:async()=>{calls++;return calls===3?completed:{complete:true,gapCount:0,records:[]};}});
  assert.equal(result,completed);assert.equal(calls,3);
  calls=0;await waitQa1TitleSettlement({sessionID,sourceMessageID:messageID,signal,deadline:30000,read:async()=>{calls++;return {complete:true,gapCount:0,records:[{type:'title',sessionID,sourceMessageID:messageID,stage:'persistence',outcome:'paused'}]};}});assert.equal(calls,1);
  for(const stage of ['session_read','status_read','pre_patch_read','post_generation_read','verification','idle_confirmation']){
    const journal=project([{type:'lifecycle',event:'session_title_generation',at:selection.since,sessionID,payload:{stage,outcome:'paused',sourceMessageID:messageID}}]);
    assert.equal(journal.records.length,1);calls=0;
    await waitQa1TitleSettlement({sessionID,sourceMessageID:messageID,signal,deadline:30000,read:async()=>{calls++;return journal;}});assert.equal(calls,1);
  }
  now=0;calls=0;await waitQa1TitleSettlement({sessionID,sourceMessageID:messageID,signal,deadline:30000,now:()=>now,pause:async ms=>{now+=ms;},
    read:async()=>{calls++;return calls===2?completed:{complete:true,gapCount:0,records:[{type:'title',sessionID,sourceMessageID:messageID,stage:'persistence',outcome:'failed'}]};}});assert.equal(calls,2);
  now=0;calls=0;await waitQa1TitleSettlement({sessionID,sourceMessageID:messageID,signal,deadline:2000,now:()=>now,pause:async ms=>{now+=ms;},
    read:async()=>{calls++;return {complete:true,gapCount:0,records:[{type:'title',sessionID,sourceMessageID:messageID,stage:'projection',outcome:'complete',source:'session_model'}]};}});assert.equal(calls,3);
  now=0;calls=0;await waitQa1TitleSettlement({sessionID,signal,deadline:2000,now:()=>now,pause:async ms=>{now+=ms;},read:async()=>{calls++;return {complete:true,gapCount:0,records:[]};}});assert.equal(calls,3);
  const cancelled=new AbortController();cancelled.abort(new Error('cancelled'));
  await assert.rejects(waitQa1TitleSettlement({sessionID,signal:cancelled.signal,deadline:30000,read:async()=>{throw new Error('must not read');}}),/cancelled/);
});

test('actual native provider and turn-timing producers preserve primary kind, HTTP transport and body counters at journal boundary',()=>{
  let now=0;const marks=[];
  const turns=createTurnTimingRuntime({now:()=>now,onTurnMark:entry=>marks.push({type:'timing',mark:`turn.${entry.mark}`,sessionID:entry.sessionId,at:entry.at,payload:entry.payload})});
  turns.recordClientMark({sessionId:sessionID,messageId:messageID,mark:'send_started'});
  const provider=createNativeProviderTiming({now:()=>now,onMark:entry=>turns.recordSessionMark(entry)});
  provider.observe({sessionID,requestID:'request_1',kind:'primary',stage:'model-prepared'});
  now=2;provider.observe({sessionID,requestID:'request_1',kind:'primary',stage:'physical',transport:'http',attempt});
  now=8;provider.response({controllerInstanceID:'controller_1',sessionID,requestID:'request_1',kind:'primary',transport:'http',event:'body-end',statusCode:200,body:{bytes:100,chunks:2,maxGapMs:45000}});
  const end=marks.find(row=>row.mark==='turn.provider_body_end');
  assert.equal(end.payload.kind,'primary');assert.equal(end.payload.transport,'http');assert.equal(end.payload.requestID,'request_1');
  const rows=source();rows[4]=end;assert.equal(gradeQa1SilenceSample(project(rows),sample).status,'qualified',JSON.stringify(end));
});

 test('GPT6 effective effort uses finite ordered update evidence without manufacturing top-level wire effort',()=>{
 const rows=source();rows[2].payload.wireOptions={reasoning:{summary:'detailed'}};
 rows[2].payload.wireEffortUpdates={count:2,effort:'high'};
 const projected=project(rows);const send=projected.records.find(row=>row.stage==='physical');
 assert.equal(send.wireEffort,null);assert.equal(send.wireEffectiveEffort,'high');assert.equal(send.wireEffortSource,'configuration-update');
 assert.deepEqual(gradeQa1SilenceSample(projected,sample).requests[0].effortEvidence,{source:'configuration-update',topLevel:null,configurationUpdateCount:2,effective:'high'});
 assert.equal(gradeQa1SilenceSample(projected,sample).status,'qualified');
 const frozenBase=structuredClone(rows);frozenBase[2].payload.wireOptions={reasoning:{effort:'low'}};
 assert.equal(gradeQa1SilenceSample(project(frozenBase),sample).status,'qualified','Valid earlier top-level base differs from the later ordered update');
 for(const change of [value=>value.wireEffortUpdates=null,value=>value.wireEffortUpdates.effort='medium',value=>value.wireOptions={reasoningEffort:'high',reasoning:{effort:'medium'}}]){
 const changed=structuredClone(rows);change(changed[2].payload);assert.equal(gradeQa1SilenceSample(project(changed),sample).reason,'effective-effort');}
 delete rows[2].payload.wireEffortUpdates;assert.equal(gradeQa1SilenceSample(project(rows),sample).reason,'effective-effort');
 });
 test('Default helper cannot qualify when configuration-update evidence overrides empty top-level controls',()=>{
 const helper={providerID:'opencode',modelID:'deepseek-v4.1-flash',revision:'default'},agent='devryan-commit';
 const rows=[native('model-prepared',{requestID:'helper_request',kind:'generate',execution:{agent,providerID:helper.providerID,modelID:helper.modelID,variant:null},options:{},hookOptions:{},modelLimits:{context:1000,input:null,output:100},toolCount:0,helperSelectionMode:'configured',helperSelectionRevision:'default'},1),
 native('physical',{requestID:'helper_request',kind:'generate',transport:'http',wireOptions:{},ordinal:1,attempt:null,toolCount:0,wireToolCount:0,helperSelectionMode:'configured',helperSelectionRevision:'default'},2)];
 for(const update of [null,{count:1,effort:'high'}]){rows[1].payload.wireEffortUpdates=update;assert.equal(gradeQa1HelperSample(project(rows),{sessionID,agent,helper}).reason,'helper-physical-default-reasoning');}
 });

 test('actual sanitizer preserves only strict finite update evidence through journal projection',()=>{
 const sanitizer=createDiagnosticSanitizer(),raw=source()[2];raw.directory=directory;raw.payload.directory=directory;
 raw.payload.wireOptions={reasoning:{summary:'detailed'}};raw.payload.wireEffortUpdates={count:1,effort:'medium'};
 const sanitized=sanitizer.sanitizeRecord(raw);
 assert.deepEqual(sanitized.payload.wireOptions,{reasoning:{summary:'detailed'}});
 assert.deepEqual(sanitized.payload.wireEffortUpdates,{count:1,effort:'medium'});
 assert.equal(project([sanitized]).records[0].wireEffectiveEffort,'medium');
 raw.payload.wireEffortUpdates={count:1,effort:'high',input:'PRIVATE_BODY'};
 assert.throws(()=>sanitizer.sanitizeRecord(raw),/native_observation_invalid/);
 });
