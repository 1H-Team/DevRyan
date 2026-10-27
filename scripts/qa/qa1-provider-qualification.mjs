import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { collectJournalPaths } from '../journal.mjs';
import { parseNativeJournalObservation } from '../../packages/shared-runtime/lib/native-observation.js';
import { DEFAULT_HELPER_MODEL_SELECTION, parseHelperModelSelection } from '../../packages/shared-runtime/lib/helper-model-selection.js';
import { createV2MessageId } from '../../packages/web/server/lib/opencode/v2/admission.js';
import { readQa1NativeQualification, gradeQa1ProfileFiles } from './qa1-profile-exercise.mjs';
import { createQaProfileProjectFixture, finishQaProfileProjectFixture } from './profile-project-fixture.mjs';
import { cleanupQaSessionTree } from './live-task-evidence.mjs';
import { findQaCompletedTurnAssistant, assertQaSubmittedPlanMode } from './submitted-turn.mjs';
import { loadPlanModeInstruction } from '../agent-evals/plan-mode.mjs';
import { projectReceiptSettlementDiagnostic } from '../perf/receipt-ui-settlement.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const fail = code => Object.assign(new Error(code), { code });
const id = value => typeof value === 'string' && /^[A-Za-z0-9_:/.-]{1,256}$/.test(value);
const number = value => Number.isSafeInteger(value) && value >= 0;
const digest = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeExecution = value => ({
  agent:['builder','build','orchestrator','devryan-title','devryan-commit','devryan-pr'].includes(value.agent)?value.agent:'unsupported',
  providerID:['openai','opencode'].includes(value.providerID)?value.providerID:'unsupported',
  modelID:['gpt-6-astra','deepseek-v4.1-flash'].includes(value.modelID)?value.modelID:'unsupported',
  variant:value.variant===null?null:['low','medium','high','xhigh','max','ultra'].includes(value.variant)?value.variant:'unsupported',
});
const MAX_BYTES = 64 * 1024 * 1024, MAX_RECORDS = 100000, MAX_PROJECTED = 4096;
const safeCode = error => /^qa_[a-z0-9_]{1,100}$/.test(error?.code ?? '') ? error.code : 'qa_provider_qualification_failed';
const effort = options => {
  const values = [options?.reasoningEffort, options?.reasoning_effort, options?.effort, options?.reasoning?.effort].filter(value => value !== undefined);
  return values.length && values.every(value => value === values[0]) && ['none','minimal','low','medium','high','xhigh','max','ultra'].includes(values[0]) ? values[0] : null;
};
export const QA1_HIGH_PROMPTS = Object.freeze([
  'Read README.md and src/profile-appearance.mjs. Explain the signed-out viewport defect and one regression that would detect it. Do not edit files, run commands, delegate, or access network. Keep the answer under 200 words.',
  'Read src/profile-appearance.mjs and test/profile.test.mjs. Compare the dark qualification tokens with the professional-license reference and explain the shared public/editor regression risk. Do not edit, execute, delegate, or access network. Keep the answer under 200 words.',
  'Read public/app.js and src/profile-appearance.mjs. Reason about scroll and visual viewport events and identify the smallest shared fix for the sticky header and chat position. Do not edit, execute, delegate, or access network. Keep the answer under 200 words.',
]);
export function createQa1HighPrompt(messageID,prompt){
  if(!id(messageID)||!QA1_HIGH_PROMPTS.includes(prompt))throw fail('qa_provider_sample_invalid');
  return {messageID,agent:'builder',model:{providerID:'openai',modelID:'gpt-6-astra'},variant:'high',planMode:true,
    parts:[{type:'text',text:loadPlanModeInstruction(),synthetic:true},{type:'text',text:prompt}]};
}

/** Private raw records terminate here. No titles, content, paths or hashes leave. */
export function projectQa1ProviderJournal(records, { sessionIDs, directory, since, until, complete = true, receiptSettlement = false }) {
  if (!Array.isArray(records) || records.length > MAX_RECORDS || !Array.isArray(sessionIDs) || !sessionIDs.length || sessionIDs.length > 100
    || sessionIDs.some(value => !id(value)) || typeof directory !== 'string' || !path.isAbsolute(directory)
    || !number(since) || !number(until) || until < since) throw fail('qa_provider_journal_input_invalid');
  const selected = new Set(sessionIDs), directoryMarker = `<WORKTREE_${digest(path.resolve(directory)).slice(0,12)}>`;
  const scopes = new Map(), output = []; let gapCount = 0;
  for (const row of records) {
    // Gap verification is deliberately global: a gap cannot be made irrelevant
    // by an untrusted session/timestamp on the missing record.
    if (row?.type === 'gap' || row?.event === 'native_observation_gap') { gapCount++; continue; }
    const turnSummary=receiptSettlement===true&&row?.type==='timing'&&row.mark==='turn.summary'&&selected.has(row.sessionID);
    if(turnSummary&&!number(row.at))throw fail('qa_provider_turn_summary_invalid');
    if (!number(row?.at) || row.at < since || row.at > until || !selected.has(row.sessionID)) continue;
    if (row.type === 'lifecycle' && row.event === 'native_observation') {
      const value = parseNativeJournalObservation(row.payload);
      if (row.sessionID !== value.sessionID || row.directory !== value.directory || value.directory !== directoryMarker) throw fail('qa_provider_journal_scope_invalid');
      if (!['accepted-user','model-prepared','physical','step-link'].includes(value.stage)) continue;
      const key = `${value.controllerInstanceID}\0${value.configurationDigest}\0${value.directory}`;
      if (!scopes.has(key)) scopes.set(key, scopes.size + 1);
      const projected = { type:'native', at:row.at, scopeID:scopes.get(key), sessionID:value.sessionID, stage:value.stage };
      for (const key of ['requestID','kind','transport','messageID','userMessageID','assistantMessageID','ordinal']) if (Object.hasOwn(value,key)) projected[key] = value[key];
      if (value.execution) projected.execution = safeExecution(value.execution);
      if (value.attempt) projected.attempt = value.attempt;
      if (value.stage === 'model-prepared') Object.assign(projected,{ reasoningOptionsEmpty:Object.keys(value.options).length===0,
        hookReasoningOptionsEmpty:Object.keys(value.hookOptions).length===0, effectiveEffort:effort(value.options), hookEffort:effort(value.hookOptions) });
      if (value.stage === 'physical') {
        const wireEffort=effort(value.wireOptions),updatesPresent=Object.hasOwn(value,'wireEffortUpdates');
        const aliases=[value.wireOptions?.reasoningEffort,value.wireOptions?.reasoning_effort,value.wireOptions?.effort,value.wireOptions?.reasoning?.effort].filter(item=>item!==undefined);
        const valid=value.wireOptions!==null&&(!aliases.length||wireEffort!==null)&&(!updatesPresent||value.wireEffortUpdates!==null);
        Object.assign(projected,{wireReasoningOptionsPresent:value.wireOptions!==null,
          wireReasoningOptionsEmpty:value.wireOptions!==null&&Object.keys(value.wireOptions).length===0,wireEffort,
          wireEffortUpdatesPresent:updatesPresent,wireEffortUpdateCount:value.wireEffortUpdates?.count??null,wireEffectiveEffort:valid?(value.wireEffortUpdates?.effort??wireEffort):null,
          wireEffortSource:valid?(updatesPresent?'configuration-update':wireEffort===null?null:'top-level'):null});
      }
      if(number(value.toolCount))projected.toolCount=value.toolCount;
      if(Object.hasOwn(value,'wireToolCount'))projected.wireToolCount=value.wireToolCount;
      if(['configured','active'].includes(value.helperSelectionMode)&&parseHelperModelSelection({providerID:DEFAULT_HELPER_MODEL_SELECTION.providerID,
        modelID:DEFAULT_HELPER_MODEL_SELECTION.modelID,revision:value.helperSelectionRevision})){
        projected.helperSelectionMode=value.helperSelectionMode;projected.helperSelectionRevision=value.helperSelectionRevision;
      }
      output.push(projected);
    } else if (receiptSettlement === true && row.type === 'lifecycle' && row.event === 'session_execution') {
      const projected = projectReceiptSettlementDiagnostic(row);
      if (projected) output.push(projected);
    } else if(turnSummary){
      if(Object.hasOwn(row,'directory')&&row.directory!==directoryMarker)throw fail('qa_provider_journal_scope_invalid');
      const value=row.payload;
      if(!id(row.messageID)||!object(value)||!id(value.assistantMessageID)||!object(value.bridge)
        ||!number(value.bridge.count)||!number(value.bridge.failedCount)||value.bridge.failedCount>value.bridge.count)throw fail('qa_provider_turn_summary_invalid');
      output.push({type:'turn-summary',at:row.at,sessionID:row.sessionID,messageID:row.messageID,assistantMessageID:value.assistantMessageID,
        bridge:{count:value.bridge.count,failedCount:value.bridge.failedCount}});
    } else if(row.type==='lifecycle'&&row.event==='session_title_generation'){
      const value=row.payload;
      if(object(value)&&['session_model','persistence','projection','session_read','status_read','pre_patch_read','post_generation_read','verification','idle_confirmation'].includes(value.stage)&&['complete','failed','paused'].includes(value.outcome)){
        const projected={type:'title',at:row.at,sessionID:row.sessionID,stage:value.stage,outcome:value.outcome};
        for(const key of ['helperSessionID','sourceMessageID'])if(id(value[key]))projected[key]=value[key];
        if(['openai','opencode'].includes(value.providerID))projected.providerID=value.providerID;
        if(['gpt-6-astra','deepseek-v4.1-flash'].includes(value.modelID))projected.modelID=value.modelID;
        if(['derived','session_model','free_zen','local_fallback'].includes(value.source))projected.source=value.source;
        output.push(projected);
      }
    } else if (row.type === 'timing' && ['provider_body_end','turn.provider_body_end'].includes(row.mark)) {
      const value = row.payload;
      if (!object(value) || !id(value.requestID) || value.kind !== 'primary' || !['http','ws'].includes(value.transport)
        || !['bytes','chunks','maxGapMs'].every(key=>number(value[key]))) throw fail('qa_provider_timing_invalid');
      output.push({type:'body-end',at:row.at,sessionID:row.sessionID,requestID:value.requestID,kind:value.kind,transport:value.transport,
        bytes:value.bytes,chunks:value.chunks,maxGapMs:value.maxGapMs});
    }
    if (output.length > MAX_PROJECTED) throw fail('qa_provider_journal_bound_exceeded');
  }
  return { complete:complete===true, gapCount, records:output };
}

/** Only the original issuer supplies these paths and flushed journal status. */
export async function readQa1ProviderJournal({ runtimeRoot, journalDirectory, coverage:status, ...selection }) {
  const within = (root,value) => value===root || value.startsWith(root+path.sep);
  const canonical = async (value,root,isDirectory) => {
    if (typeof value!=='string'||!path.isAbsolute(value)||!within(root,value)) throw fail('qa_provider_journal_path_invalid');
    const stat=await fs.lstat(value);
    if(stat.isSymbolicLink()||(isDirectory?!stat.isDirectory():!stat.isFile())||await fs.realpath(value)!==value)throw fail('qa_provider_journal_path_invalid');
    return stat;
  };
  await canonical(runtimeRoot,path.join(repository,'.cache'),true);
  if(journalDirectory!==path.join(runtimeRoot,'harness/journal'))throw fail('qa_provider_journal_path_invalid');
  await canonical(journalDirectory,runtimeRoot,true);
  if(status?.enabled!==true||status.gapRecords!==0||status.queuedRecords!==0||status.lastError)throw fail('qa_provider_journal_status_invalid');
  // Refuse entries the shared collector would intentionally ignore, including
  // replaced bucket/chunk symlinks. Missing buckets are not zero-gap proof.
  const directories=[journalDirectory];
  for(const name of ['runtime','sessions']){
    const directory=path.join(journalDirectory,name);await canonical(directory,journalDirectory,true);directories.push(directory);
    if(name==='sessions')for(const entry of await fs.readdir(directory,{withFileTypes:true})){
      if(!entry.isDirectory())throw fail('qa_provider_journal_path_invalid');
      const bucket=path.join(directory,entry.name);await canonical(bucket,journalDirectory,true);directories.push(bucket);
    }
  }
  if(directories.length>4096)throw fail('qa_provider_journal_bound_exceeded');
  for(const directory of directories){const entries=await fs.readdir(directory,{withFileTypes:true});
    if(entries.length>4096||entries.some(entry=>entry.isSymbolicLink()))throw fail('qa_provider_journal_path_invalid');}
  const paths=await collectJournalPaths(journalDirectory);
  if(!paths.length||paths.length>4096)throw fail('qa_provider_journal_unavailable');
  const records=[];let bytes=0;
  for(const file of paths){
    const info=await canonical(file,journalDirectory,false);
    if(info.size>MAX_BYTES-bytes)throw fail('qa_provider_journal_bound_exceeded');
    const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);let snapshot;
    try{const opened=await handle.stat();if(opened.ino!==info.ino||opened.dev!==info.dev)throw fail('qa_provider_journal_changed');
      snapshot=Buffer.alloc(info.size);let offset=0;while(offset<snapshot.length){const read=await handle.read(snapshot,offset,snapshot.length-offset,offset);if(!read.bytesRead)throw fail('qa_provider_journal_changed');offset+=read.bytesRead;}
      const after=await handle.stat();if(after.ino!==opened.ino||after.dev!==opened.dev||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs)throw fail('qa_provider_journal_changed');
    }finally{await handle.close();}
    const source=file.endsWith('.gz')?gunzipSync(snapshot,{maxOutputLength:MAX_BYTES-bytes}):snapshot;bytes+=source.length;
    if(bytes>MAX_BYTES)throw fail('qa_provider_journal_bound_exceeded');
    const text=source.toString('utf8');if(text&&!text.endsWith('\n'))throw fail('qa_provider_journal_incomplete');
    for(const line of text.split('\n')){if(!line.trim())continue;if(records.length>=MAX_RECORDS||Buffer.byteLength(line)>256*1024)throw fail('qa_provider_journal_bound_exceeded');
      try{records.push(JSON.parse(line));}catch{throw fail('qa_provider_journal_malformed');}}
  }
  return projectQa1ProviderJournal(records,selection);
}

const sameAttempt = (a,b) => a && b && a.traceID===b.traceID && a.spanID===b.spanID;
export function assertQa1ProviderIdle(statuses){
  if(!object(statuses)||Object.values(statuses).some(row=>!object(row)||row.type!=='idle'))throw fail('qa_profile_runtime_not_idle');
}
const titlePersistence = (records, sessionID, sourceMessageID) => {
  const rows = records.filter(row => row.type === 'title' && row.sessionID === sessionID
    && row.sourceMessageID === sourceMessageID && (row.stage === 'persistence' || row.outcome === 'paused'));
  const last = rows.at(-1);
  return { rows, settled:last?.outcome === 'complete' || last?.outcome === 'paused',
    complete:id(sourceMessageID) && last?.stage === 'persistence' && last.outcome === 'complete' && last.source === 'session_model'
      && rows.filter(row => row.outcome === 'complete').length === 1 };
};
export async function waitQa1TitleSettlement({read,sessionID,sourceMessageID,signal,deadline,now=Date.now,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
  let journal;
  for(;;){
    signal.throwIfAborted();journal=await read();signal.throwIfAborted();
    if(journal.complete!==true||journal.gapCount!==0||titlePersistence(journal.records,sessionID,sourceMessageID).settled)return journal;
    if(now()>=deadline)return journal;
    await pause(Math.min(1000,Math.max(1,deadline-now())));
  }
}
export function gradeQa1SilenceSample(journal, sample) {
  const gap = reason => ({ status:'unqualified',reason,sessionID:sample.sessionID,variant:sample.variant });
  if(journal?.complete!==true||journal.gapCount!==0||!Array.isArray(journal.records))return gap('journal-coverage');
  const records=journal.records.filter(row=>row.sessionID===sample.sessionID);
  const accepted=records.filter(row=>row.stage==='accepted-user'&&row.messageID===sample.messageID);
  if(accepted.length!==1)return gap('accepted-input');
  if(accepted[0].execution?.providerID!=='openai'||accepted[0].execution.modelID!=='gpt-6-astra'
    ||accepted[0].execution.variant!==sample.variant)return gap('accepted-selection');
  const steps=records.filter(row=>row.stage==='step-link');
  const matches=steps.filter(row=>row.userMessageID===sample.messageID);
  if(!matches.length)return gap('canonical-step');
  if(matches.some(row=>row.scopeID!==accepted[0].scopeID||row.execution?.providerID!=='openai'
    ||row.execution.modelID!=='gpt-6-astra'||row.execution.variant!==sample.variant))return gap('canonical-step-selection');
  const sends=records.filter(row=>row.stage==='physical'&&row.kind==='primary');
  for(const send of sends){
    const links=steps.filter(row=>row.scopeID===send.scopeID&&sameAttempt(row.attempt,send.attempt));
    if(links.length!==1)return gap('physical-step-scope');
    if(links[0].userMessageID!==sample.messageID
      &&records.filter(row=>row.stage==='accepted-user'&&row.messageID===links[0].userMessageID&&row.scopeID===send.scopeID).length!==1)return gap('physical-step-scope');
  }
  const preparations=records.filter(row=>row.stage==='model-prepared'&&row.kind==='primary');
  if(preparations.some(row=>!sends.some(send=>send.requestID===row.requestID&&send.scopeID===row.scopeID))
    ||records.some(row=>row.type==='body-end'&&!sends.some(send=>send.requestID===row.requestID)))return gap('request-scope');
  const joined=[];
  for(const step of matches){
    const physical=sends.filter(row=>row.scopeID===step.scopeID&&sameAttempt(row.attempt,step.attempt));
    if(!physical.length)return gap('physical-request');
    for(const send of physical){
      const prepared=records.filter(row=>row.stage==='model-prepared'&&row.kind==='primary'&&row.scopeID===send.scopeID&&row.requestID===send.requestID);
      if(prepared.length!==1||prepared[0].execution?.providerID!=='openai'||prepared[0].execution.modelID!=='gpt-6-astra'
        ||prepared[0].execution.variant!==sample.variant||prepared[0].effectiveEffort!==sample.variant||send.wireEffectiveEffort!==sample.variant)return gap('effective-effort');
      if(send.transport!=='http')return gap('websocket-route');
      const body=records.filter(row=>row.type==='body-end'&&row.requestID===send.requestID&&row.transport==='http'&&row.at>=send.at);
      // Repeated transport attempts sharing a requestID cannot be guessed from
      // one lossy timing mark. Refuse ambiguous accounting.
      if(sends.filter(row=>row.requestID===send.requestID).length!==1||body.length!==1||body[0].bytes<=0||body[0].chunks<=0)return gap('body-end');
      joined.push({requestID:send.requestID,assistantMessageID:step.assistantMessageID,effortEvidence:{source:send.wireEffortSource,topLevel:send.wireEffort,configurationUpdateCount:send.wireEffortUpdateCount,effective:send.wireEffectiveEffort},bytes:body[0].bytes,chunks:body[0].chunks,maxGapMs:body[0].maxGapMs});
    }
  }
  const maxGapMs=Math.max(...joined.map(row=>row.maxGapMs));
  return {status:maxGapMs<=60000?'qualified':'unqualified',...(maxGapMs>60000?{reason:'gap-over-60s'}:{}),sessionID:sample.sessionID,
    messageID:sample.messageID,variant:sample.variant,transport:'http',maxGapMs,requests:joined,productTimeoutSeconds:300};
}

export function gradeQa1HelperSample(journal,{sessionID,agent,helper,sourceMessageID}) {
  if(journal?.complete!==true||journal.gapCount!==0||!Array.isArray(journal.records))return {status:'unqualified',reason:'journal-coverage'};
  const records=journal.records.filter(row=>row.sessionID===sessionID&&row.kind==='generate');
  const allPrepared=records.filter(row=>row.stage==='model-prepared');
  const prepared=allPrepared.filter(row=>row.execution?.agent===agent);
  const sends=records.filter(row=>row.stage==='physical');
  const sameRequest=(a,b)=>a.scopeID===b.scopeID&&a.requestID===b.requestID;
  const scopeGap=reason=>({status:'unqualified',reason,modelAndDefaultReasoningObserved:false,requests:[]});
  for(const send of sends)if(allPrepared.filter(row=>sameRequest(row,send)).length!==1)return scopeGap('helper-request-scope');
  if(prepared.some(row=>row.helperSelectionMode==='active'))return {status:'unqualified',reason:'helper-active-fallback',usedActiveFallback:true};
  if(!prepared.length||prepared.some(row=>row.execution.providerID!==helper.providerID||row.execution.modelID!==helper.modelID
    ||row.execution.variant!==null||row.reasoningOptionsEmpty!==true||row.hookReasoningOptionsEmpty!==true))return scopeGap('helper-physical-default-reasoning');
  const joined=[];
  for(const row of prepared){
    const physical=sends.filter(send=>sameRequest(row,send));
    if(allPrepared.filter(other=>sameRequest(row,other)).length!==1||!physical.length
      ||physical.some(send=>!number(send.ordinal)||send.ordinal===0)
      ||new Set(physical.map(send=>send.ordinal)).size!==physical.length)return scopeGap('helper-request-scope');
    for(const send of physical){
      if(!send.wireReasoningOptionsPresent||!send.wireReasoningOptionsEmpty||send.wireEffortUpdatesPresent)return scopeGap('helper-physical-default-reasoning');
      joined.push({sessionID,requestID:row.requestID,ordinal:send.ordinal,transport:send.transport,
        toolsEmpty:row.toolCount===0&&send.toolCount===0&&send.wireToolCount===0,
        selectionVerified:row.helperSelectionMode==='configured'&&send.helperSelectionMode==='configured'
          &&row.helperSelectionRevision===helper.revision&&send.helperSelectionRevision===helper.revision});
    }
  }
  const namingObserved=agent!=='devryan-title'||journal.records.some(row=>row.type==='title'&&row.sessionID===sessionID&&row.stage==='session_model'
    &&row.outcome==='complete'&&row.providerID===helper.providerID&&row.modelID===helper.modelID)
    &&titlePersistence(journal.records,sessionID,sourceMessageID).complete;
  const qualified=joined.every(row=>row.toolsEmpty&&row.selectionVerified)&&namingObserved;
  return {status:qualified?'qualified':'unqualified',...qualified?{}:{reason:namingObserved?'helper-tools-or-revision-unconfirmed':'ordinary-title-settlement-unobserved'},
    modelAndDefaultReasoningObserved:true,namingObserved,selectionRevision:helper.revision,requests:joined};
}

export function assertQa1MediumSample(sample){
  if(sample?.canonicalSelectionVerified!==true||sample.providerID!=='openai'||sample.modelID!=='gpt-6-astra'||sample.variant!=='medium'
    ||!id(sample.sessionID)||!id(sample.messageID)||typeof sample.directory!=='string'||!path.isAbsolute(sample.directory)
    ||!number(sample.since)||!number(sample.until)||sample.until<sample.since)throw fail('qa_provider_original_medium_unavailable');
}

/** Constructor closures only; no credentials, owner URL or profile CLI input. */
export async function runQa1ProviderQualification({api,admitted,ready,ensureCurrent,qualificationReport,selectedIdentity,readJournal,signal:parentSignal,mediumSample}){
  if(admitted()!==true)throw fail('qa_profile_manual_admission_required');
  assertQa1MediumSample(mediumSample);
  const qualification=await readQa1NativeQualification(qualificationReport,selectedIdentity);
  const controller=new AbortController(),signal=parentSignal?AbortSignal.any([parentSignal,controller.signal]):controller.signal;
  const deadline=Date.now()+10*60_000,timer=setTimeout(()=>controller.abort(fail('qa_provider_qualification_deadline')),10*60_000);
  const check=async()=>{signal.throwIfAborted();await ensureCurrent();if(!ready()||!admitted())throw fail('qa_profile_host_not_ready');};
  const request=async(route,options={})=>{await check();const value=await api(route,{...options,signal});await check();return value;};
  const pin=async()=>{await check();await readQa1NativeQualification(qualificationReport,selectedIdentity);assertQa1ProviderIdle(await request('/api/session/status'));};
  const evidence={schemaVersion:1,status:'unqualified',inference:'not-run',qualification,silence:[],helpers:[],productTimeoutSeconds:300,gaps:[]};
  let fixture,previousSettings,changed=false,failure;const sessions=[];
  try{
    await check();
    const medium=gradeQa1SilenceSample(await readJournal({sessionIDs:[mediumSample.sessionID],directory:mediumSample.directory,since:mediumSample.since,until:mediumSample.until}),mediumSample);
    evidence.silence.push(medium);
    if(medium.status!=='qualified')throw fail('qa_provider_original_medium_unqualified');
    assertQa1ProviderIdle(await request('/api/session/status'));
    previousSettings=await request('/api/config/settings');const helper=parseHelperModelSelection(previousSettings.helperModelSelection);
    if(helper?.providerID!==DEFAULT_HELPER_MODEL_SELECTION.providerID||helper.modelID!==DEFAULT_HELPER_MODEL_SELECTION.modelID
      ||typeof previousSettings.lastDirectory!=='string')throw fail('qa_profile_helper_selection_mismatch');
    const catalog=await request('/api/provider');const providers=catalog?.all?.filter(row=>row.id==='openai');
    if(catalog?.catalogIncomplete!==false||!catalog.connected.includes('openai')||providers?.length!==1
      ||!Object.hasOwn(providers[0].models?.['gpt-6-astra']?.variants??{},'high'))throw fail('qa_profile_saved_selection_mismatch');
    if(!catalog.connected.includes(helper.providerID)||!catalog.all.some(row=>row.id===helper.providerID&&object(row.models?.[helper.modelID])))throw fail('qa_profile_helper_catalog_unavailable');
    fixture=await createQaProfileProjectFixture({runId:'qa1-provider-qualification',keepArtifacts:true});
    changed=true;await request('/api/opencode/directory',{method:'POST',body:JSON.stringify({path:fixture.fixtureRoot})});
    const query=`directory=${encodeURIComponent(fixture.fixtureRoot)}`;
    for(const prompt of QA1_HIGH_PROMPTS){
      await pin();const session=await request(`/api/session?${query}`,{method:'POST',body:'{}'});if(!id(session?.id))throw fail('qa_profile_session_invalid');
      sessions.push(session.id);const messageID=createV2MessageId(),since=Date.now();evidence.inference='request-attempted';
      await request(`/api/session/${session.id}/prompt_async?${query}`,{method:'POST',body:JSON.stringify(createQa1HighPrompt(messageID,prompt))});
      evidence.inference='request-accepted';let rows,user;
      for(;;){await check();rows=await request(`/api/session/${session.id}/message?${query}&limit=200`);if(!Array.isArray(rows))throw fail('qa_profile_messages_invalid');
        user=rows.find(row=>row.info?.id===messageID);if(rows.some(row=>row.info?.error))throw fail('qa_profile_turn_failed');
        if(findQaCompletedTurnAssistant({rows,previousIds:new Set(),submittedUser:user,sessionID:session.id,status:await request(`/api/session/status?${query}`)}))break;
        await new Promise(resolve=>setTimeout(resolve,250));}
      if(user?.info?.model?.providerID!=='openai'||user.info.model.modelID!=='gpt-6-astra'||(user.info.variant??user.info.model.variant)!=='high')throw fail('qa_profile_canonical_selection_mismatch');
      assertQaSubmittedPlanMode(user,true);
      const sample={sessionID:session.id,messageID,directory:fixture.fixtureRoot,since,until:Date.now(),variant:'high'};
      const journal=await readJournal({sessionIDs:[session.id],directory:fixture.fixtureRoot,since,until:sample.until});
      evidence.silence.push(gradeQa1SilenceSample(journal,sample));
      await gradeQa1ProfileFiles(fixture,{planned:true});
      if(sessions.length===1){
        for(const [agent,route,body] of [['devryan-title',null,null],['devryan-commit','/api/git/commit-message/draft',{selectedFiles:['docs/user-notes.md'],stagedOnly:false,guidance:'Draft only: describe the disposable fixture note.',sessionID:session.id}],
          ['devryan-pr','/api/git/pr-description',{base:'HEAD',head:'HEAD',prompt:'Draft only: describe the disposable profile fixture and its regression coverage.',sessionID:session.id}]]){
          const start=route?Date.now():since;await pin();let validResponse=true;
          if(route){const response=await request(`${route}?${query}`,{method:'POST',body:JSON.stringify(body)});
            validResponse=agent==='devryan-commit'?response?.status==='complete'&&Array.isArray(response.commits)&&response.commits.length>0
              :response?.validResponse===true;}
          const after=await request('/api/config/settings');if(JSON.stringify(after.helperModelSelection)!==JSON.stringify(helper))throw fail('qa_profile_helper_selection_changed');
          const current=await request(`/api/session/${session.id}/message?${query}&limit=200`),original=current.find(row=>row.info?.id===messageID);
          if(JSON.stringify(original?.info.model)!==JSON.stringify(user.info.model)||(original?.info.variant??original?.info.model.variant)!=='high')throw fail('qa_profile_canonical_selection_mismatch');
          const read=async()=>{await check();return readJournal({sessionIDs:[session.id],directory:fixture.fixtureRoot,since:start,until:Date.now()});};
          const helperJournal=agent==='devryan-title'?await waitQa1TitleSettlement({read,sessionID:session.id,sourceMessageID:messageID,signal,deadline:Math.min(deadline,Date.now()+30000)}):await read();
          const observed=gradeQa1HelperSample(helperJournal,{sessionID:session.id,agent,helper,sourceMessageID:messageID});
          evidence.helpers.push({agent,validResponse,primarySelectionPreserved:true,...observed,...!validResponse?{status:'unqualified',reason:'helper-draft-response-invalid'}:{}});
        }
      }
    }
    evidence.inference='completed';
    evidence.gaps.push(...evidence.silence.filter(row=>row.status!=='qualified').map(row=>row.reason),...evidence.helpers.filter(row=>row.status!=='qualified').map(row=>row.reason));
  }catch(error){failure=error;evidence.code=safeCode(error);evidence.gaps.push(evidence.code);}
  finally{
    const cleanup=[];
    for(const sessionID of sessions)try{await ensureCurrent();const result=await cleanupQaSessionTree({api,rootSessionID:sessionID,directory:fixture.fixtureRoot,timeoutMs:12000});if(!result.complete)throw fail('qa_profile_session_cleanup_failed');}catch(error){cleanup.push(safeCode(error));}
    if(changed)try{await ensureCurrent();const latest=await api('/api/config/settings');if(latest.lastDirectory===fixture.fixtureRoot){await api('/api/opencode/directory',{method:'POST',body:JSON.stringify({path:previousSettings.lastDirectory})});
      const restored=await api('/api/config/settings');if(restored.lastDirectory!==previousSettings.lastDirectory)throw fail('qa_profile_directory_restore_changed');
      await api('/api/config/settings',{method:'PUT',body:JSON.stringify({activeProjectId:previousSettings.activeProjectId??null,lastDirectory:previousSettings.lastDirectory})});}}catch(error){cleanup.push(safeCode(error));}
    clearTimeout(timer);evidence.cleanup={passed:cleanup.length===0,codes:cleanup};if(cleanup.length)evidence.gaps.push('cleanup-unconfirmed');
    evidence.status=failure||cleanup.length?'failed':evidence.gaps.length?'unqualified':'qualified';
    if(fixture){await fs.writeFile(path.join(fixture.evidenceDirectory,'provider-qualification.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx',mode:0o600});await finishQaProfileProjectFixture(fixture,evidence.status==='qualified'?'passed':'failed');}
  }
  return {status:'provider-qualification-finished',outcome:evidence.status,inference:evidence.inference,cleanup:evidence.cleanup,gaps:[...new Set(evidence.gaps)],evidenceDirectory:fixture?.evidenceDirectory??null,productTimeoutSeconds:300};
}
