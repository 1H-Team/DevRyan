import {AsyncLocalStorage} from 'node:async_hooks';
import {isDeepStrictEqual} from 'node:util';
import {currentObjectiveUser} from '@openchamber/harness-runtime/lib/objective-identity.js';
import {isNativeStatusRecord} from '../../../../../shared-runtime/lib/native-message-status.js';
import {nativeStepPermitSha256} from './primary-step-owner.js';
const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const fail=code=>Object.assign(new Error(code),{code,statusCode:409});
const terminal=new Set(['completed','failed','aborted','timed_out']);

/** Existing managed scheduler owns all tasks and prompt-observed receipts. The
 * original Slim renderer owns only transient context presentation. */
export function createNativeSlimContextOwner({admissionOwner,openCodeClient,primaryRuntime,getManagedRuntime,getInstanceID,originals,locations}){
 const scopes=new AsyncLocalStorage(),renderers=new Map();
 const active=()=>{const scope=scopes.getStore();if(!scope)throw fail('native_slim_context_scope_required');return scope;};
 const job=(task,envelope)=>({taskID:task.taskId,alias:task.taskId,agent:task.agent,
  state:task.status==='failed'?'error':task.status==='aborted'?'cancelled':task.status==='timed_out'?'stopped':terminal.has(task.status)?task.status:'running',
  generation:task.attempt,terminalRevision:envelope?.sequence,description:task.label,objective:task.prompt,
  resultSummary:envelope?.recoverablePreview??'',lastStatusError:task.failureReason,
  timedOut:task.status==='timed_out',statusUncertain:task.status==='timed_out',
  terminalUnreconciled:Boolean(envelope&&(envelope.promptObserved?.attempt!==task.attempt||envelope.promptObserved?.sequence!==envelope.sequence)),
  terminalState:task.status==='failed'?'error':task.status==='aborted'?'cancelled':task.status==='completed'?'completed':undefined,
  launchedAt:task.createdAt,lastLaunchedAt:task.startedAt??task.createdAt,contextFiles:[],
 });
 const renderer=directory=>{
  if(renderers.has(directory))return renderers.get(directory);
  const location=locations.find(value=>value.directory===directory),saved=location?.compatibility?.slim;
  const settings=saved?.nativeRuntime?.backgroundJobs;
  if(saved?.mergedConfig?.backgroundJobs!==undefined&&!record(settings))throw fail('native_slim_context_configuration_required');
  if(settings!==undefined&&(!record(settings)||!['latest','checkpoint-compatible'].includes(settings.strategy)||!Number.isInteger(settings.maxRetainedSnapshots)||settings.maxRetainedSnapshots<1||settings.maxRetainedSnapshots>100||!Number.isInteger(settings.readContextMaxFiles)||settings.readContextMaxFiles<0||settings.readContextMaxFiles>50))throw fail('native_slim_context_configuration_required');
  const value=originals.createReviewedSlimTaskBoardRenderer({...settings?{strategy:settings.strategy,maxRetainedSnapshots:settings.maxRetainedSnapshots}:{},shouldManageSession:sessionID=>active().sessionID===sessionID,
   board:{get:taskID=>active().jobs.get(taskID),formatForPromptWithMetadata:sessionID=>{
    const scope=active();if(scope.sessionID!==sessionID)throw fail('native_slim_context_scope_invalid');
    const jobs=[...scope.jobs.values()];
    return originals.formatReviewedSlimTaskBoard({...settings?{readContextMaxFiles:settings.readContextMaxFiles}:{},jobs,reusable:jobs.filter(item=>!item.terminalUnreconciled&&scope.envelopes.get(item.taskID)?.resumable===true)});
   },markReconciled:(taskID,_at,generation,revision)=>{
    const scope=active(),current=scope.jobs.get(taskID);if(!current||current.generation!==generation||current.terminalRevision!==revision)throw fail('native_slim_context_revision_conflict');
    scope.markPromptObserved({taskId:taskID,attempt:generation,sequence:revision});
    const next={...current,state:'reconciled',terminalUnreconciled:false};scope.jobs.set(taskID,next);return next;
   }}});
  renderers.set(directory,value);return value;
 };
 return {
  async transformMessages(input,context={}){
   if(!record(input)||input.phase!=='context'||typeof input.sessionID!=='string'||typeof input.directory!=='string'||!Array.isArray(input.messages)
    ||!locations.some(location=>location.directory===input.directory&&(location.activeRegistrationIDs===undefined||location.activeRegistrationIDs.includes('devryan.slim'))))throw fail('native_slim_context_invalid');
   if(Buffer.byteLength(JSON.stringify(input.messages))>4*1024*1024)throw fail('native_slim_context_limit');
   const captured=await admissionOwner.captureSessionHookAuthorization(input);
   const recheck=async()=>{context.signal?.throwIfAborted();await captured();context.signal?.throwIfAborted();};await recheck();
   const [session,primary]=await Promise.all([openCodeClient.sessions.get(input.sessionID,{directory:input.directory}),primaryRuntime.readRecord(input.sessionID)]);
   if(session?.id!==input.sessionID||session.directory!==input.directory||session.time?.archived||session.revert)throw fail('native_slim_context_scope_invalid');
   if(session.parentID||!primary||primary.sessionID!==input.sessionID||primary.directory!==input.directory||primary.agent!=='orchestrator'){
    await recheck();return {messages:structuredClone(input.messages),presentationInsertions:[]};
   }
   if(primary.recoveryID&&['recovery_reserved','recovering'].includes(primary.state)){
    // Read-only recovery must not acknowledge managed results or inject a board.
    // Existing durable recovery authority, rather than this presentation hook,
    // owns its model, prompt, attempt and cancellation checks.
    const recovery=await primaryRuntime.captureNativeRecoveryDispatch({sessionID:input.sessionID,directory:input.directory,
     messageID:primary.recoveryID,instanceID:primary.instanceID});
    const objective=currentObjectiveUser(recovery.record);
    // Slim's SDK presentation also gives status, skill and location changes a
    // user role. Only canonical native history can identify the turn parent.
    const readOptions={directory:input.directory,signal:context.signal,timeoutMs:5000,maxResponseBytes:16*1024*1024};
    if(recovery.record.stepID&&recovery.record.stepID!==recovery.record.failedID){
     const step=await openCodeClient.sessions.message(input.sessionID,recovery.record.stepID,readOptions);
     if(step?.info?.id!==recovery.record.stepID||step.info.sessionID!==input.sessionID||step.info.role!=='assistant'
      ||step.info.time?.completed||step.info.parentID!==objective
      ||step.turnOwnership?.source!=='native-sequence'||step.turnOwnership.userMessageID!==objective)throw fail('native_slim_context_primary_fenced');
    }else{
     // Before the recovery Step exists, use the same bounded page budget as
     // recovery observation rather than imposing a transcript-length cutoff.
     const started=Date.now(),seen=new Set();let before,latest,bytes=0,count=0;
     while(!latest&&count<10000&&Date.now()-started<15000){
      const page=await openCodeClient.sessions.messages(input.sessionID,{limit:100,...before?{before}:{}},readOptions);
      if(!Array.isArray(page?.records)||page.records.length>100)throw fail('native_slim_context_source_unavailable');
      bytes+=Buffer.byteLength(JSON.stringify(page.records));count+=page.records.length;
      if(bytes>16*1024*1024)throw fail('native_slim_context_source_unavailable');
      latest=[...page.records].reverse().find(message=>message?.info?.role==='user'&&!isNativeStatusRecord(message));
      await recheck();
      if(latest||!page.cursor||seen.has(page.cursor))break;
      seen.add(page.cursor);before=page.cursor;
     }
     if(!latest)throw fail('native_slim_context_source_unavailable');
     if(latest.info.id!==objective)throw fail('native_slim_context_primary_fenced');
    }
    await recheck();await recovery.recheck();
    const current=await primaryRuntime.readRecord(input.sessionID);
    if(!current||currentObjectiveUser(current)!==objective)throw fail('native_slim_context_primary_fenced');
    await recovery.recheck();await recheck();
    return {messages:structuredClone(input.messages),presentationInsertions:[]};
   }
   if(['cancelled','superseded','stopping','needs_attention','recovery_reserved','recovering','reconciling'].includes(primary.state))throw fail('native_slim_context_primary_fenced');
   const authorize=async()=>{
    await recheck();const current=await primaryRuntime.readRecord(input.sessionID);
    if(!current||['cancelled','superseded','stopping','needs_attention','recovery_reserved','recovering','reconciling'].includes(current.state)
      ||current.recoveryID||['anchorID','objectiveID','continuationID','owner','cancellationGeneration','providerID','modelID','agent','variant'].some(key=>current[key]!==primary[key]))throw fail('native_slim_context_primary_fenced');
    await recheck();
   };
   const runtime=await getManagedRuntime();if(!runtime?.withNativePromptContext)throw fail('native_slim_context_owner_unavailable');
   const original=renderer(input.directory),messages=structuredClone(input.messages),originalMessages=[...messages];let result;
   try{
    await runtime.withNativePromptContext({rootSessionId:input.sessionID,directory:input.directory,authorize},async state=>{
     const envelopes=new Map(state.envelopes.map(value=>[value.taskId,value]));
     const jobs=new Map(state.tasks.filter(task=>task.childSessionId).map(task=>[task.taskId,job(task,envelopes.get(task.taskId))]));
     await scopes.run({sessionID:input.sessionID,jobs,envelopes,markPromptObserved:state.markPromptObserved},()=>original.transform({}, {messages}));
    const presentationInsertions=[];
    for(const [index,message] of messages.entries()){
     if(originalMessages.includes(message))continue;
     if(!record(message)||!record(message.info)||!Array.isArray(message.parts)||Object.hasOwn(message,'devryanContextKey'))throw fail('native_slim_context_result_invalid');
     const {id,...insertedInfo}=message.info;
     if(typeof id!=='string')throw fail('native_slim_context_result_invalid');
     const base=[...originalMessages].reverse().find(candidate=>{
      if(!record(candidate?.info)||candidate.info.role!=='user'||candidate.info.sessionID!==input.sessionID||typeof candidate.devryanContextKey!=='string')return false;
      const {id:baseID,...baseInfo}=candidate.info;void baseID;return isDeepStrictEqual(baseInfo,insertedInfo);
     });
     if(!base)throw fail('native_slim_context_result_invalid');
     presentationInsertions.push({index,baseKey:base.devryanContextKey});
    }
    result={messages,presentationInsertions};
    if(Buffer.byteLength(JSON.stringify(result))>4*1024*1024)throw fail('native_slim_context_limit');

    });
    await recheck();return result;
   }catch(error){original.clearSession(input.sessionID);throw error;}
  },
  async retry(input,context={}){
   if(!record(input)||input.phase!=='retry'||!record(input.event)||input.event.sessionID!==input.sessionID)throw fail('native_slim_retry_invalid');
   const location=locations.find(value=>value.directory===input.directory&&(value.activeRegistrationIDs===undefined||value.activeRegistrationIDs.includes('devryan.slim')));
   if(!location)throw fail('native_slim_retry_invalid');
   const captured=await admissionOwner.captureSessionHookAuthorization(input);
   const authorize=async()=>{context.signal?.throwIfAborted();await captured();context.signal?.throwIfAborted();};await authorize();
   const event=input.event;
   if(!originals.isReviewedSlimFailoverError(event.error)){await authorize();return {decision:event.decision};}
   const native=location.compatibility?.slim?.nativeRuntime;
   if(!record(native)||!record(native.runtimeChains)||!record(native.fallback))throw fail('native_slim_retry_configuration_required');
   if(native.fallback.enabled===false){await authorize();return {decision:event.decision};}
   const primary=await primaryRuntime.readRecord(input.sessionID);
   const instanceID=getInstanceID?.(),attempt=input.attempt;
   if(!primary||primary.executionGeneration!==2||primary.directory!==input.directory||typeof instanceID!=='string'||!instanceID
    ||!record(attempt)||typeof attempt.traceID!=='string'||!attempt.traceID||typeof attempt.spanID!=='string'||!attempt.spanID)throw fail('native_slim_retry_primary_fenced');
   if(primary.recoveryID&&['recovery_reserved','recovering'].includes(primary.state)){
    // The sole read-only fallback may itself fail before Started. Let native
    // publish its real failure; this hook cannot reserve another attempt.
    const execution=primary.recoveryExecution;
    if(!execution||event.agent!==execution.agent||event.model?.providerID!==execution.providerID||event.model?.id!==execution.modelID)throw fail('native_slim_retry_primary_fenced');
    const recovery=await primaryRuntime.captureNativeRecoveryDispatch({sessionID:input.sessionID,directory:input.directory,messageID:primary.recoveryID,instanceID});
    await authorize();await recovery.recheck();
    if(getInstanceID?.()!==instanceID)throw fail('native_slim_retry_primary_fenced');
    return {decision:{retry:false}};
   }
   if(event.agent!==primary.agent||event.model?.providerID!==primary.providerID||event.model?.id!==primary.modelID)throw fail('native_slim_retry_primary_fenced');
   let assistantMessageID=null;
   if(primary.stepID){
    const step=await openCodeClient.sessions.message(input.sessionID,primary.stepID,{directory:input.directory,signal:context.signal,timeoutMs:5000,maxResponseBytes:16*1024*1024});
    if(step?.info?.id!==primary.stepID||step.info.sessionID!==input.sessionID||step.info.role!=='assistant'
     ||step.info.parentID!==currentObjectiveUser(primary)||step.turnOwnership?.source!=='native-sequence'
     ||step.turnOwnership.userMessageID!==step.info.parentID)throw fail('native_slim_retry_primary_fenced');
    if(!step.info.time?.completed)assistantMessageID=primary.stepID;
   }
   const authorizeCurrent=async()=>{await authorize();if(getInstanceID?.()!==instanceID)throw fail('native_slim_retry_primary_fenced');};
   if(assistantMessageID===null){
    // The first lazy attempt has no Step handoff to perform this existing
    // canonical version handshake. The hook grant remains live across its read.
    await authorizeCurrent();await primaryRuntime.helloNative({policyVersion:1,instanceID},{authorize:authorizeCurrent,isCurrent:()=>getInstanceID?.()===instanceID});await authorizeCurrent();
   }
   await primaryRuntime.reserveNativeFallback({sessionID:input.sessionID,userMessageID:currentObjectiveUser(primary),
    assistantMessageID,...assistantMessageID===null?{previousStepID:primary.stepID??null}:{},instanceID,attempt:{traceID:attempt.traceID,spanID:attempt.spanID},permitSha256:nativeStepPermitSha256(input.permit),currentExecution:{providerID:primary.providerID,modelID:primary.modelID,agent:primary.agent,variant:primary.variant}},
    {authorize:authorizeCurrent,choose:async state=>{
     const choice=originals.selectReviewedSlimFallback({chains:native.runtimeChains,agent:event.agent,currentModel:event.model.providerID+'/'+event.model.id,...state});
     // The original native hook switches a Model.Ref WITHOUT variant. Pinned
     // Session.switchModel resolves that omission to native's default variant.
     return {tried:choice.tried,exhaustion:choice.exhaustion,...record(choice.selection)?{execution:{...choice.selection.ref,agent:primary.agent,variant:'default'}}:{}};
    }});
   await authorizeCurrent();return {decision:{retry:false}};
  },
  clearSession(sessionID){for(const renderer of renderers.values())renderer.clearSession(sessionID);},
 };
}
