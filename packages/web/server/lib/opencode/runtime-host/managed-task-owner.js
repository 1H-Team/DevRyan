import { createHash } from 'node:crypto';
import { isTerminalManagedTaskStatus, validateRequiredChecks } from '@openchamber/orchestration-runtime';
import { createNativeManagedResultCollection, validateNativeManagedResult } from './native-managed-results.js';

const fail = code => Object.assign(new Error(code), { code, statusCode: 409 });
const text = (value, name) => { if (typeof value !== 'string' || !value.trim()) throw fail(`native_task_${name}_required`); return value.trim(); };
const actionFields = {
  start: ['agent','prompt','label','timeout_seconds','allow_duplicate','required_checks'],
  status: ['task_id'], wait: ['task_id'], wait_any: ['task_ids','after_cursor'], read_result: ['task_id','result_cursor'],
  cancel: ['task_id','reason','cascade'], continue: ['task_id'], abandon: ['task_id'],
  retry: ['task_id','agent','prompt','label','timeout_seconds'], resume: ['task_id','agent','prompt','label','timeout_seconds'],
  plan_read: [], plan_update: ['expected_version','text'], checkpoint: ['query'], decisions: ['query'],
  remember_decision: ['decision','source_message_id','decision_paths','valid_until','supersedes'],
};
const dispositions = new Set(['continue','retry','resume','abandon']);
const liveStatuses = new Set(['queued','starting','running']);
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
  return args;
};

/** Narrow native tool adapter; scheduling, saved-model selection and results
 * remain owned by the existing orchestration runtime. */
export function createNativeManagedTaskOwner({ admissionOwner, taskContext, executionHost, getManagedRuntime }) {
  const collection = createNativeManagedResultCollection();
  return async (input, context = {}) => {
    if (!input || input.tool !== 'devryan_task' || input.authorization?.input?.provenance?.id !== 'devryan.managed-task'
      || input.authorization?.input?.provenance?.kind !== 'plugin') throw fail('native_task_origin_required');
    const recheck = () => admissionOwner.recheckExecution(input);
    await recheck();
    const args = parse(input.input);
    const scope = { rootSessionId: input.sessionID, directory: input.directory, resultMode: 'reference', resultContractVersion: 1 };
    const runtime = getManagedRuntime();
    const authorized = async action => {
      context.signal?.throwIfAborted();
      await taskContext.authorizeNativeTaskInvocation(input);
      await recheck();
      const result = await action();
      await recheck(); context.signal?.throwIfAborted(); return result;
    };
    const barrier = async missingTaskID => {
      const snapshot = await authorized(() => runtime.handleRpc({method:'snapshot',params:scope},context));
      if (snapshot?.available !== true || snapshot.bridgeReady !== true || !Array.isArray(snapshot.tasks)
        || !Array.isArray(snapshot.resultEnvelopes) || snapshot.recoveryWarning != null
        || [...snapshot.tasks,...snapshot.resultEnvelopes].some(value=>value?.rootSessionId!==input.sessionID||value.directory!==input.directory
          || missingTaskID && value.taskId===missingTaskID)) throw fail('native_task_snapshot_invalid');
      const result = await authorized(() => runtime.handleRpc({method:'barrier_status',params:scope},context));
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
      return {state:'stale_task_reference',taskId:taskID,dispositionRequired:false,
        instruction:'The authoritative managed-task barrier is clear. Continue from the last confirmed parent state; do not restart, redispatch or disposition this missing task.'};
    };
    const dispositioned = async result => {
      if (!result.resultEnvelope?.action) return null;
      const current = await barrier(); collection.dispose(scope,result.task.taskId);
      return {...result,state:'already_dispositioned',dispositionRequired:false,barrier:current,
        instruction:'This result was already dispositioned. Follow the current barrier task IDs; do not repeat this wait or disposition.'};
    };
    if (args.action === 'plan_read' || args.action === 'plan_update') {
      return admissionOwner.withPermit(input, async () => {
        await taskContext.authorizeNativePlanInvocation(input);
        await recheck();
        return taskContext.handleNativePlanRpc({ action: args.action, sessionID: input.sessionID, directory: input.directory,
          messageID: input.messageID, callID: input.callID,
          ...(args.action === 'plan_update' ? { expectedVersion: args.expected_version, text: args.text } : {}) }, recheck);
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
      return admissionOwner.withPermit(input, async () => {
        const policy = await taskContext.authorizeNativeTaskInvocation(input);
        // Child registration already requires this real parent control call in
        // the existing ledger. It runs no subprocess and owns no file view.
        const { lease } = await executionHost.nativeManagedControl({ invocation: input, action: 'begin' });
        try {
          return await runtime.handleRpc({ method: 'submit', params: { ...scope, idempotencyKey, agent, prompt,
            label: args.label === undefined ? `Managed ${agent} task` : text(args.label, 'label'),
            dispatchGroupId: input.messageID, dispatchCallId: input.callID, parentTaskId: null,
            mode: 'orchestrator', readOnly: policy.readOnly, providerId: '', modelId: '', variant: null,
            allowDuplicate: args.allow_duplicate === true,
            ...(args.required_checks === undefined ? {} : { requiredChecks: structuredClone(args.required_checks) }),
            ...(args.timeout_seconds === undefined ? {} : { timeoutAt: Date.now() + Math.min(86_400, args.timeout_seconds) * 1000 }) } }, context);
        } finally {
          await executionHost.nativeManagedControl({ invocation: input, action: 'finish', token: lease.token });
        }
      });
    }
    if (args.action === 'wait_any') {
      if (!Array.isArray(args.task_ids) || args.task_ids.length < 1) throw fail('native_task_selection_invalid');
      const taskIDs = [...new Set(args.task_ids.map(id => text(id,'task')))];
      let cursor = args.after_cursor;
      // A stale retained cursor is normalized in a 1ms slice before the
      // single long wait, without changing the sealed model invocation.
      const normalizeCursor = cursor !== undefined;
      for (let slice = 0; slice < (normalizeCursor ? 2 : 1); slice++) {
        const result = await authorized(() => runtime.handleRpc({ method: 'wait_any', params: { ...scope, taskIds: taskIDs,
          ...(cursor === undefined ? {} : { afterCursor: cursor }), waitTimeoutMs: normalizeCursor && slice === 0 ? 1 : 25000 } }, context));
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
        const returned = new Set();
        for (const entry of result.results) {
          const id = entry?.task?.taskId;
          if (!expected.has(id) || returned.has(id)) throw fail('native_task_wait_any_invalid');
          collection.collect(entry,scope,id); returned.add(id);
        }
        if (returned.size !== expected.size) throw fail('native_task_wait_any_invalid');
        for (const value of result.dispositioned ?? []) collection.dispose(scope,value.taskId);
        if (normalizeCursor && slice === 0 && !result.settled
          && !(result.schemaVersion === 2 ? result.changedTaskIds.length : result.readyTaskIds.length || result.attention.length)) {
          cursor = result.cursor; continue;
        }
        // One long bounded slice per private RPC; the native executor remains
        // attached and repeats the unchanged sealed invocation when needed.
        return result;
      }
      throw fail('native_task_wait_any_invalid');
    }
    const params = { ...scope, taskId: text(args.task_id, 'task'),
      ...(args.action === 'cancel' ? { cascade: args.cascade === true, ...(args.reason ? { reason: text(args.reason, 'reason') } : {}) } : {}) };
    if (args.action === 'cancel') return admissionOwner.withPermit(input, () => authorized(() => runtime.handleRpc({ method: 'cancel', params }, context)));
    if (args.action === 'read_result') return admissionOwner.withPermit(input, () => authorized(async () => {
      const cursor = text(args.result_cursor,'result_cursor'); collection.next(scope,params.taskId,cursor);
      const result = await runtime.handleRpc({ method: 'read_result', params: { ...params,resultCursor:cursor } },context);
      await recheck(); collection.acceptPage(scope,params.taskId,cursor,result); return result;
    }));
    if (dispositions.has(args.action)) return admissionOwner.withPermit(input, () => authorized(async () => {
      let current;
      try { current = await runtime.handleRpc({ method: 'status', params },context); }
      catch(error) { return recovered(params.taskId,error); }
      await recheck(); validateNativeManagedResult(current,scope,params.taskId);
      const prior = await dispositioned(current); if (prior) return prior;
      collection.assertDisposition(scope,params.taskId,args.action,current);
      const result = await runtime.handleRpc({ method: 'acknowledge', params: { ...params,action:args.action,
        idempotencyKey:createHash('sha256').update(JSON.stringify([input.sessionID,input.messageID,input.callID,args])).digest('hex'),
        ...(args.agent === undefined ? {} : {agent:text(args.agent,'agent')}),
        ...(args.prompt === undefined ? {} : {prompt:text(args.prompt,'prompt')}),
        ...(args.label === undefined ? {} : {label:text(args.label,'label')}),
        ...(args.timeout_seconds === undefined ? {} : {timeoutSeconds:args.timeout_seconds}) } },context);
      collection.dispose(scope,params.taskId); return result;
    }));
    {
      context.signal?.throwIfAborted();
      await taskContext.authorizeNativeTaskInvocation(input); await recheck();
      let result;
      try { result = await runtime.handleRpc({ method: args.action, params: { ...params,
        ...(args.action === 'wait' ? { waitTimeoutMs: 25_000 } : {}) } }, context); }
      catch(error) { return recovered(params.taskId,error); }
      await taskContext.authorizeNativeTaskInvocation(input); await recheck();
      validateNativeManagedResult(result,scope,params.taskId);
      const prior = await dispositioned(result); if (prior) return prior;
      if (args.action !== 'wait') return result;
      if (isTerminalManagedTaskStatus(result.task.status)) { collection.collect(result,scope,params.taskId);return result; }
      if (!liveStatuses.has(result.task.status)) throw fail('native_task_wait_status_invalid');
      return result;
    }
  };
}
