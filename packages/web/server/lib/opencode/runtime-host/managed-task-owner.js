import { createHash } from 'node:crypto';
import { isManagedTaskId, isTerminalManagedTaskStatus, MANAGED_TASK_LIVE_STATUSES, validateRequiredChecks, managedToolOutputBudget, assertManagedToolOutputSize } from '@openchamber/orchestration-runtime';
import { createNativeManagedResultCollection, validateNativeManagedResult } from './native-managed-results.js';

const fail = code => Object.assign(new Error(code), { code, statusCode: 409 });
const text = (value, name) => { if (typeof value !== 'string' || !value.trim()) throw fail(`native_task_${name}_required`); return value.trim(); };
const actionFields = {
  start: ['agent','prompt','label','timeout_seconds','allow_duplicate','required_checks'],
  status: ['task_id'], wait: ['task_id'], wait_any: ['task_ids','after_cursor','until'], read_result: ['task_id','result_cursor','reads'],
  cancel: ['task_id','reason','cascade'], continue: ['task_id','task_ids'], abandon: ['task_id'],
  retry: ['task_id','agent','prompt','label','timeout_seconds'], resume: ['task_id','agent','prompt','label','timeout_seconds'],
  plan_read: [], plan_update: ['expected_version','text'], checkpoint: ['query'], decisions: ['query'],
  remember_decision: ['decision','source_message_id','decision_paths','valid_until','supersedes'],
};
const dispositions = new Set(['continue','retry','resume','abandon']);
const selection=value=>{
  if(!Array.isArray(value)||!value.length||value.some(id=>!isManagedTaskId(id))||new Set(value).size!==value.length)throw fail('native_task_selection_invalid');
  return value;
};
const acknowledged=(result,taskID,envelopeID,action)=>result?.resultEnvelope?.taskId===taskID&&result.resultEnvelope.envelopeId===envelopeID&&result.resultEnvelope.action===action
  ||result?.committed===true&&result.taskId===taskID&&result.envelopeId===envelopeID&&result.action===action;
const liveStatuses = new Set(MANAGED_TASK_LIVE_STATUSES);
const parse = args => {
  if (!args || !Object.hasOwn(actionFields,args.action)) throw fail('native_task_action_invalid');
  if (Object.keys(args).some(key => key !== 'action' && !actionFields[args.action].includes(key))) throw fail('native_task_input_invalid');
  for (const field of ['label','agent','prompt','reason','after_cursor','query','decision','source_message_id','supersedes']) {
    if (args[field] !== undefined) text(args[field],field);
  }
  if (args.cascade !== undefined && typeof args.cascade !== 'boolean'
    || args.allow_duplicate !== undefined && typeof args.allow_duplicate !== 'boolean') throw fail('native_task_input_invalid');
  if (args.timeout_seconds !== undefined && (!Number.isSafeInteger(args.timeout_seconds) || args.timeout_seconds <= 0 || args.timeout_seconds > 86400)) throw fail('native_task_timeout_invalid');
  if (args.required_checks !== undefined) validateRequiredChecks(args.required_checks);
  if(args.until!==undefined&&args.until!=='settled')throw fail('native_task_input_invalid');
  return args;
};

/** Narrow native tool adapter; scheduling, saved-model selection and results
 * remain owned by the existing orchestration runtime. */
export function createNativeManagedTaskOwner({ admissionOwner, taskContext, executionHost, getManagedRuntime, readToolOutputLimits, readResultPublication }) {
  const collection = createNativeManagedResultCollection();
  return async (input, context = {}) => {
    if (!input || input.tool !== 'devryan_task' || input.authorization?.input?.provenance?.id !== 'devryan.managed-task'
      || input.authorization?.input?.provenance?.kind !== 'plugin') throw fail('native_task_origin_required');
    if (input.input?.action === 'start') context = { ...context, signal: context.signal
      ? AbortSignal.any([context.signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000) };
    const recheck = async () => {
      context.signal?.throwIfAborted();
      await admissionOwner.recheckExecution(input);
      context.signal?.throwIfAborted();
    };
    await recheck();
    const args = parse(input.input);
    const maxOutputBytes = managedToolOutputBudget(await readToolOutputLimits?.(input));
    const scope = { rootSessionId: input.sessionID, directory: input.directory, resultMode: 'reference', resultContractVersion: readResultPublication ? 2 : 1, maxOutputBytes };
    const ownedRuntime = getManagedRuntime();
    const runtime = { handleRpc: async (request, rpcContext) => assertManagedToolOutputSize(await ownedRuntime.handleRpc(request, rpcContext), maxOutputBytes) };
    const authorized = async action => {
      context.signal?.throwIfAborted();
      await taskContext.authorizeNativeTaskInvocation(input);
      await recheck();
      const result = await admissionOwner.withManagedTaskCatalogInvocation(input, action);
      await recheck(); context.signal?.throwIfAborted(); return result;
    };
    const publication=async(taskIDs=[])=>{
      if(!readResultPublication)return undefined;
      const value=await readResultPublication(input,{messageIDs:collection.publicationMessageIDs(scope,taskIDs)});await recheck();return value;
    };
    const delivered=async(result,taskIDs)=>{
      assertManagedToolOutputSize(result,maxOutputBytes);
      if(readResultPublication&&taskIDs.length){
        const snapshot=await publication(taskIDs);collection.stagePublication(scope,taskIDs,input,snapshot.identity,result);
      }
      return result;
    };
    const published=async(taskID,review=false)=>{
      if(readResultPublication)collection.assertPublished(scope,taskID,await publication([taskID]),review);
    };
    const resultRead=action=>admissionOwner.withManagedResultRead?admissionOwner.withManagedResultRead(input,action):action();
    const barrierRead=action=>dispositions.has(args.action)?action():resultRead(action);
    const acknowledgementIdentity=async(taskID,envelopeID,action)=>{
      if(!readResultPublication)return undefined;
      const snapshot=await publication([taskID]);
      return createHash('sha256').update(JSON.stringify([scope.rootSessionId,scope.directory,taskID,envelopeID,action,
        snapshot.identity.objectiveID,snapshot.identity.cancellationGeneration])).digest('hex');
    };
    const reviewContext=(taskID,envelopeID,action,identity)=>identity===undefined?context:{...context,nativeResultReview:{taskId:taskID,envelopeId:envelopeID,
      action,acknowledgementIdentity:identity,recheck:async()=>{
        await taskContext.authorizeNativeTaskInvocation(input);await recheck();await published(taskID,true);
        if(await acknowledgementIdentity(taskID,envelopeID,action)!==identity)throw fail('native_task_publication_scope_changed');
      }}};
    const barrier = async missingTaskID => {
      const snapshot = await barrierRead(()=>authorized(() => ownedRuntime.handleRpc({method:'snapshot',params:scope},context)));
      if (snapshot?.available !== true || snapshot.bridgeReady !== true || !Array.isArray(snapshot.tasks)
        || !Array.isArray(snapshot.resultEnvelopes) || snapshot.recoveryWarning != null
        || [...snapshot.tasks,...snapshot.resultEnvelopes].some(value=>value?.rootSessionId!==input.sessionID||value.directory!==input.directory
          || missingTaskID && value.taskId===missingTaskID)) throw fail('native_task_snapshot_invalid');
      const result = await barrierRead(()=>authorized(() => ownedRuntime.handleRpc({method:'barrier_status',params:scope},context)));
      if (!['clear','active','awaiting_acknowledgement'].includes(result?.state)
        || !Array.isArray(result.taskIds) || result.taskIds.some(id=>typeof id!=='string'||!id)
        || (result.state==='clear') !== (result.taskIds.length===0)) throw fail('native_task_barrier_invalid');
      return {state:result.state,taskIds:result.taskIds};
    };
    const recovered = async (taskID,error) => {
      if (error?.code !== 'task_not_found') throw error;
      const current = await barrier(taskID);
      if (current.state !== 'clear') throw error;
      collection.dispose(scope,taskID);
      return assertManagedToolOutputSize({state:'stale_task_reference',taskId:taskID,dispositionRequired:false,
        instruction:'The authoritative managed-task barrier is clear. Continue from the last confirmed parent state; do not restart, redispatch or disposition this missing task.'},maxOutputBytes);
    };
    const dispositioned = async result => {
      if (!result.resultEnvelope?.action) return null;
      const current = await barrier(); collection.dispose(scope,result.task.taskId);
      return assertManagedToolOutputSize({...scope.resultContractVersion===2?{taskId:result.task.taskId,envelopeId:result.resultEnvelope.envelopeId,action:result.resultEnvelope.action}:result,
        state:'already_dispositioned',dispositionRequired:false,barrier:current,
        instruction:'This result was already dispositioned. Follow the current barrier task IDs; do not repeat this wait or disposition.'},maxOutputBytes);
    };
    if (args.action === 'plan_read' || args.action === 'plan_update') {
      return admissionOwner.withPermit(input, async () => {
        await taskContext.authorizeNativePlanInvocation(input);
        await recheck();
        return taskContext.handleNativePlanRpc({ action: args.action, sessionID: input.sessionID, directory: input.directory,
          messageID: input.messageID, callID: input.callID,
          ...(args.action === 'plan_update' ? { expectedVersion: args.expected_version, text: args.text } : {}) }, recheck, { maxBytes: maxOutputBytes });
      });
    }
    await taskContext.authorizeNativeTaskInvocation(input);
    if (['checkpoint','decisions','remember_decision'].includes(args.action)) {
      return admissionOwner.withPermit(input, () => authorized(() => taskContext.handleNativeContextRpc({ action: args.action,
        sessionID: input.sessionID, directory: input.directory, query: args.query, statement: args.decision,
        sourceMessageID: args.source_message_id, paths: args.decision_paths, validUntil: args.valid_until, supersedes: args.supersedes }, async () => {
          await taskContext.authorizeNativeTaskInvocation(input); await recheck();
        })));
    }
    if (args.action === 'start') {
      const agent = text(args.agent, 'agent'), prompt = text(args.prompt, 'prompt');
      if (args.timeout_seconds !== undefined && (!Number.isSafeInteger(args.timeout_seconds) || args.timeout_seconds <= 0)) throw fail('native_task_timeout_invalid');
      if (args.allow_duplicate !== undefined && typeof args.allow_duplicate !== 'boolean') throw fail('native_task_input_invalid');
      const idempotencyKey = createHash('sha256').update(JSON.stringify([input.sessionID, input.messageID, input.callID, args])).digest('hex');
      const policy = await taskContext.authorizeNativeTaskInvocation(input);
      const params = { ...scope, idempotencyKey, agent, prompt,
        label: args.label === undefined ? `Managed ${agent} task` : text(args.label, 'label'),
        dispatchGroupId: input.messageID, dispatchCallId: input.callID, parentTaskId: null,
        mode: 'orchestrator', readOnly: policy.readOnly, providerId: '', modelId: '', variant: null,
        allowDuplicate: args.allow_duplicate === true,
        ...(args.required_checks === undefined ? {} : { requiredChecks: structuredClone(args.required_checks) }),
        ...(args.timeout_seconds === undefined ? {} : { timeoutAt: Date.now() + Math.min(86_400, args.timeout_seconds) * 1000 }) };
      let committedStart;
      const commit = () => admissionOwner.withPermit(input, async () => {
        const currentPolicy = await taskContext.authorizeNativeTaskInvocation(input);
        if (JSON.stringify(currentPolicy) !== JSON.stringify(policy)) throw fail('native_task_policy_changed');
        await recheck();
        // Child registration already requires this real parent control call in
        // the existing ledger. It runs no subprocess and owns no file view.
        const { lease } = await executionHost.nativeManagedControl({ invocation: input, action: 'begin' });
        try {
          await recheck();
          return await admissionOwner.withManagedTaskCatalogInvocation(input, async () => {
            const result = await runtime.handleRpc({ method: 'submit', params }, {
            ...context, authorizeSubmission: async () => {
              await recheck();
              const latestPolicy = await taskContext.authorizeNativeTaskInvocation(input);
              if (JSON.stringify(latestPolicy) !== JSON.stringify(policy)) throw fail('native_task_policy_changed');
              await recheck();
            },
            });
            const task = result?.task;
            if (isManagedTaskId(task?.taskId)
              && task.rootSessionId === input.sessionID && task.directory === input.directory) {
              committedStart = { committed: true, taskId: task.taskId, rootSessionId: input.sessionID, action: 'start', status: task.status };
            } else if (result?.committed === true && result.action === 'start' && result.rootSessionId === input.sessionID
              && isManagedTaskId(result.taskId)) committedStart = result;
            return result;
          });
        } finally {
          await executionHost.nativeManagedControl({ invocation: input, action: 'finish', token: lease.token });
        }
      });
      try {
        if (typeof ownedRuntime.withSubmissionPreparation !== 'function') return await commit();
        return await authorized(() => ownedRuntime.withSubmissionPreparation(params, context, commit));
      } catch (error) {
        if (committedStart) return assertManagedToolOutputSize({ ...committedStart, projectionError: 'native_task_post_commit_fenced' }, maxOutputBytes);
        throw error;
      }
    }
    if (args.action === 'wait_any') {
      if (!Array.isArray(args.task_ids) || args.task_ids.length < 1) throw fail('native_task_selection_invalid');
      const taskIDs = scope.resultContractVersion===2?selection(args.task_ids):[...new Set(args.task_ids.map(id => text(id,'task')))];
      let cursor = args.after_cursor;
      // A stale retained cursor is normalized in a 1ms slice before the
      // single long wait, without changing the sealed model invocation.
      const normalizeCursor = cursor !== undefined;
      for (let slice = 0; slice < (normalizeCursor ? 2 : 1); slice++) {
        const result = await resultRead(()=>authorized(() => runtime.handleRpc({ method: 'wait_any', params: { ...scope, taskIds: taskIDs,
          ...(args.until===undefined?{}:{until:args.until}),
          ...(cursor === undefined ? {} : { afterCursor: cursor }), waitTimeoutMs: normalizeCursor && slice === 0 ? 1 : 25000 } }, context)));
        await recheck();
        if (result?.rootSessionId !== input.sessionID || typeof result.cursor !== 'string' || !Array.isArray(result.results)
          || !Array.isArray(result.readyTaskIds) || !Array.isArray(result.attention) || !Array.isArray(result.pendingTaskIds)
          || !Array.isArray(result.unacknowledgedTaskIds) || typeof result.settled !== 'boolean'
          || result.settled !== (result.pendingTaskIds.length === 0)) throw fail('native_task_wait_any_invalid');
        if (result.schemaVersion === 2 && (!Array.isArray(result.changedTaskIds) || !Array.isArray(result.dispositioned))) throw fail('native_task_wait_any_invalid');
        const classified = [...result.readyTaskIds,...result.attention.map(value=>value?.taskId),...result.pendingTaskIds,
          ...(result.schemaVersion === 2 ? (result.dispositioned ?? []).map(value=>value?.taskId) : [])];
        if (classified.some(id=>!taskIDs.includes(id)) || new Set(classified).size !== classified.length
          || result.unacknowledgedTaskIds.some(id=>!taskIDs.includes(id))
          || result.schemaVersion === 2 && (!Array.isArray(result.changedTaskIds) || !Array.isArray(result.dispositioned)
            || result.changedTaskIds.some(id=>!taskIDs.includes(id)))) throw fail('native_task_wait_any_invalid');
        const expected = new Set([...result.readyTaskIds,...result.attention.map(value=>value.taskId),...(result.settled?result.unacknowledgedTaskIds:[])]);
        const omitted=result.notReturnedTaskIds??[];
        if(!Array.isArray(omitted)||omitted.length&&(scope.resultContractVersion!==2||new Set(omitted).size!==omitted.length
          ||omitted.some(id=>!expected.has(id))))throw fail('native_task_wait_any_invalid');
        for(const id of omitted)expected.delete(id);
        const returned = new Set();
        for (const entry of result.results) {
          const id = entry?.task?.taskId;
          if (!expected.has(id) || returned.has(id)) throw fail('native_task_wait_any_invalid');
          collection.collect(entry,scope,id,Boolean(readResultPublication)); returned.add(id);
        }
        if (returned.size !== expected.size) throw fail('native_task_wait_any_invalid');
        for (const value of result.dispositioned ?? []) collection.dispose(scope,value.taskId);
        const changedAttention = result.schemaVersion === 2
          ? result.attention.some(value => result.changedTaskIds.includes(value.taskId)) : result.attention.length > 0;
        if (normalizeCursor && slice === 0 && !result.settled
          && (args.until==='settled'?!changedAttention:!(result.schemaVersion === 2 ? result.changedTaskIds.length : result.readyTaskIds.length || result.attention.length))) {
          cursor = result.cursor; continue;
        }
        // One long bounded slice per private RPC; the native executor remains
        // attached and repeats the unchanged sealed invocation when needed.
        return delivered(result,[...returned]);
      }
      throw fail('native_task_wait_any_invalid');
    }
    if(args.action==='read_result'&&args.reads!==undefined)return resultRead(()=>authorized(async()=>{
      if(!readResultPublication||args.task_id!==undefined||args.result_cursor!==undefined||!Array.isArray(args.reads)||!args.reads.length
        ||args.reads.some(read=>!read||Object.keys(read).length!==2||typeof read.result_cursor!=='string'))throw fail('native_task_input_invalid');
      const ids=selection(args.reads.map(read=>read.task_id)),reply={resultContractVersion:2,results:[],failed:[],notProcessed:[]},reads=[];
      assertManagedToolOutputSize({...reply,notProcessed:ids},maxOutputBytes);
      for(const read of args.reads){
        try{await published(read.task_id);collection.next(scope,read.task_id,read.result_cursor);reads.push({taskId:read.task_id,resultCursor:read.result_cursor});}
        catch(error){reply.failed.push({taskId:read.task_id,code:typeof error?.code==='string'&&/^[a-z0-9_]{1,128}$/.test(error.code)?error.code:'native_task_result_read_failed'});}
      }
      if(reads.length){
        const capacity=maxOutputBytes-Buffer.byteLength(JSON.stringify(reply))-256;
        if(capacity<1024)reply.notProcessed.push(...reads.map(read=>read.taskId));
        else{
          const result=await runtime.handleRpc({method:'read_result',params:{...scope,reads,maxOutputBytes:capacity}},context);await recheck();
          if(result?.resultContractVersion!==2||!Array.isArray(result.results)||!Array.isArray(result.failed)||!Array.isArray(result.notProcessed))throw fail('native_task_result_batch_invalid');
          const returned=[...result.results.map(row=>row?.taskId),...result.failed.map(row=>row?.taskId),...result.notProcessed];
          if(returned.length!==reads.length||new Set(returned).size!==returned.length||returned.some(id=>!reads.some(read=>read.taskId===id)))throw fail('native_task_result_batch_invalid');
          reply.results.push(...result.results);reply.failed.push(...result.failed);reply.notProcessed.push(...result.notProcessed);
        }
      }
      assertManagedToolOutputSize(reply,maxOutputBytes);
      if(reply.results.length){
        const snapshot=await publication(reply.results.map(row=>row.taskId));
        collection.acceptPublishedPages(scope,reply.results.map(row=>({taskID:row.taskId,
          cursor:args.reads.find(read=>read.task_id===row.taskId).result_cursor,result:row})),input,snapshot.identity,reply);
      }
      return reply;
    }));
    if(args.action==='continue'&&args.task_ids!==undefined){
      if(!readResultPublication||args.task_id!==undefined)throw fail('native_task_input_invalid');
      const ids=selection(args.task_ids),reply={resultContractVersion:2,committed:[],failed:[],notProcessed:[...ids]};
      assertManagedToolOutputSize(reply,maxOutputBytes);
      for(const taskID of ids){
        if(context.signal?.aborted)break;
        const rest=reply.notProcessed.slice(1);
        let committedReceipt;
        try{
          const params={...scope,taskId:taskID},current=await authorized(()=>runtime.handleRpc({method:'status',params},context));
          validateNativeManagedResult(current,scope,taskID);
          const envelopeID=current.resultEnvelope?.envelopeId;if(typeof envelopeID!=='string')throw fail('native_task_result_envelope_required');
          const identity=await acknowledgementIdentity(taskID,envelopeID,'continue');
          if(current.resultEnvelope.action!==null){
            if(current.resultEnvelope.action!=='continue'||current.resultEnvelope.acknowledgementIdentity!==identity)throw fail('native_task_disposition_conflict');
          }else{await published(taskID,true);collection.assertDisposition(scope,taskID,'continue',current);}
          const receipt={taskId:taskID,envelopeId:envelopeID,action:'continue'};
          try{
            assertManagedToolOutputSize({...reply,committed:[...reply.committed,receipt],notProcessed:rest},maxOutputBytes);
            assertManagedToolOutputSize({...reply,failed:[...reply.failed,{taskId:taskID,code:'x'.repeat(128)}],notProcessed:rest},maxOutputBytes);
          }catch{break;}
          if(current.resultEnvelope.action===null)await admissionOwner.withPermit(input,()=>authorized(async()=>{
            const result=await runtime.handleRpc({method:'acknowledge',params:{...params,action:'continue',idempotencyKey:identity,acknowledgementIdentity:identity}},reviewContext(taskID,envelopeID,'continue',identity));
            if(!acknowledged(result,taskID,envelopeID,'continue'))throw fail('native_task_acknowledgement_unconfirmed');
            committedReceipt=receipt;return result;
          }));
          else committedReceipt=receipt;
          collection.dispose(scope,taskID);reply.committed.push(receipt);reply.notProcessed=rest;
        }catch(error){
          if(committedReceipt){collection.dispose(scope,taskID);reply.committed.push(committedReceipt);reply.notProcessed=rest;continue;}
          const code=typeof error?.code==='string'&&/^[a-z0-9_]{1,128}$/.test(error.code)?error.code:'native_task_continue_failed';
          const failed={taskId:taskID,code};
          try{assertManagedToolOutputSize({...reply,failed:[...reply.failed,failed],notProcessed:rest},maxOutputBytes);}catch{break;}
          reply.failed.push(failed);reply.notProcessed=rest;
        }
      }
      return assertManagedToolOutputSize(reply,maxOutputBytes);
    }
    const params = { ...scope, taskId: text(args.task_id, 'task'),
      ...(args.action === 'cancel' ? { cascade: args.cascade === true, ...(args.reason ? { reason: text(args.reason, 'reason') } : {}) } : {}) };
    if (args.action === 'cancel') return admissionOwner.withPermit(input, () => authorized(() => runtime.handleRpc({ method: 'cancel', params }, context)));
    if (args.action === 'read_result') return resultRead(() => authorized(async () => {
      const cursor = text(args.result_cursor,'result_cursor'); await published(params.taskId);collection.next(scope,params.taskId,cursor);
      const result = await runtime.handleRpc({ method: 'read_result', params: { ...params,resultCursor:cursor } },context);
      await recheck(); assertManagedToolOutputSize(result,maxOutputBytes);
      if(readResultPublication){
        const snapshot=await publication([params.taskId]);
        collection.acceptPublishedPages(scope,[{taskID:params.taskId,cursor,result}],input,snapshot.identity,result);
      }else collection.acceptPage(scope,params.taskId,cursor,result);
      return result;
    }));
    if (dispositions.has(args.action)) {
      let committedReceipt;
      try{return await admissionOwner.withPermit(input, () => authorized(async () => {
      let current;
      try { current = await runtime.handleRpc({ method: 'status', params },context); }
      catch(error) { return recovered(params.taskId,error); }
      await recheck(); validateNativeManagedResult(current,scope,params.taskId);
      const identity=await acknowledgementIdentity(params.taskId,current.resultEnvelope?.envelopeId,args.action);
      if(current.resultEnvelope?.action&&(current.resultEnvelope.action!==args.action||identity!==undefined&&current.resultEnvelope.acknowledgementIdentity!==identity))throw fail('native_task_disposition_conflict');
      const prior = await dispositioned(current); if (prior) return prior;
      await published(params.taskId,true);
      collection.assertDisposition(scope,params.taskId,args.action,current);
      const result = await runtime.handleRpc({ method: 'acknowledge', params: { ...params,action:args.action,
        idempotencyKey:identity??createHash('sha256').update(JSON.stringify([input.sessionID,input.messageID,input.callID,args])).digest('hex'),
        ...(identity===undefined?{}:{acknowledgementIdentity:identity}),
        ...(args.agent === undefined ? {} : {agent:text(args.agent,'agent')}),
        ...(args.prompt === undefined ? {} : {prompt:text(args.prompt,'prompt')}),
        ...(args.label === undefined ? {} : {label:text(args.label,'label')}),
        ...(args.timeout_seconds === undefined ? {} : {timeoutSeconds:args.timeout_seconds}) } },reviewContext(params.taskId,current.resultEnvelope.envelopeId,args.action,identity));
      if(readResultPublication){
        if(!acknowledged(result,params.taskId,current.resultEnvelope.envelopeId,args.action))throw fail('native_task_acknowledgement_unconfirmed');
        committedReceipt={committed:true,taskId:params.taskId,envelopeId:current.resultEnvelope.envelopeId,action:args.action};
      }
      collection.dispose(scope,params.taskId); return result;
    }));}catch(error){if(committedReceipt)return assertManagedToolOutputSize({...committedReceipt,projectionError:'native_task_post_commit_fenced'},maxOutputBytes);throw error;}
    }
    {
      context.signal?.throwIfAborted();
      await taskContext.authorizeNativeTaskInvocation(input); await recheck();
      let result;
      try { result = await resultRead(()=>runtime.handleRpc({ method: args.action, params: { ...params,
        ...(args.action === 'wait' ? { waitTimeoutMs: 25_000 } : {}) } }, context)); }
      catch(error) { return recovered(params.taskId,error); }
      await taskContext.authorizeNativeTaskInvocation(input); await recheck();
      validateNativeManagedResult(result,scope,params.taskId);
      const prior = await dispositioned(result); if (prior) return prior;
      if (args.action !== 'wait') return result;
      if (isTerminalManagedTaskStatus(result.task.status)) { collection.collect(result,scope,params.taskId,Boolean(readResultPublication));return delivered(result,[params.taskId]); }
      if (!liveStatuses.has(result.task.status)) throw fail('native_task_wait_status_invalid');
      return result;
    }
  };
}
