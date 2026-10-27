import {nativeStepPermitSha256} from './primary-step-owner.js';

const fail=()=>Object.assign(new Error('native_stream_continuation_fenced'),{code:'native_stream_continuation_fenced',statusCode:409});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_:/.-]{1,256}$/.test(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const keys=['action','controllerInstanceID','configurationDigest','permit','sessionID','requestID','execution'];
const extra={prepare:[],send:['attempt'],progress:['attempt','observedUnits'],reserve:['attempt','outputEventID','assistantMessageID','fingerprint'],bind:['eventID','eventSeq','userMessageID','fingerprint']};

/** Private constructor RPC, isolated from diagnostic observations and public plugin actions. */
export function createNativeStreamContinuationOwner(options){
 return async input=>{
  if(!object(input)||!Object.hasOwn(extra,input.action)||Object.keys(input).length!==keys.length+extra[input.action].length
   ||Object.keys(input).some(key=>!keys.includes(key)&&!extra[input.action].includes(key))
   ||input.controllerInstanceID!==options.instanceID||input.configurationDigest!==options.configurationDigest
   ||!id(input.sessionID)||!id(input.requestID)||!object(input.execution)||Object.keys(input.execution).length!==4
   ||!['agent','providerID','modelID','variant'].every(key=>id(input.execution[key])))throw fail();
  if(['send','reserve','progress'].includes(input.action)&&(!object(input.attempt)||Object.keys(input.attempt).length!==2
   ||!['traceID','spanID'].every(key=>hash(input.attempt[key])||typeof input.attempt[key]==='string'&&/^[a-f0-9]{1,128}$/.test(input.attempt[key]))))throw fail();
  if(input.action==='reserve'&&(!/^evt_[A-Za-z0-9]+$/.test(input.outputEventID??'')||!/^msg_[A-Za-z0-9]+$/.test(input.assistantMessageID??'')||!hash(input.fingerprint)))throw fail();
  if(input.action==='bind'&&(!/^evt_[A-Za-z0-9]+$/.test(input.eventID??'')||!/^msg_[A-Za-z0-9]+$/.test(input.userMessageID??'')
   ||!Number.isSafeInteger(input.eventSeq)||input.eventSeq<1||!hash(input.fingerprint)))throw fail();
  if(input.action==='progress'&&(!Number.isSafeInteger(input.observedUnits)||input.observedUnits<=0))throw fail();
  const current=()=>options.isCurrent(input.sessionID)===true;
  const refuseCurrent=()=>{
   try{void Promise.resolve(options.recordRefusal?.({sessionID:input.sessionID,action:input.action,code:'native_stream_continuation_fenced'})).catch(()=>undefined);}catch{/* Evidence never owns admission. */}
   throw fail();
  };
  if(!current())refuseCurrent();
  const session=await options.openCodeClient.sessions.get(input.sessionID);
  if(session?.id!==input.sessionID||typeof session.directory!=='string'||session.revert||session.time?.archived)throw fail();
  return options.admissionOwner.withProviderAttempt({directory:session.directory,sessionID:input.sessionID,permit:input.permit,kind:'primary'},async recheck=>{
   const authorize=async()=>{await recheck();if(!current())refuseCurrent();};
   await authorize();
   await options.primaryRuntime.helloNative({policyVersion:1,instanceID:options.instanceID},{authorize,isCurrent:current});
   return options.primaryRuntime.nativeStreamContinuation({...input,instanceID:options.instanceID,directory:session.directory,
    permitSha256:nativeStepPermitSha256(input.permit),permit:undefined},authorize);
  });
 };
}
