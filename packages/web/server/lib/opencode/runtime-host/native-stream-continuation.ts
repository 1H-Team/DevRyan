import {createHash} from 'node:crypto';
import {Effect,Layer,Stream,Schema,type Scope} from 'effect';
import {SessionEvent} from '@opencode/schema/session-event';
import {LLMClient,type LLMRequest,type LLMClientShape} from '@opencode/ai';
import {llmClient} from '@opencode/core/effect/app-node-platform';
import {SessionMessage} from '@opencode/schema/session-message';
import type {SessionModelRequest} from '@opencode/core/session/model-request';
import {OperationPermitRef,type OperationPermit} from './native-admission-contract.js';
import {currentNativeAttemptIdentity,type NativeAttemptIdentity} from './native-observation.js';
import {HostRefusal,refuseHost} from './host-refusal.js';
import type {ExecutionRpc} from './worker-protocol.js';

const outputStarts=new Set(['text-start','reasoning-start','tool-input-start','tool-input-error','tool-call']);
const committedStarts=new Set(['session.text.started','session.reasoning.started','session.tool.input.started']);
const interruptedText='The previous response was interrupted. Continue from where you left off without repeating completed content.';
interface Attempt {readonly identity:NativeAttemptIdentity;outputStarted:boolean;outputEventID?:string;assistantMessageID?:string}
interface PreparedScope {readonly sessionID:string;readonly directory:string;readonly requestID:string;readonly execution:{agent:string;providerID:string;modelID:string;variant:string};attempt?:Attempt;outputStarted?:boolean;reserved?:boolean;continuation?:boolean;permit?:OperationPermit;units?:number;progressAt?:number}

/** Constructor-private request/attempt state. Journal and UI observations never feed this gate. */
export function createNativeStreamContinuation(options:{controllerInstanceID:string;configurationDigest:string;rpc:ExecutionRpc;
 readonly decorateLlmClient?:(inner:LLMClientShape)=>Effect.Effect<LLMClientShape,never,Scope.Scope>}){
 const requests=new WeakMap<LLMRequest,PreparedScope>(),attempts=new Map<string,PreparedScope>(),pending=new Map<string,PreparedScope>();
 const key=(attempt:NativeAttemptIdentity)=>attempt.traceID+'\0'+attempt.spanID;
 const call=(action:string,scope:PreparedScope,extra:Record<string,unknown>={})=>Effect.gen(function*(){
  const permit=yield* OperationPermitRef;
  if(!permit)return yield* refuseHost(new HostRefusal('native_stream_continuation_fenced',403,'primary.continue',scope.sessionID));
  return yield* Effect.tryPromise({try:signal=>options.rpc('native.stream-continuation',{action,controllerInstanceID:options.controllerInstanceID,
   configurationDigest:options.configurationDigest,permit,sessionID:scope.sessionID,requestID:scope.requestID,execution:scope.execution,...extra},{signal}),
   catch:()=>new HostRefusal('native_stream_continuation_fenced',409,'primary.continue',scope.sessionID)}).pipe(Effect.orDie);
 });
 const override=llmClient.replace(llmClient.mapLayer(layer=>Layer.effect(LLMClient.Service,Effect.gen(function*(){
  const inner=yield* LLMClient.Service;
  yield* Effect.addFinalizer(()=>Effect.sync(()=>{attempts.clear();pending.clear();}));
  const wrapped=LLMClient.Service.of({...inner,stream:(request,streamOptions)=>Stream.unwrap(Effect.gen(function*(){
   const scope=requests.get(request),identity=yield* currentNativeAttemptIdentity;
   if(scope){
    if(!identity)return yield* refuseHost(new HostRefusal('native_stream_continuation_fenced',409,'primary.continue',scope.sessionID));
    if((yield* call('send',scope,{attempt:identity}))!==true)return yield* refuseHost(new HostRefusal('provider_stream_interrupted',409,'primary.continue',scope.sessionID));
    scope.attempt={identity,outputStarted:false};attempts.set(key(identity),scope);
   }
   let hasProviderError=false;
   return inner.stream(request,streamOptions).pipe(Stream.tap(event=>Effect.sync(()=>{
    if(hasProviderError)return;
    if(scope&&outputStarts.has(event.type)){scope.outputStarted=true;if(scope.attempt)scope.attempt.outputStarted=true;}
    if(event.type==='provider-error'||event.type==='step-finish'&&event.reason.normalized==='content-filter')hasProviderError=true;
   })),Stream.ensuring(Effect.sync(()=>{if(identity)attempts.delete(key(identity));})));
  }))});
  // LayerNode is last-wins: retain the helper's scoped capture of this actual
  // stream wrapper, rather than installing two competing LLM replacements.
  return options.decorateLlmClient?yield* options.decorateLlmClient(wrapped):wrapped;
 })).pipe(Layer.provide(layer))));
 const beforePrepare=(input:SessionModelRequest.Input,requestID:string)=>Effect.gen(function*(){
  const scope:PreparedScope={sessionID:input.session.id,directory:input.session.location.directory,requestID,execution:{agent:input.agent,providerID:input.model.ref.providerID,
   modelID:input.model.ref.id,variant:input.model.ref.variant??'default'}};
  scope.continuation=Boolean(pending.get(scope.sessionID)?.reserved);scope.permit=yield* OperationPermitRef;
  if((yield* call('prepare',scope))!==true)return yield* refuseHost(new HostRefusal('provider_stream_interrupted',409,'primary.continue',scope.sessionID));
  pending.delete(scope.sessionID);
  return scope;
 });
 const decorate=<Event>(scope:PreparedScope,prepared:SessionModelRequest.Prepared<Event>):SessionModelRequest.Prepared<Event>=>{
  requests.set(prepared.request,scope);
  return {...prepared,retry:event=>prepared.retry(event).pipe(Effect.andThen(Effect.gen(function*(){
   // Native and Slim decide first. This owner can only restrict a true proposal.
   if(!event.decision.retry)return;
   if(!scope.attempt){if(scope.outputStarted)event.decision={retry:false};return;}
   if(!scope.attempt.outputStarted&&!scope.outputStarted)return;
   const attempt=scope.attempt;
   if(!attempt.outputEventID||!attempt.assistantMessageID){event.decision={retry:false};return;}
   const result=yield* call('reserve',scope,{attempt:attempt.identity,outputEventID:attempt.outputEventID,assistantMessageID:attempt.assistantMessageID,
    fingerprint:createHash('sha256').update(JSON.stringify({messages:prepared.request.messages,tools:prepared.request.tools,toolChoice:prepared.request.toolChoice,
     generation:prepared.request.generation,providerOptions:prepared.request.providerOptions})).digest('hex')});
   if(result!==true){event.decision={retry:false};return;}
   scope.reserved=true;pending.set(scope.sessionID,scope);
  }))) };
 };
 const progress=(scope:PreparedScope,units:number)=>{
  if(!scope.continuation||!scope.attempt||!scope.permit||units<=0)return;
  scope.units=(scope.units??0)+units;
  const now=Date.now();if(now-(scope.progressAt??0)<1000)return;scope.progressAt=now;
  // Actual pulled transport data, at most once/second; never wait on the body path.
  try{void Promise.resolve(options.rpc('native.stream-continuation',{action:'progress',controllerInstanceID:options.controllerInstanceID,
   configurationDigest:options.configurationDigest,permit:scope.permit,sessionID:scope.sessionID,requestID:scope.requestID,execution:scope.execution,
   attempt:scope.attempt.identity,observedUnits:scope.units})).catch(()=>undefined);}catch{/* Missing proof expires at the owner. */}
 };
 const observePublished=(event:unknown)=>Effect.gen(function*(){
  if(typeof event!=='object'||event===null||!('type' in event)||!('data' in event)||typeof event.data!=='object'||event.data===null)return;
  const data=event.data;
  if(event.type==='session.step.started'){
   const identity=yield* currentNativeAttemptIdentity,scope=identity?attempts.get(key(identity)):undefined;
   if(scope&&'sessionID' in data&&data.sessionID===scope.sessionID)scope.continuation=false;
   return;
  }
  if(event.type==='session.execution.interrupted'&&'sessionID' in data&&typeof data.sessionID==='string'){
   pending.delete(data.sessionID);return;
  }
  if(committedStarts.has(String(event.type))){
   const identity=yield* currentNativeAttemptIdentity,scope=identity?attempts.get(key(identity)):undefined;
   if(scope?.attempt&&'sessionID' in data&&data.sessionID===scope.sessionID&&'assistantMessageID' in data&&typeof data.assistantMessageID==='string'
    &&'id' in event&&typeof event.id==='string'){
    scope.attempt.outputEventID=event.id;scope.attempt.assistantMessageID=data.assistantMessageID;
   }
   return;
  }
  if(event.type!=='session.synthetic'||!('sessionID' in data)||typeof data.sessionID!=='string')return;
  const scope=pending.get(data.sessionID);
  if(!scope?.reserved)return;
  if(!('text' in data)||data.text!==interruptedText||!('id' in event)||typeof event.id!=='string'
   ||!('durable' in event)||typeof event.durable!=='object'||event.durable===null||!('seq' in event.durable)){
   return yield* refuseHost(new HostRefusal('native_stream_continuation_fenced',409,'primary.continue',scope.sessionID));
  }
  const synthetic=Schema.decodeUnknownSync(Schema.toType(SessionEvent.Synthetic))(event);
  if(synthetic.durable?.aggregateID!==scope.sessionID||synthetic.location?.directory!==scope.directory)
   return yield* refuseHost(new HostRefusal('native_stream_continuation_fenced',409,'primary.continue',scope.sessionID));
  if((yield* call('bind',scope,{eventID:synthetic.id,eventSeq:synthetic.durable.seq,userMessageID:SessionMessage.ID.fromEvent(synthetic.id),
   fingerprint:createHash('sha256').update(synthetic.data.text).digest('hex')}))!==true)
   return yield* refuseHost(new HostRefusal('provider_stream_interrupted',409,'primary.continue',scope.sessionID));
 });
 return {override,beforePrepare,decorate,observePublished,progress};
}
