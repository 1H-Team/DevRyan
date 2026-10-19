import { createHash } from 'node:crypto';
import { currentObjectiveUser } from '@devryan/harness-runtime/lib/objective-identity.js';
import { parseNativePresentation } from './native-observation-contract.js';
import { parseNativeObservation } from './native-observation-contract.js';

const failure = code => Object.assign(new Error(code), {code,statusCode:403});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function createNativeObservationOwner(options) {
  // Observation-only association. Never exported or used for execution. A
  // missing/evicted request is a diagnostic gap, never substitute authority.
  const helperRequests=new Map();
  const primaryRequests=new Map(),steps=new Map(),presentationSequences=new Map(),presentations=new Map();
  const ownerID='native:'+options.instanceID;
  let presentationSequence=0,retired=false;
  const attemptKey=attempt=>attempt.traceID+'\0'+attempt.spanID;
  const notify=input=>{try{Promise.resolve(options.onPresentationProgress?.(input)).catch(()=>{});}catch{/* Display must not veto native saves. */}};
  const clearPresentation=sessionID=>{
    const active=presentations.get(sessionID);if(!active)return;
    presentations.delete(sessionID);const {cancellationGeneration:_cancel,...projected}=active;void _cancel;notify({...projected,phase:'cleared',sequence:++presentationSequence});
  };
  const retire=()=>{
    if(retired)return;retired=true;
    for(const sessionID of presentations.keys())clearPresentation(sessionID);
    primaryRequests.clear();steps.clear();presentationSequences.clear();
    try{Promise.resolve(options.onPresentationOwnerRetired?.(ownerID)).catch(()=>{});}catch{/* Observation only. */}
  };
  const presentation=async input=>{
    if(retired||!object(input)||Object.keys(input).some(key=>!['controllerInstanceID','permit','observation'].includes(key))
      ||input.controllerInstanceID!==options.instanceID)throw failure('native_presentation_invalid');
    const value=parseNativePresentation(input.observation);current(value.sessionID);
    if(value.controllerInstanceID!==options.instanceID||value.configurationDigest!==options.snapshot.digest
      ||!options.snapshot.locations.some(row=>row.directory===value.directory)||typeof input.permit?.token!=='string')throw failure('native_presentation_invalid');
    const request=primaryRequests.get(value.sessionID),step=steps.get(value.sessionID+'\0'+value.assistantMessageID+'\0'+attemptKey(value.attempt));
    const same=()=>!retired&&primaryRequests.get(value.sessionID)===request&&request?.requestID===value.requestID
      &&request.token===input.permit.token&&request.revision===input.permit.revision&&request.attempt===attemptKey(value.attempt)
      &&step?.stepID===value.stepID&&step.directory===value.directory&&step.token===input.permit.token&&step.revision===input.permit.revision;
    if(!same()||value.sequence<=(presentationSequences.get(value.sessionID)??0))throw failure('native_presentation_expired');
    presentationSequences.set(value.sessionID,value.sequence);
    const generation=createHash('sha256').update(JSON.stringify([options.instanceID,request.token,request.revision,value.requestID,value.stepID,value.attempt])).digest('hex');
    if(value.phase==='cleared'){
      if(presentations.get(value.sessionID)?.generation===generation)clearPresentation(value.sessionID);
      primaryRequests.delete(value.sessionID);presentationSequences.delete(value.sessionID);steps.delete(value.sessionID+'\0'+value.assistantMessageID+'\0'+attemptKey(value.attempt));
      return null;
    }
    if(typeof options.readPrimaryRecord!=='function')throw failure('native_presentation_unavailable');
    return options.admissionOwner.withProviderAttempt({directory:value.directory,sessionID:value.sessionID,permit:input.permit,kind:'primary'},async recheck=>{
      const assistant=await options.openCodeClient.sessions.message(value.sessionID,value.assistantMessageID,{directory:value.directory});
      const primary=await options.readPrimaryRecord(value.sessionID);
      if(assistant?.info?.id!==value.assistantMessageID||assistant.info.sessionID!==value.sessionID||assistant.info.role!=='assistant'
        ||assistant.info.parentID!==step.userMessageID||assistant.info.error
        ||assistant.turnOwnership?.source!=='native-sequence'||assistant.turnOwnership.userMessageID!==step.userMessageID
        ||primary&&(currentObjectiveUser(primary)!==step.userMessageID||['completed','cancelled','failed','superseded'].includes(primary.state)
          ||!Number.isSafeInteger(primary.cancellationGeneration)||primary.cancellationGeneration<0))throw failure('native_presentation_expired');
      await recheck();current(value.sessionID);
      const confirmed=await options.readPrimaryRecord(value.sessionID);
      if(Boolean(primary)!==Boolean(confirmed)||primary&&(confirmed.cancellationGeneration!==primary.cancellationGeneration
        ||currentObjectiveUser(confirmed)!==currentObjectiveUser(primary)||confirmed.state!==primary.state))throw failure('native_presentation_expired');
      await recheck();current(value.sessionID);
      if(!same()||presentationSequences.get(value.sessionID)!==value.sequence)throw failure('native_presentation_expired');
      const active=presentations.get(value.sessionID);
      if(active&&active.generation===generation&&(value.progress<=active.progress||primary&&active.cancellationGeneration!==primary.cancellationGeneration))return null;
      const projected={provider:'native',ownerID,sessionID:value.sessionID,generation,objectiveID:step.userMessageID,
        assistantID:value.assistantMessageID,stepID:value.stepID,attemptID:value.attempt.traceID+':'+value.attempt.spanID,
        phase:'finalizing',progress:value.progress,sequence:++presentationSequence};
      presentations.set(value.sessionID,{...projected,...primary?{cancellationGeneration:primary.cancellationGeneration}:{}});
      notify(projected);return null;
    });
  };

  const helperKeys=['agent','providerID','modelID','variant','selectionMode','selectionRevision'];
  const gap = input => {
    const bounded=value=>typeof value==='string'&&value.length<=256&&!/[\0\r\n]/.test(value)?value:undefined;
    try { options.recordDiagnostic?.({type:'gap',event:'native_observation_gap',sessionID:bounded(input?.sessionID),
      payload:{stage:bounded(input?.stage),code:'native_observation_gap'}}); }
    catch { /* The original journal reports its own write/drop failure. */ }
  };
  const current = sessionID => {
    if (retired || !options.isReady(sessionID) || options.controller()?.instanceID !== options.instanceID) throw failure('native_observation_controller_expired');
  };
  const write = observation => {
    current(observation.sessionID);
    const payload = parseNativeObservation(observation);
    if (payload.controllerInstanceID !== options.instanceID || payload.configurationDigest !== options.snapshot.digest
      || !options.snapshot.locations.some(row => row.directory === payload.directory)) throw failure('native_observation_binding_invalid');
    if (typeof options.recordDiagnostic !== 'function' || options.recordDiagnostic({type:'lifecycle',event:'native_observation',
      sessionID:payload.sessionID,directory:payload.directory,payload}) === false) throw failure('native_observation_gap');
    return null;
  };
  const observeAcceptedUser = input => {
    clearPresentation(input?.sessionID); primaryRequests.delete(input?.sessionID);presentationSequences.delete(input?.sessionID);
    try { return write({schema:1,stage:'accepted-user',controllerInstanceID:options.instanceID,
      configurationDigest:options.snapshot.digest,...input}); }
    catch { gap({sessionID:input?.sessionID,stage:'accepted-user'}); return null; }
  };
  const handleRpc = async (method,input) => {
    if(method==='native.presentation')return presentation(input);
    if (method !== 'native.observation' || !object(input) || Object.keys(input).some(key=>!['controllerInstanceID','permit','observation'].includes(key))
      || input.controllerInstanceID !== options.instanceID || !object(input.observation)) throw failure('native_observation_invalid');
    current(input.observation.sessionID);
    let observation;
    const step = input.observation.stage === 'step-link';
    // Canonical parent identity belongs to the Node store owner. The controller
    // cannot fill or guess it, even though it owns the actual Bus publication.
    if (step && Object.hasOwn(input.observation,'userMessageID')
      ||Object.hasOwn(input.observation,'helperSelectionMode')||Object.hasOwn(input.observation,'helperSelectionRevision')) throw failure('native_observation_invalid');
    observation = parseNativeObservation(step ? {...input.observation,userMessageID:'unlinked'} : input.observation);
    if (!['model-prepared','physical','provider-refusal','step-link','compaction-trigger','compaction-outcome','compaction-event'].includes(observation.stage)) throw failure('native_observation_invalid');
    try { return await options.admissionOwner.withProviderAttempt({directory:observation.directory,sessionID:observation.sessionID,
      permit:input.permit,kind:step?'primary':'kind' in observation?observation.kind:'compaction'},async (recheck,helper)=>{
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
      await recheck(); current(observation.sessionID);
      if(helper&&(observation.stage==='model-prepared'||observation.stage==='physical')){
        if(observation.kind!=='generate')throw failure('native_observation_helper_invalid');
        if(observation.stage==='model-prepared'&&['agent','providerID','modelID','variant'].some(key=>observation.execution[key]!==helper[key]))throw failure('native_observation_helper_invalid');
        const prepared=helperRequests.get(observation.requestID);
        if(observation.stage==='model-prepared'&&prepared)throw failure('native_observation_helper_request_invalid');
        if(observation.stage==='physical'&&(!prepared||prepared.sessionID!==observation.sessionID||prepared.directory!==observation.directory
          ||prepared.token!==input.permit.token||prepared.revision!==input.permit.revision||prepared.toolCount!==observation.toolCount
          ||helperKeys.some(key=>prepared.helper[key]!==helper[key])))throw failure('native_observation_helper_request_invalid');
        if(['configured','active'].includes(helper.selectionMode)&&typeof helper.selectionRevision==='string')observation={...observation,
          helperSelectionMode:helper.selectionMode,helperSelectionRevision:helper.selectionRevision};
      }
      const written = write(observation);
      if(observation.stage==='model-prepared'&&observation.kind==='primary'){
        clearPresentation(observation.sessionID);primaryRequests.delete(observation.sessionID);presentationSequences.delete(observation.sessionID);
      }
      if(observation.stage==='physical'&&observation.kind==='primary'&&observation.attempt){
        clearPresentation(observation.sessionID);presentationSequences.delete(observation.sessionID);
        primaryRequests.set(observation.sessionID,{requestID:observation.requestID,attempt:attemptKey(observation.attempt),token:input.permit?.token,revision:input.permit?.revision});
        while(primaryRequests.size>256){const old=primaryRequests.keys().next().value;clearPresentation(old);primaryRequests.delete(old);presentationSequences.delete(old);}
      }
      if(observation.stage==='step-link'&&observation.attempt){
        steps.set(observation.sessionID+'\0'+observation.assistantMessageID+'\0'+attemptKey(observation.attempt),{
          stepID:observation.eventID,userMessageID:observation.userMessageID,directory:observation.directory,token:input.permit?.token,revision:input.permit?.revision});
        while(steps.size>256)steps.delete(steps.keys().next().value);
      }

      if(helper&&observation.stage==='model-prepared'){
        helperRequests.set(observation.requestID,{sessionID:observation.sessionID,directory:observation.directory,token:input.permit.token,
          revision:input.permit.revision,toolCount:observation.toolCount,helper});
        while(helperRequests.size>256)helperRequests.delete(helperRequests.keys().next().value);
      }
      // Turn timing only, after the committed journal write.
      try { options.onObservation?.(observation); } catch { /* Observer only. */ }
      return written;
    }); } catch(cause) { gap(observation); throw cause; }
  };
  return {observeAcceptedUser,handleRpc,retire};
}
