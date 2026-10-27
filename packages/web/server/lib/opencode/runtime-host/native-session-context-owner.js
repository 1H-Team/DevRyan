import {currentObjectiveUser} from '@devryan/harness-runtime/lib/objective-identity.js';
import {toV1ToolName} from '../v2/projection/tools.js';
import { readSessionTodo } from '../v2/projection/sessions.js';
import {randomBytes} from 'node:crypto';

export const SESSION_CONTEXT_PLUGIN_ID = 'devryan.harness-context';
const fail = code => Object.assign(new Error(code), {code,statusCode:403});
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const TODO_CONTINUATION = '[devryan-open-todo-continuation:v1]\nYour turn ended with open todos. If a plan deviation stopped you, classify it (Class 1: note it and continue; Class 2: ask with the question tool) and continue from the first runnable todo. Missing integration capabilities do not block independent code, unit tests, or fixture QA. Keep dependency-blocked todos pending with blockedBy reasons; do not repeat them until the dependency changes. If everything is done, mark the todos complete and give the final summary.';
const PLAN_PREFIX='User has requested to enter plan mode';
export function validateNativeTodos(value) {
  if (!Array.isArray(value) || value.some(item => !record(item)
    || Object.keys(item).some(key => !['id','content','status','priority','blockedBy'].includes(key))
    || typeof item.content !== 'string' || !item.content.trim()
    || !['pending','in_progress','completed','cancelled'].includes(item.status)
    || !['high','medium','low'].includes(item.priority)
    || item.blockedBy !== undefined && (!Array.isArray(item.blockedBy) || !item.blockedBy.length || item.blockedBy.length > 16 || item.status !== 'pending' || item.blockedBy.some(reason => typeof reason !== 'string' || !reason.trim() || reason.length > 512))
    || typeof item.id !== 'string' || !item.id.trim())
    || new Set(value.map(item => item.id)).size !== value.length) throw fail('native_todos_invalid');
  return structuredClone(value);
}

/** Native reads and metadata commits use the existing canonical task/context
 * owners. No plugin field is a caller grant or a durable objective. */
export function createNativeSessionContextOwner({admissionOwner,taskContext,openCodeClient,writeTodos,authorizeContext,primaryRuntime,instanceID,getInstanceID,deliverContinuation,isHeld,readSessionMetadata,inspectVerification,getManagedRuntime,onContinuationError,getCapabilitySnapshot,executionHost}) {
  const scans=new Map(), watches=new Map();
  const helloOwner={isCurrent:()=>!getInstanceID||getInstanceID()===instanceID,
    authorize:async()=>{if(!helloOwner.isCurrent())throw fail('native_primary_continuation_controller_stale');}};
  const readMetadata=async({sessionID,directory})=>{
    if(typeof readSessionMetadata!=='function')throw fail('native_todo_metadata_owner_required');
    const snapshot=await readSessionMetadata({sessionID,directory});
    if(snapshot?.id!==sessionID||snapshot.directory!==directory||!record(snapshot.metadata))throw fail('native_todo_metadata_scope_invalid');
    return snapshot.metadata;
  };
  const deliver=async scope=>{
    const captured=await primaryRuntime.captureNativeContinuationDispatch({...scope,instanceID});
    await captured.recheck();
    await deliverContinuation({scope,prompt:captured.prompt},captured.recheck);
    // Delivery ACK alone does not consume the durable reservation. The actual
    // canonical Step.Started clears it through the existing primary owner.
    return {continued:true,messageID:scope.messageID};
  };
  const scan=async({sessionID,directory,fromChild=false})=>{
    if(!primaryRuntime||typeof deliverContinuation!=='function'||!instanceID)throw fail('native_primary_continuation_owner_required');
    await primaryRuntime.helloNative({instanceID,policyVersion:1},helloOwner);
    const primary=await primaryRuntime.readRecord(sessionID);
    if(!primary||primary.directory!==directory){
      if(!fromChild&&getManagedRuntime){const child=await openCodeClient.sessions.get(sessionID,{directory});
        if(child?.id===sessionID&&child.directory===directory&&child.parentID&&!child.time?.archived) return scan({sessionID:child.parentID,directory,fromChild:true});}
      return {continued:false,reason:'untracked'};
    }
    if(primary.nativeContinuation)return deliver({sessionID,directory,messageID:primary.nativeContinuation.messageID});
    if(!primary.stepID||!['observing','completed'].includes(primary.state)||primary.executionGeneration!==2||primary.recoveryID
      ||primary.recoverySuppressed||!['build','builder','orchestrator'].includes(primary.agent))return {continued:false,reason:'objective_fenced'};
    const [session,statuses,assistant,anchor]=await Promise.all([openCodeClient.sessions.get(sessionID,{directory}),
      openCodeClient.sessions.status({directory}),openCodeClient.sessions.message(sessionID,primary.stepID,{directory}),
      openCodeClient.sessions.message(sessionID,primary.objectiveID??primary.anchorID,{directory})]);
    if(session?.id!==sessionID||session.directory!==directory||session.parentID||session.time?.archived||session.revert
      ||!record(statuses)||(statuses[sessionID]!==undefined&&statuses[sessionID]?.type!=='idle'))return {continued:false,reason:'session_not_idle'};
    const runtime=getManagedRuntime?.();
    const ready=runtime?await runtime.handleRpc({method:'list_provider_recovery_continuations',params:{sessionId:sessionID}}):null;
    let collect;
    for(const candidate of ready?.continuations??[]){
      if(candidate.kind!=='collect'||candidate.rootSessionId!==sessionID||candidate.directory!==directory
        || primary.collectionWake?.taskId===candidate.taskId
        || primary.collectionWakes?.some(wake=>wake.taskId===candidate.taskId&&wake.generation===primary.cancellationGeneration))continue;
      const objectiveID=primary.objectiveID??primary.anchorID;
      // New tasks carry the host-captured original objective across every
      // continuation. Old tasks can prove only the original or current turn;
      // arbitrary historical synthetic text is never lineage authority.
      if(candidate.dispatchObjectiveId!=null&&candidate.dispatchObjectiveId!==objectiveID)continue;
      const source=candidate.dispatchGroupId===objectiveID?anchor
        :await openCodeClient.sessions.message(sessionID,candidate.dispatchGroupId,{directory});
      if(source?.info?.id!==candidate.dispatchGroupId||source.info.sessionID!==sessionID)continue;
      if(source.info.id===objectiveID){if(source.info.role!=='user')continue;}
      else{
        if(source.info.role!=='assistant'||source.turnOwnership?.source!=='native-sequence'
          ||typeof source.info.parentID!=='string'||source.turnOwnership.userMessageID!==source.info.parentID)continue;
        if(candidate.dispatchObjectiveId==null&&source.info.parentID!==objectiveID
          &&source.info.parentID!==currentObjectiveUser(primary))continue;
      }
      collect=candidate;break;
    }
    const todos=readSessionTodo(await readMetadata({sessionID,directory}),sessionID)?.items;
    let verification = null, verificationWake = false;
    if(!collect){
      const open = Array.isArray(todos) && todos.some(todo=>['pending','in_progress'].includes(todo.status));
      const runnable = open && todos.some(todo=>['pending','in_progress'].includes(todo.status) && !todo.blockedBy?.length);
      if (!runnable && inspectVerification) {
        verification = await inspectVerification({rootSessionId:sessionID,directory,objectiveId:primary.objectiveID??primary.anchorID});
        if (!verification || typeof verification.ready !== 'boolean' || !Array.isArray(verification.remaining)) throw fail('native_verification_unavailable');
        verificationWake = !verification.ready && verification.remaining.some(check => ['pending','failed'].includes(check.status));
      }
      if (!runnable && !verificationWake) return {continued:false,reason:open?'dependencies_blocked':verification && !verification.ready?'verification_blocked':'todos_complete'};
    }
    if(assistant?.info?.id!==primary.stepID||assistant.info.sessionID!==sessionID||assistant.info.role!=='assistant'
      ||!assistant.info.time?.completed||assistant.info.error||(assistant.info.finish&&assistant.info.finish!=='stop')
      ||assistant.turnOwnership?.source!=='native-sequence'||assistant.turnOwnership.userMessageID!==currentObjectiveUser(primary)
      ||assistant.info.parentID!==currentObjectiveUser(primary)||assistant.info.agent!==primary.agent
      ||assistant.info.providerID!==primary.providerID||assistant.info.modelID!==primary.modelID
      ||(assistant.info.variant??null)!==primary.variant)return {continued:false,reason:'turn_not_settled'};
    const text=assistant.parts?.filter(part=>part.type==='text').map(part=>part.text).join('\n')??'';
    if(!collect&&(text.includes('manualRecoveryRequired')||text.includes('[devryan-provider-recovery:')))return {continued:false,reason:'manual_recovery'};
    if(anchor?.info?.id!==(primary.objectiveID??primary.anchorID)||anchor.info.sessionID!==sessionID||anchor.info.role!=='user')throw fail('native_primary_objective_unavailable');
    const parts=[];
    if(anchor.info.metadata?.devryanPlanMode===true||anchor.info.metadata?.openchamberPlanMode===true){
      const instruction=anchor.parts?.find(part=>part.type==='text'&&part.synthetic===true&&part.text?.trim().startsWith(PLAN_PREFIX));
      if(!instruction||!instruction.text.trim().slice(PLAN_PREFIX.length).replace(/^[.\s]+/,''))throw fail('native_primary_plan_instruction_unavailable');
      parts.push({type:'text',synthetic:true,text:instruction.text});
    }
    parts.push({type:'text',synthetic:true,text:collect
      ?`[devryan-managed-result-ready:v1]\nManaged task ${collect.taskId} has settled. Read and review its result using devryan_task, collect it without waiving incomplete checks, and continue all runnable work. Preserve the current objective and plan/build policy; do not repeat completed discovery.`
      :verificationWake ? `[devryan-verification-continuation:v1]\nRequired verification remains incomplete for the current objective. Inspect and run the runnable declared checks, preserving failures and current evidence. Do not waive checks or repeat external prerequisites that remain blocked. Remaining: ${JSON.stringify(verification.remaining.slice(0,16))}`
      :TODO_CONTINUATION});
    const messageID=`msg_${(BigInt(Date.now())*4096n).toString(16).slice(-12).padStart(12,'0')}${randomBytes(7).toString('hex')}`;
    const prompt={messageID,agent:primary.agent,model:{providerID:primary.providerID,modelID:primary.modelID},variant:primary.variant,
      tools:primary.tools,objectiveID:primary.objectiveID??primary.anchorID,parts};
    const claimScope=collect?{taskId:collect.taskId,rootSessionId:sessionID,directory,claimantId:instanceID}:null;
    if(claimScope){
      const claim=await runtime.handleRpc({method:'claim_provider_recovery_continuation',params:claimScope});
      if(!claim?.claimed)return {continued:false,reason:'collection_claimed'};
    }
    try{
      let envelopeID;
      if(collect){
        const current=await runtime.handleRpc({method:'status',params:{...claimScope}});
        if(current.task?.taskId!==collect.taskId||current.task.rootSessionId!==sessionID||current.task.directory!==directory
          ||current.resultEnvelope?.action!==null||current.task.manualRecoveryRequired)return {continued:false,reason:'collection_changed'};
        envelopeID=current.resultEnvelope.envelopeId;
      }
      await primaryRuntime.reserveNativeContinuation({instanceID,sessionID,directory,assistantMessageID:primary.stepID,
        anchorUserMessageID:primary.anchorID,userMessageID:messageID,kind:collect?'collect':verificationWake?'verification':primary.agent==='orchestrator'?'orchestrator_todo':'builder_todo',
        ...(collect?{collection:{taskId:collect.taskId,envelopeId:envelopeID,claimantId:instanceID}}:{}),
        execution:{providerID:primary.providerID,modelID:primary.modelID,agent:primary.agent,variant:primary.variant}},prompt);
      return await deliver({sessionID,directory,messageID});
    }finally{if(claimScope)await runtime.handleRpc({method:'release_provider_recovery_continuation',params:claimScope});}

  };
  const owner={
    continueTodos(input){
      const key=`${input.directory}\0${input.sessionID}`,existing=scans.get(key);if(existing)return existing;
      const work=scan(input);scans.set(key,work);void work.finally(()=>{if(scans.get(key)===work)scans.delete(key);}).catch(()=>{});return work;
    },
    async recoverContinuations({directory}){
      if(!primaryRuntime||!instanceID)throw fail('native_primary_continuation_owner_required');
      await primaryRuntime.helloNative({instanceID,policyVersion:1},helloOwner);
      for(const scope of await primaryRuntime.pendingNativeContinuations({directory})){
        // Holds defer recovery; they never consume or replace its durable ID.
        if(typeof isHeld!=='function')throw fail('native_primary_hold_owner_required');
        if(await isHeld(scope))continue;
        await owner.continueTodos(scope);
      }
      const ready=await getManagedRuntime?.()?.handleRpc({method:'list_provider_recovery_continuations',params:{}});
      for(const sessionID of new Set((ready?.continuations??[]).filter(item=>item.directory===directory).map(item=>item.rootSessionId))){
        if(typeof isHeld!=='function')throw fail('native_primary_hold_owner_required');
        if(!await isHeld({sessionID,directory})){
          try{await owner.continueTodos({sessionID,directory});}
          catch(error){onContinuationError?.({sessionID,directory,code:typeof error?.code==='string'?error.code:'native_collection_continuation_failed'});}
        }
      }
    },
    startResultWatch({directory}){
      if(!getManagedRuntime||watches.has(directory))return;
      const controller=new AbortController(),entry={controller,done:null};
      watches.set(directory,entry);
      entry.done=(async()=>{
        let cursor,failures=0;
        while(!controller.signal.aborted&&helloOwner.isCurrent()){
          try{
            const pollStartedAt=Date.now();
            const result=await getManagedRuntime().handleRpc({method:'watch_result_commits',params:{directory,afterCursor:cursor,waitTimeoutMs:25000}}, {signal:controller.signal});
            if(controller.signal.aborted||!helloOwner.isCurrent())break;
            if(typeof result?.cursor!=='string')throw fail('native_collection_watch_invalid');
            const changed=cursor!==result.cursor;cursor=result.cursor;failures=0;
            // A ready result whose canonical read failed still needs collection
            // even when no later result commit advances this cursor.
            await owner.recoverContinuations({directory});
            if(!changed&&!controller.signal.aborted&&Date.now()-pollStartedAt<1000){
              await new Promise(resolve=>{
                const finish=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',finish);resolve();};
                const timer=setTimeout(finish,Math.max(1,1000-(Date.now()-pollStartedAt)));
                timer.unref?.();controller.signal.addEventListener('abort',finish,{once:true});
              });
            }
          }catch(error){
            if(controller.signal.aborted||!helloOwner.isCurrent())break;
            onContinuationError?.({directory,code:typeof error?.code==='string'?error.code:'native_collection_watch_failed'});
            failures++;
            await new Promise(resolve=>{
              const finish=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',finish);resolve();};
              const timer=setTimeout(finish,Math.min(30000,1000*2**Math.min(failures,5)));
              timer.unref?.();controller.signal.addEventListener('abort',finish,{once:true});
            });
          }
        }
      })().finally(()=>{if(watches.get(directory)===entry)watches.delete(directory);});
    },
    async dispose(){
      const active=[...watches.values()];for(const entry of active)entry.controller.abort();
      await Promise.allSettled(active.map(entry=>entry.done));
    },
    async tool(input, context = {}) {
      const recheck = async () => {context.signal?.throwIfAborted();await admissionOwner.recheckExecution(input);};
      if (!['todoread','todowrite'].includes(input?.tool)
        || input.authorization?.input?.provenance?.kind !== 'plugin'
        || input.authorization.input.provenance.id !== SESSION_CONTEXT_PLUGIN_ID) throw fail('native_todo_origin_required');
      return admissionOwner.withPermit(input,async()=>{
        await recheck();await taskContext.authorizeNativeTodoInvocation(input);await recheck();
        if (!record(input.input) || Object.keys(input.input).some(key=>input.tool==='todowrite'?key!=='todos':true)) throw fail('native_todos_invalid');
        const controlLease = executionHost?.nativeManagedControl
          ? (await executionHost.nativeManagedControl({ invocation: input, action: 'begin' })).lease : null;
        try {
        if (input.tool==='todowrite') {
          const todos=validateNativeTodos(input.input.todos);
          const requireVerification=async()=>{
            if(!inspectVerification || todos.some(todo=>['pending','in_progress'].includes(todo.status)))return;
            const primary=await primaryRuntime.readRecord(input.sessionID);
            const verification=await inspectVerification({rootSessionId:input.sessionID,directory:input.directory,objectiveId:primary.objectiveID??primary.anchorID});
            if(!verification.ready)throw Object.assign(fail('required_verification_pending'),{
              message:`required_verification_pending: ${verification.remaining.map(check=>check.name).join(', ')}`,remaining:verification.remaining});
          };
          await requireVerification();
          const result=await writeTodos({sessionID:input.sessionID,directory:input.directory,todos,invocation:input},async()=>{
            await taskContext.authorizeNativeTodoInvocation(input);await recheck();await requireVerification();
          });
          await recheck();return result;
        }
        const session=await openCodeClient.sessions.get(input.sessionID,{directory:input.directory});
        if(session?.id!==input.sessionID||session.directory!==input.directory||session.time?.archived)throw fail('native_todo_scope_invalid');
        const metadata=await readMetadata({sessionID:session.id,directory:session.directory});
        await taskContext.authorizeNativeTodoInvocation(input);await recheck();
        return readSessionTodo(metadata,session.id)??{items:[],rev:0};
        } finally {
          if (controlLease) await executionHost.nativeManagedControl({ invocation: input, action: 'finish', token: controlLease.token });
        }
      });
    },
    async observeTool(input,context={}) {
      if(!primaryRuntime||typeof instanceID!=='string'||!instanceID)throw fail('native_primary_owner_unavailable');
      if(!['tool_before','tool_after','rejected'].includes(input?.phase))throw fail('native_primary_tool_phase_invalid');
      const recheck=async()=>{context.signal?.throwIfAborted();await admissionOwner.recheckExecution(input);};
      await recheck();
      const [session,primary]=await Promise.all([openCodeClient.sessions.get(input.sessionID,{directory:input.directory}),primaryRuntime.readRecord(input.sessionID)]);
      if(session?.id!==input.sessionID||session.directory!==input.directory||session.time?.archived)throw fail('native_primary_tool_scope_invalid');
      if(session.parentID||!primary){await recheck();return {tracked:false};}
      const assistant=await openCodeClient.sessions.message(input.sessionID,input.messageID,{directory:input.directory});
      const tool=toV1ToolName(input.tool);
      if(primary.sessionID!==session.id||primary.directory!==session.directory||primary.stepID!==input.messageID
        ||assistant?.info?.role!=='assistant'||assistant.info.sessionID!==session.id||assistant.info.id!==input.messageID
        ||assistant.info.time?.completed||assistant.turnOwnership?.source!=='native-sequence'
        ||assistant.turnOwnership.userMessageID!==currentObjectiveUser(primary)||assistant.info.parentID!==currentObjectiveUser(primary)
        ||!assistant.parts?.some(part=>part.type==='tool'&&part.tool===tool&&part.callID===input.callID&&part.state?.status==='running'))throw fail('native_primary_tool_call_stale');
      if(input.phase==='rejected' && (!record(input.rejection)||typeof input.rejection.fingerprint!=='string'
        ||!/^[a-f0-9]{64}$/.test(input.rejection.fingerprint)||typeof input.rejection.reason!=='string'
        ||input.rejection.reason.length>256))throw fail('native_primary_rejection_invalid');
      await recheck();
      const observation={action:input.phase,instanceID,sessionID:session.id,
        assistantMessageID:assistant.info.id,userMessageID:assistant.info.parentID,callID:input.callID,tool,
        // The current core registration, rather than a caller role/tool name,
        // supplies guarded recovery's reviewed native-read proof.
        nativeToolVerified:input.authorization?.input?.provenance?.kind==='native'&&['read','glob','grep'].includes(tool),
        ...(input.phase==='rejected'?input.rejection:{})};
      const result=input.phase==='rejected'
        ? await primaryRuntime.recordRejection(observation,recheck) : await primaryRuntime.plugin(observation);
      await recheck();return result;
    },
    async context(input, context = {}) {
      if (!['context','compaction'].includes(input?.phase)) throw fail('native_context_phase_invalid');
      // This constructor callback binds the actual native runner/context grant.
      // It must return its original live recheck, never accept metadata authority.
      const recheck=await authorizeContext(input);
      if(typeof recheck!=='function')throw fail('native_context_authority_required');
      context.signal?.throwIfAborted();await recheck();
      const session=await openCodeClient.sessions.get(input.sessionID,{directory:input.directory});
      if(session?.id!==input.sessionID||session.directory!==input.directory||session.time?.archived)throw fail('native_context_scope_invalid');
      let result={available:false,reason:'context_phase_has_no_projection'};
      if(input.phase==='compaction') result=await taskContext.compactionAnchor({sessionID:session.id,directory:session.directory});
      else if(typeof getCapabilitySnapshot==='function') {
        const snapshot=await getCapabilitySnapshot({sessionID:session.id,directory:session.directory});
        if(snapshot) result={available:true,text:`[devryan-runtime-capabilities:v1]\n${JSON.stringify(snapshot)}`};
      }
      if(result.available===true && (typeof result.text!=='string'||Buffer.byteLength(result.text)>12*1024))throw fail('native_context_anchor_invalid');
      await recheck();context.signal?.throwIfAborted();return result;
    },
  };
  return owner;
}
