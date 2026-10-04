import { createHash } from 'node:crypto';
import { isTerminalManagedTaskStatus } from '@openchamber/orchestration-runtime';
import { createNativeManagedResultCollection, validateNativeManagedResult } from './native-managed-results.js';

const fail = code => Object.assign(new Error(code), { code, statusCode: 409 });
const text = value => typeof value === 'string' && value.trim().length > 0;
const promptFor = prompt => ['You are one councillor in a multi-model council.',
  'Answer independently and concisely. Do not ask follow-up questions.',
  'State assumptions and uncertainty when needed.', '', prompt].join('\n');

/** Council dispatch shares the managed scheduler and real parent control call.
 * Configuration, never tool payload, supplies ordered member selections. */
export function createNativeCouncilOwner({ admissionOwner, taskContext, executionHost, getManagedRuntime, readCouncilMembers }) {
  return async (input, context = {}) => {
    if (input?.tool !== 'council_session' || input.authorization?.input?.provenance?.kind !== 'plugin'
      || input.authorization.input.provenance.id !== 'devryan.council') throw fail('native_council_origin_required');
    const args = input.input;
    if (!args || !text(args.prompt) || args.preset !== undefined && !text(args.preset)
      || Object.keys(args).some(key => !['prompt','preset'].includes(key))) throw fail('native_council_input_invalid');
    const recheck = async () => { context.signal?.throwIfAborted(); await admissionOwner.recheckExecution(input); };
    await recheck(); await taskContext.authorizeNativeTaskInvocation(input);
    const preset = args.preset?.trim() ?? 'default';
    const configured = await readCouncilMembers({ directory: input.directory, sessionID: input.sessionID, preset });
    if (!Array.isArray(configured) || !configured.length) throw fail('native_council_members_required');
    const members = configured.map(member => {
      if (!text(member?.providerId) || !text(member.modelId) || member.variant !== undefined && member.variant !== null && !text(member.variant)
        || member.agent !== undefined && !text(member.agent)
        || member.timeoutMs !== undefined && (!Number.isSafeInteger(member.timeoutMs) || member.timeoutMs <= 0)) throw fail('native_council_member_invalid');
      return { providerId: member.providerId, modelId: member.modelId, variant: member.variant ?? null,
        agent: member.agent ?? 'builder', timeoutMs: member.timeoutMs ?? 180000 };
    });
    const runtime = getManagedRuntime(), scope = { directory: input.directory, rootSessionId: input.sessionID,
      resultMode: 'reference', resultContractVersion: 1 };
    const dispatched = await admissionOwner.withPermit(input, async () => {
      const policy = await taskContext.authorizeNativeTaskInvocation(input); await recheck();
      const { lease } = await executionHost.nativeManagedControl({ invocation: input, action: 'begin' });
      try {
        return await Promise.allSettled(members.map(async (member,index) => {
          await recheck();
          const idempotencyKey = `council:${createHash('sha256').update(JSON.stringify([input.sessionID,input.messageID,input.callID,index,member,args])).digest('hex')}`;
          const result = await runtime.handleRpc({ method:'submit', params:{...scope, idempotencyKey,
            dispatchGroupId:input.messageID,dispatchCallId:input.callID,parentTaskId:null,mode:'orchestrator',readOnly:policy.readOnly,
            providerId:member.providerId,modelId:member.modelId,variant:member.variant,agent:member.agent,
            label:`Counsellor ${index+1}: ${member.providerId}/${member.modelId}${member.variant?` (${member.variant})`:''}`,
            prompt:promptFor(args.prompt.trim()),deadlineClass:'council',timeoutAt:Date.now()+member.timeoutMs } },context);
          const taskID = result?.task?.taskId;
          if (!text(taskID)) throw fail('native_council_task_identity_required');
          return taskID;
        }));
      } finally { await executionHost.nativeManagedControl({invocation:input,action:'finish',token:lease.token}); }
    });
    // Long waits do not hold web admission locks: Stop and removal retain the
    // existing scheduler's cancellation authority while each slice rechecks.
    const results = await Promise.allSettled(dispatched.map(async (dispatch,index) => {
      if (dispatch.status === 'rejected') throw dispatch.reason;
      const taskID = dispatch.value, collection = createNativeManagedResultCollection();
      let result;
      for (;;) {
        await recheck(); await taskContext.authorizeNativeTaskInvocation(input); await recheck();
        result = await runtime.handleRpc({method:'wait',params:{...scope,taskId:taskID,waitTimeoutMs:25000}},context);
        await recheck(); validateNativeManagedResult(result,scope,taskID);
        if (isTerminalManagedTaskStatus(result.task.status)) break;
      }
      collection.collect(result,scope,taskID);
      let reference = result.resultReference, body = reference?.text ?? '';
      while (reference && !reference.complete) {
        await recheck(); const cursor = reference.nextCursor;
        const next = await runtime.handleRpc({method:'read_result',params:{...scope,taskId:taskID,resultCursor:cursor}},context);
        await recheck(); collection.acceptPage(scope,taskID,cursor,next);
        reference = next.resultReference; body += reference.text;
      }
      const response = reference ? body : typeof result.resultEnvelope?.recoverablePreview === 'string'
        ? result.resultEnvelope.recoverablePreview : '';
      return { seat:index+1,taskId:taskID,providerId:members[index].providerId,modelId:members[index].modelId,variant:members[index].variant,
        status:result.task.status,response:response || 'No assistant response was recorded.',partial:result.resultEnvelope.partial,
        failureReason:result.resultEnvelope.failureReason ?? null,resultEnvelope:result.resultEnvelope,
        ...(result.resultHeader?{resultHeader:result.resultHeader}:{}) };
    }));
    await recheck(); await taskContext.authorizeNativeTaskInvocation(input); await recheck();
    return { preset, results:results.map((value,index)=>value.status==='fulfilled'?value.value:{seat:index+1,
      ...(dispatched[index].status==='fulfilled'?{taskId:dispatched[index].value}:{}),
      providerId:members[index].providerId,modelId:members[index].modelId,variant:members[index].variant,status:'failed',
      response:value.reason?.code ?? 'native_council_member_failed',partial:true}),
      disposition:'unacknowledged' };
  };
}
