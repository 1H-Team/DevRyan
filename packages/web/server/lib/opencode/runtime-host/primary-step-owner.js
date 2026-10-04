import { currentObjectiveUser } from '@openchamber/harness-runtime/lib/objective-identity.js';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

const fail = () => Object.assign(new Error('native_primary_step_invalid'), { code: 'native_primary_step_invalid', status: 403, statusCode: 403 });
/** One recipe for the retry/Step witness; tokens remain private bridge handles.
 * @param {Pick<import('./native-admission-contract.js').OperationPermit,'token'>} permit
 * @returns {string}
 */
export const nativeStepPermitSha256=permit=>{
  if(typeof permit?.token!=='string'||!permit.token)throw fail();
  return createHash('sha256').update(permit.token).digest('hex');
};

/** Completes the native durable event handoff before its tools can execute. */
export function createNativePrimaryStepOwner({ admissionOwner, openCodeClient, primaryRuntime, instanceID, getInstanceID, allowStopHandoff=false }) {
  let handshake;
  const track=async(step,recheck,expectedUserID,witness,allowStoppedHandoff=false)=>{
      const session = await openCodeClient.sessions.get(step.sessionID);
      if (!session || session.id !== step.sessionID || typeof session.directory !== 'string') throw fail();
      const directory = session.directory;
      const [assistant, existingPrimary] = await Promise.all([
        openCodeClient.sessions.message(step.sessionID, step.assistantMessageID, { directory }),
        primaryRuntime.readRecord(step.sessionID),
      ]);
      if (session?.directory !== directory || session.id !== step.sessionID || session.time?.archived
        || assistant?.info?.sessionID !== step.sessionID || assistant.info.id !== step.assistantMessageID
        || assistant.info.role !== 'assistant' || assistant.info.time?.completed
        || assistant.turnOwnership?.source !== 'native-sequence'
        || assistant.turnOwnership.userMessageID !== assistant.info.parentID
        || expectedUserID!==undefined&&assistant.info.parentID!==expectedUserID
        || assistant.info.agent !== step.agent || assistant.info.providerID !== step.model?.providerID
        || assistant.info.modelID !== step.model?.id) throw fail();
      const acknowledge = () => admissionOwner.acknowledgeStartedContinuation({ sessionID: session.id,
        userMessageID: assistant.info.parentID, assistantMessageID: assistant.info.id });
      if (session.parentID || !existingPrimary) {
        await recheck();
        await acknowledge();
        return { tracked: false };
      }
      let primary = existingPrimary;
      const selected=primary.recoveryID&&primary.recoveryExecution?primary.recoveryExecution:primary;
      if (primary.directory !== directory || primary.sessionID !== session.id
        || selected.agent !== step.agent || selected.providerID !== assistant.info.providerID
        || selected.modelID !== assistant.info.modelID || selected.variant !== (assistant.info.variant ?? null)) throw fail();
      await (handshake ??= primaryRuntime.helloNative({ policyVersion: 1, instanceID },{authorize:recheck,isCurrent:()=>!getInstanceID||getInstanceID()===instanceID})
        .catch(error => { handshake = undefined; throw error; }));
      const execution = { providerID: assistant.info.providerID, modelID: assistant.info.modelID,
        agent: assistant.info.agent, variant: assistant.info.variant ?? null };
      if (currentObjectiveUser(primary) !== assistant.info.parentID) {
        if (typeof primaryRuntime.adoptOwnedNativeContinuation !== 'function') throw fail();
        await recheck();
        primary = await primaryRuntime.adoptOwnedNativeContinuation({ instanceID, sessionID: session.id,
          userMessageID: assistant.info.parentID, assistantMessageID: assistant.info.id, execution });
        if (currentObjectiveUser(primary) !== assistant.info.parentID) throw fail();
      }
      await recheck();
      try {
        await primaryRuntime.plugin({ action: 'step', instanceID, sessionID: session.id,
          userMessageID: assistant.info.parentID, assistantMessageID: assistant.info.id,
          execution,...witness });
      } catch (error) {
        if (!allowStoppedHandoff || error?.code !== 'provider_recovery_fenced') throw error;
        const stopped = await primaryRuntime.readRecord(session.id);
        const lineage = record => Object.fromEntries(['sessionID','directory','anchorID','objectiveID','activeUserID',
          'providerID','modelID','agent','variant','recoveryID','recoveryExecution','nativeFallback','nativeContinuation','tools','owner']
          .map(key => [key, record?.[key]]));
        if (!stopped || ['cancelled','superseded','completed'].includes(primary.state) || stopped.state !== 'cancelled' || stopped.reason !== 'stop'
          || !Number.isSafeInteger(primary.cancellationGeneration)
          || stopped.cancellationGeneration !== primary.cancellationGeneration + 1
          || currentObjectiveUser(stopped) !== assistant.info.parentID
          || !isDeepStrictEqual(lineage(stopped), lineage(primary))
          || getInstanceID && getInstanceID() !== instanceID) throw error;
        // The real Stop fence can reach this handoff before Session.interrupt.
        // It authorizes interruption only, never tools or continuation admission.
        const currentAssistant = await openCodeClient.sessions.message(session.id, assistant.info.id, { directory });
        if (!currentAssistant || !isDeepStrictEqual(currentAssistant.info, assistant.info)
          || !isDeepStrictEqual(currentAssistant.turnOwnership, assistant.turnOwnership)) throw error;
        await recheck();
        const confirmed = await primaryRuntime.readRecord(session.id);
        if (!isDeepStrictEqual(confirmed, stopped)) throw error;
        if (getInstanceID && getInstanceID() !== instanceID) throw error;
        return { tracked: false, stop: { sessionID: session.id, assistantMessageID: assistant.info.id } };
      }
      await recheck();
      await acknowledge();
      return { tracked: true };
  };
  const native=async ({ permit, event, attempt }) => {
    const step=event?.data;
    if(event?.type!=='session.step.started'||typeof step?.sessionID!=='string'||typeof step.assistantMessageID!=='string'
      ||typeof step.agent!=='string'||!Number.isSafeInteger(event.durable?.seq)||event.durable.seq<1||event.durable.aggregateID!==step.sessionID)throw fail();
    if(attempt!==undefined&&attempt!==null&&(typeof attempt.traceID!=='string'||!attempt.traceID||typeof attempt.spanID!=='string'||!attempt.spanID))throw fail();
    const witness=attempt?{nativeAttempt:{traceID:attempt.traceID,spanID:attempt.spanID},nativePermitSha256:nativeStepPermitSha256(permit)}:undefined;
    const authorized=await admissionOwner.handleRpc('native.admission.authorize',{
      operation:'primary.step',sessionID:step.sessionID,input:event,existingPermit:permit,
    });
    const recheck=()=>admissionOwner.handleRpc('native.admission.recheck',{permit:authorized,request:{operation:'primary.step',sessionID:step.sessionID}});
    try{return await track(step,recheck,undefined,witness,allowStopHandoff===true);}finally{
      if (authorized.token !== permit?.token) await admissionOwner.handleRpc('native.admission.release', authorized);
    }
  };
  // Constructor-only external process scope has already persisted the actual
  // native assistant. It shares canonical primary tracking, never runner authority.
  native.external=(scope,recheck)=>track({sessionID:scope.sessionID,assistantMessageID:scope.assistantMessageID,
    agent:scope.agent,model:{providerID:'cursor-acp',id:scope.modelID}},recheck,scope.userMessageID);
  return native;
}
