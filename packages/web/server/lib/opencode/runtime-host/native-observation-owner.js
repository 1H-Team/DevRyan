import { parseNativeObservation } from './native-observation-contract.js';

const failure = code => Object.assign(new Error(code), {code,statusCode:403});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function createNativeObservationOwner(options) {
  const gap = input => {
    const bounded=value=>typeof value==='string'&&value.length<=256&&!/[\0\r\n]/.test(value)?value:undefined;
    try { options.recordDiagnostic?.({type:'gap',event:'native_observation_gap',sessionID:bounded(input?.sessionID),
      payload:{stage:bounded(input?.stage),code:'native_observation_gap'}}); }
    catch { /* The original journal reports its own write/drop failure. */ }
  };
  const current = () => {
    if (!options.isReady() || options.controller()?.instanceID !== options.instanceID) throw failure('native_observation_controller_expired');
  };
  const write = observation => {
    current();
    const payload = parseNativeObservation(observation);
    if (payload.controllerInstanceID !== options.instanceID || payload.configurationDigest !== options.snapshot.digest
      || !options.snapshot.locations.some(row => row.directory === payload.directory)) throw failure('native_observation_binding_invalid');
    if (typeof options.recordDiagnostic !== 'function' || options.recordDiagnostic({type:'lifecycle',event:'native_observation',
      sessionID:payload.sessionID,directory:payload.directory,payload}) === false) throw failure('native_observation_gap');
    return null;
  };
  const observeAcceptedUser = input => {
    try { return write({schema:1,stage:'accepted-user',controllerInstanceID:options.instanceID,
      configurationDigest:options.snapshot.digest,...input}); }
    catch { gap({sessionID:input?.sessionID,stage:'accepted-user'}); return null; }
  };
  const handleRpc = async (method,input) => {
    if (method !== 'native.observation' || !object(input) || Object.keys(input).some(key=>!['controllerInstanceID','permit','observation'].includes(key))
      || input.controllerInstanceID !== options.instanceID || !object(input.observation)) throw failure('native_observation_invalid');
    current();
    let observation;
    const step = input.observation.stage === 'step-link';
    // Canonical parent identity belongs to the Node store owner. The controller
    // cannot fill or guess it, even though it owns the actual Bus publication.
    if (step && Object.hasOwn(input.observation,'userMessageID')) throw failure('native_observation_invalid');
    observation = parseNativeObservation(step ? {...input.observation,userMessageID:'unlinked'} : input.observation);
    if (!['model-prepared','physical','provider-refusal','step-link','compaction-trigger','compaction-outcome','compaction-event'].includes(observation.stage)) throw failure('native_observation_invalid');
    try { return await options.admissionOwner.withProviderAttempt({directory:observation.directory,sessionID:observation.sessionID,
      permit:input.permit,kind:step?'primary':'kind' in observation?observation.kind:'compaction'},async recheck=>{
      if (step) {
        const assistant=await options.openCodeClient.sessions.message(observation.sessionID,observation.assistantMessageID,{directory:observation.directory});
        const info=assistant?.info;
        if (!info || info.id !== observation.assistantMessageID || info.sessionID !== observation.sessionID || info.role !== 'assistant'
          || assistant.turnOwnership?.source !== 'native-sequence' || typeof info.parentID !== 'string'
          || assistant.turnOwnership.userMessageID !== info.parentID || info.agent !== observation.execution.agent
          || info.providerID !== observation.execution.providerID || info.modelID !== observation.execution.modelID
          // Native model switching uses variant ?? 'default'; projection
          // passes explicit "default" through (messages.js LOSS register).
          || (info.variant ?? 'default') !== (observation.execution.variant ?? 'default')) throw failure('native_observation_step_invalid');
        observation={...observation,userMessageID:info.parentID};
      }
      await recheck(); current();
      const written = write(observation);
      // Turn timing only, after the committed journal write.
      try { options.onObservation?.(observation); } catch { /* Observer only. */ }
      return written;
    }); } catch(cause) { gap(observation); throw cause; }
  };
  return {observeAcceptedUser,handleRpc};
}
