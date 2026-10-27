import { createHash, randomUUID } from 'node:crypto';
import zlib from 'node:zlib';
import { Cause, Context, Effect, Layer, Option, Schema, Stream, type Scope, type Tracer } from 'effect';
import { SessionModelRequest } from '@opencode/core/session/model-request';
import { Location } from '@opencode/core/location';
import { PluginHooks } from '@opencode/core/plugin/hooks';
import type { WebSocketChannelExchange } from '@opencode/ai/route';
import { DEFAULT_HTTP_TIMEOUT_MS, HttpOptions, mergeProviderOptions } from '@opencode/ai/schema/options';
import { SessionCompaction } from '@opencode/core/session/compaction';
import { SessionMessage } from '@opencode/schema/session-message';
import { registerNativeCompactionObservation, type NativeCompactionBudget } from './native-compaction-observation.js';
import { SessionEvent } from '@opencode/schema/session-event';
import { OperationPermitRef } from './native-admission-contract.js';
import type { ExecutionRpc } from './worker-protocol.js';
import { isSafeNativeOpenAiRefusalCode, projectNativeReasoningOptions, type NativeObservation } from './native-observation-contract.js';
import type { PrimaryStepPublication } from './primary-step.js';
import { isNativeCursorIngress } from './native-cursor-ingress.js';
import { HostRefusal } from './host-refusal.js';
import {createNativeFinalizationQueue,drainNativeFinalizationQueue,registerNativeFinalizationObservation} from './native-finalization-observation.js';
import {createNativeStreamContinuation} from './native-stream-continuation.js';
import {LLMRequest,type LLMClientShape} from '@opencode/ai';
import {nativeRequestHeaderDeadline} from './native-provider-deadlines.js';

export interface NativeAttemptIdentity {
  readonly traceID: string;
  readonly spanID: string;
}

/** Read the actual native attempt span; absence is explicit, never inferred from a session. */
export const currentNativeAttemptIdentity: Effect.Effect<NativeAttemptIdentity | null> = Effect.currentSpan.pipe(
  Effect.map(current => {
    let span: Tracer.AnySpan | undefined = current;
    for (let depth = 0; span && depth < 128; depth++) {
      if (span._tag !== 'Span') return null;
      if (span.name === 'SessionStep.attempt') return { traceID: span.traceId, spanID: span.spanId };
      span = Option.getOrUndefined(span.parent);
    }
    return null;
  }),
  Effect.catch(() => Effect.succeed(null)),
);

type PreparedObservation = Extract<NativeObservation, {stage:'model-prepared'}>;
type RefusalObservation = Extract<NativeObservation, {stage:'provider-refusal'}>;
const refusalHook=(value:PropertyKey):value is RefusalObservation['hook']=>
  value==='http.request'||value==='http.response'||value==='experimental.ws.handshake'||value==='experimental.ws.send';
function refusalAttempt(value:unknown):{sessionID:string;kind:RefusalObservation['kind']}|null {
  if(value===null||typeof value!=='object'||!('sessionID' in value)||typeof value.sessionID!=='string'
    ||!('kind' in value)||!('model' in value)||value.model===null||typeof value.model!=='object'
    ||!('providerID' in value.model)||value.model.providerID!=='openai')return null;
  const kind=value.kind;
  return kind==='primary'||kind==='title'||kind==='compaction'||kind==='generate'?{sessionID:value.sessionID,kind}:null;
}
interface Preparation {readonly observed:PreparedObservation;readonly nextOrdinal:()=>number}
const PreparationRef = Context.Reference<Preparation | undefined>('DevRyan/NativeObservationPreparation', {defaultValue:()=>undefined});

interface CompactionObservationScope {readonly triggerID:string;messageID?:string}
const CompactionRef=Context.Reference<CompactionObservationScope|undefined>('DevRyan/NativeObservationCompaction',{defaultValue:()=>undefined});
const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');
const witness=(value:unknown)=>{if(value===undefined)return null;const text=typeof value==='string'?value:JSON.stringify(value);return {sha256:sha256(text),bytes:Buffer.byteLength(text)};};

/** Existing materialized bodies only; no stream consumption or raw content persistence.
 * One bounded parse per physical send is included in native performance measurements.
 */
export const NATIVE_OBSERVATION_WIRE_BYTES=64*1024*1024;
type WireEffortUpdates=Extract<NativeObservation,{stage:'physical'}>['wireEffortUpdates'];
const effortValue=(value:unknown):value is NonNullable<WireEffortUpdates>['effort']=>typeof value==='string'&&['none','minimal','low','medium','high','xhigh','max','ultra'].includes(value);
// Responses controls are ordered: the final configuration_update governs the
// following generation. Never inspect message content or synthesize wireOptions.
function wireEffortUpdates(controls:object):WireEffortUpdates {
  const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  if(!object(controls))return null;
  const top:unknown[]=[];
  for(const key of ['reasoningEffort','reasoning_effort','effort'])if(Object.hasOwn(controls,key))top.push(controls[key]);
  if(Object.hasOwn(controls,'reasoning')){
    if(!object(controls.reasoning))return null;
    if(Object.hasOwn(controls.reasoning,'effort'))top.push(controls.reasoning.effort);
  }
  if(top.some(value=>!effortValue(value))||top.some(value=>value!==top[0]))return null;
  if(!Array.isArray(controls.input))return undefined;
  let count=0,last:NonNullable<WireEffortUpdates>['effort']|undefined;
  for(const item of controls.input){
    if(!object(item)||item.type!=='configuration_update')continue;
    if(++count>256||Object.keys(item).some(key=>!['type','reasoning'].includes(key))
      ||!object(item.reasoning)||Object.keys(item.reasoning).length!==1||!effortValue(item.reasoning.effort))return null;
    last=item.reasoning.effort;
  }
  return last===undefined?undefined:{count,effort:last};
}
// OpenCode compresses request bodies with `settings.encoding` (zstd by default
// for ChatGPT sign-in since 2.0.28) and names it in `content-encoding`.
// Decompression stops at the same byte cap as a plain body.
const decodeWireBody=(body:Uint8Array,encoding:string|undefined):Uint8Array|null=>{
  const name=encoding?.trim().toLowerCase();
  if(!name||name==='identity')return body;
  const options={maxOutputLength:NATIVE_OBSERVATION_WIRE_BYTES};
  if(name==='zstd')return typeof zlib.zstdDecompressSync==='function'?zlib.zstdDecompressSync(body,options):null;
  if(name==='gzip')return zlib.gunzipSync(body,options);
  return null;
};
export function projectNativeWireObservation(body:unknown,encoding?:string):{readonly options:Readonly<Record<string,unknown>>;readonly toolCount:number|null;readonly effortUpdates?:WireEffortUpdates}|null {
  try {
    let text:string;
    if(typeof body==='string'){if(encoding||Buffer.byteLength(body)>NATIVE_OBSERVATION_WIRE_BYTES)return null;text=body;}
    else if(body instanceof Uint8Array||body instanceof ArrayBuffer){
      const bytes=body instanceof ArrayBuffer?new Uint8Array(body):body;
      if(bytes.byteLength>NATIVE_OBSERVATION_WIRE_BYTES)return null;
      const decoded=decodeWireBody(bytes,encoding);
      if(!decoded)return null;
      text=new TextDecoder().decode(decoded);
    }
    else return null;
    const parsed:unknown=JSON.parse(text);
    if(parsed===null||typeof parsed!=='object'||Array.isArray(parsed))return null;
    // The native Responses WebSocket send wraps the actual request controls.
    // Other frame types cannot establish a missing-tools count as zero.
    const controls='type' in parsed&&parsed.type==='response.create'
      ?'response' in parsed&&parsed.response!==null&&typeof parsed.response==='object'&&!Array.isArray(parsed.response)?parsed.response:null
      :'type' in parsed?null:parsed;
    if(!controls)return null;
    const tools='tools' in controls?controls.tools:undefined;
    const effortUpdates=wireEffortUpdates(controls);
    return {options:projectNativeReasoningOptions(controls),toolCount:tools===undefined?0:Array.isArray(tools)?tools.length:null,
      ...effortUpdates!==undefined?{effortUpdates}:{}};
  }catch{return null;}
}
export const projectNativeWireReasoningOptions=(body:unknown):Readonly<Record<string,unknown>>|null=>projectNativeWireObservation(body)?.options??null;

/** Content-free projection of a provider transport failure: a bounded code,
 * the target hostname and port, never a message, header, body or full URL. */
export interface NativeProviderFailure {
  readonly phase:'connect'|'headers'|'stream';readonly elapsedMs:number;readonly sinceLastByteMs?:number;readonly code:string;
  readonly host:string|null;readonly port:number|null;readonly providerID:string;readonly modelID:string;readonly providerRequestID:string|null;
}
/** Per-request send state written by the transport observers; the failure projection reads it. */
export interface NativeTransportState {
  readonly preparedAt:number;startedAt?:number;lastByteAt?:number;url?:string;providerRequestID?:string|null;
}
const SAFE_CODE=/^[A-Za-z0-9_]{1,64}$/;
const record=(value:unknown):value is Readonly<Record<string,unknown>>=>value!==null&&typeof value==='object';
// Failures before the TCP/TLS session exists; any other pre-headers failure is `headers`.
const CONNECT_CODES=new Set(['ECONNREFUSED','ENOTFOUND','EAI_AGAIN','EAI_FAIL','EAI_NONAME','EHOSTUNREACH','ENETUNREACH','ENETDOWN',
  'EADDRNOTAVAIL','UND_ERR_CONNECT_TIMEOUT','ConnectionRefused','FailedToOpenSocket','DNSError']);
const connectCode=(code:string)=>CONNECT_CODES.has(code)||/^(?:CERT_|ERR_TLS_|ERR_SSL_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_)/.test(code);
/** The first bounded `code` along an error's cause chain, else its innermost reason tag. */
export function nativeProviderFailureCode(error:unknown):string {
  let fallback:string|undefined;
  let current:unknown=error;
  for(let depth=0;depth<8&&record(current);depth++){
    if(Cause.isTimeoutError(current))return 'Timeout';
    if(typeof current.code==='string'&&SAFE_CODE.test(current.code))return current.code;
    const reason=record(current.reason)?current.reason:undefined;
    const tag=reason?reason._tag:current._tag;
    if(typeof tag==='string'&&SAFE_CODE.test(tag)&&tag!=='HttpClientError')fallback=tag;
    current=reason&&'cause' in reason?reason.cause:current.cause;
  }
  return fallback??'unknown';
}
export function nativeProviderFailureTarget(url:string|undefined):{host:string|null;port:number|null} {
  try{
    if(url===undefined)return {host:null,port:null};
    const parsed=new URL(url);
    const host=parsed.hostname.replace(/^\[|\]$/g,'');
    const port=parsed.port?Number(parsed.port):parsed.protocol==='https:'||parsed.protocol==='wss:'?443:parsed.protocol==='http:'||parsed.protocol==='ws:'?80:null;
    return {host:/^[A-Za-z0-9.:-]{1,253}$/.test(host)?host:null,port:port!==null&&Number.isSafeInteger(port)&&port>0&&port<65536?port:null};
  }catch{return {host:null,port:null};}
}
export const nativeProviderRequestID=(headers:unknown):string|null=>{
  if(!record(headers))return null;
  for(const name of ['x-request-id','request-id','openai-request-id','x-amzn-requestid']){
    const value=headers[name];
    if(typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(value))return value;
  }
  return null;
};
/** A typed AI transport or timeout failure; any other error (status, auth, output) is not one. */
export function projectNativeProviderFailure(input:{readonly error:unknown;readonly state:NativeTransportState;readonly now:number;
  readonly providerID:string;readonly modelID:string}):{readonly transport:'http'|'ws';readonly failure:NativeProviderFailure}|null {
  const reason=record(input.error)&&input.error._tag==='AI.Error'&&record(input.error.reason)?input.error.reason:undefined;
  if(!reason||reason._tag!=='Transport'&&reason._tag!=='Timeout')return null;
  const http=record(reason.http)?reason.http:undefined;
  // Headers arrived when the error names a read or carries the response context.
  const read=reason._tag==='Transport'?reason.operation==='read':Boolean(http);
  const code=reason._tag==='Timeout'?'Timeout':typeof reason.code==='string'&&SAFE_CODE.test(reason.code)?reason.code:nativeProviderFailureCode(reason.cause);
  const url=typeof reason.url==='string'?reason.url:typeof http?.url==='string'?http.url:input.state.url;
  const startedAt=input.state.startedAt??input.state.preparedAt;
  return {transport:reason.transport==='websocket'||/^wss?:/.test(url??'')?'ws':'http',failure:{
    phase:read?'stream':connectCode(code)||reason.phase==='connect'?'connect':'headers',elapsedMs:Math.max(0,input.now-startedAt),
    ...read?{sinceLastByteMs:Math.max(0,input.now-(input.state.lastByteAt??startedAt))}:{},code,...nativeProviderFailureTarget(url),
    providerID:input.providerID,modelID:input.modelID,providerRequestID:read?nativeProviderRequestID(http?.headers)??input.state.providerRequestID??null:null}};
}

/** Apply the per-request header deadline policy (`native-provider-deadlines.js`) to a prepared request. */
export function withNativeHeaderDeadline<Request extends LLMRequest>(request:Request):Request {
  const headerTimeout=nativeRequestHeaderDeadline(request.model.provider,
    request.http?.headerTimeout??request.model.defaults?.http?.headerTimeout,DEFAULT_HTTP_TIMEOUT_MS);
  return headerTimeout===undefined?request:LLMRequest.update(request,{http:new HttpOptions({...request.http,headerTimeout})}) as Request;
}

export function createNativeObservation(options:{readonly controllerInstanceID:string;readonly configurationDigest:string;readonly rpc:ExecutionRpc;
  readonly streamContinuation?:boolean;
  readonly decorateLlmClient?:(inner:LLMClientShape)=>Effect.Effect<LLMClientShape,never,Scope.Scope>;
  readonly decorateModelRequests?:(inner:SessionModelRequest.Interface)=>Effect.Effect<SessionModelRequest.Interface,never,Scope.Scope>}) {
  const finalizationSteps=new Map<string,{sessionID:string;directory:string;assistantMessageID:string;stepID:string}>();
  type FinalizationInterval={identity:string;queue:ReturnType<typeof createNativeFinalizationQueue>};
  const finalizationQueues=new Map<string,FinalizationInterval>();
  let finalizationSequence=0;
  const attemptKey=(attempt:NativeAttemptIdentity)=>attempt.traceID+'\0'+attempt.spanID;
  const queueFinalization=(permit:unknown,observation:Readonly<Record<string,unknown>>,interval:FinalizationInterval)=>{
    interval.queue.enqueue(signal=>options.rpc('native.presentation',{controllerInstanceID:options.controllerInstanceID,permit,observation},{signal}),observation.phase==='cleared'?'cleared':'finalizing');
  };
  const emit=(observation:NativeObservation | Omit<Extract<NativeObservation,{stage:'step-link'}>,'userMessageID'>)=>Effect.gen(function*(){
    const permit=yield* OperationPermitRef;
    if(!permit)return yield* Effect.logWarning('native_observation_unavailable',{stage:observation.stage});
    yield* Effect.tryPromise({try:signal=>options.rpc('native.observation',{controllerInstanceID:options.controllerInstanceID,permit,observation},{signal}),catch:()=>new Error('native_observation_unavailable')})
      .pipe(Effect.catch(()=>Effect.logWarning('native_observation_unavailable',{stage:observation.stage})));
  }).pipe(Effect.catchCause(()=>Effect.logWarning('native_observation_unavailable',{stage:observation.stage})));
  // Turn timing only: HTTP response headers, the first body bytes or WebSocket
  // frame, raw HTTP body totals/gaps and the Responses
  // `response.created` frame. Never awaited, so the provider stream is not
  // delayed; a lost mark is only a missing measurement, never an authority.
  const timing=(prepared:PreparedObservation,transport:'http'|'ws',event:'headers'|'first-byte'|'response-created'|'body-end'|'failed',statusCode:number|null,
    detail?:{body:{bytes:number;chunks:number;maxGapMs:number}}|{failure:NativeProviderFailure})=>{
    try{void Promise.resolve(options.rpc('native.provider-timing',{controllerInstanceID:options.controllerInstanceID,sessionID:prepared.sessionID,
      requestID:prepared.requestID,kind:prepared.kind,transport,event,statusCode,...detail})).catch(()=>undefined);}catch{/* Timing only. */}
  };
  // Transport failures are reported once, where the model stream fails with a
  // typed AI error: header, chunk and total timeouts wrap the HTTP middleware
  // from outside, so the middleware itself only records send state.
  // Interruption (Stop) is not a failure; the original error is rethrown unchanged.
  const transports=new WeakMap<LLMRequest,{readonly observed:PreparedObservation;readonly state:NativeTransportState}>();
  const failed=(request:LLMRequest,error:unknown)=>{
    try{
      const scope=transports.get(request);
      const projected=scope?projectNativeProviderFailure({error,state:scope.state,now:Date.now(),
        providerID:scope.observed.execution.providerID,modelID:scope.observed.execution.modelID}):null;
      if(scope&&projected)timing(scope.observed,projected.transport,'failed',null,{failure:projected.failure});
    }catch{/* Timing only. */}
  };
  const observeTransport=(inner:LLMClientShape):LLMClientShape=>({...inner,
    stream:(request,streamOptions)=>inner.stream(request,streamOptions).pipe(Stream.tapError(error=>Effect.sync(()=>failed(request,error)))),
    generate:(request,streamOptions)=>inner.generate(request,streamOptions).pipe(Effect.tapError(error=>Effect.sync(()=>failed(request,error))))});
  // The continuation owns the single LLM client replacement (production always
  // enables it); transport observation decorates that wrapper.
  const continuation=options.streamContinuation?createNativeStreamContinuation({...options,decorateLlmClient:inner=>
    options.decorateLlmClient?options.decorateLlmClient(observeTransport(inner)):Effect.succeed(observeTransport(inner))}):undefined;
  const physical=(prepared:PreparedObservation,transport:'http'|'ws',ordinal:number,body:unknown,encoding?:string)=>Effect.gen(function*(){
    const attempt=yield* currentNativeAttemptIdentity;
    const wire=projectNativeWireObservation(body,encoding);
    yield* emit({schema:1,stage:'physical',controllerInstanceID:options.controllerInstanceID,configurationDigest:options.configurationDigest,
      sessionID:prepared.sessionID,directory:prepared.directory,requestID:prepared.requestID,kind:prepared.kind,transport,
      toolCount:prepared.toolCount,wireToolCount:wire?.toolCount??null,wireOptions:wire?.options??null,...wire&&Object.hasOwn(wire,'effortUpdates')?{wireEffortUpdates:wire.effortUpdates}:{},ordinal,attempt});
  });
  const requests=SessionModelRequest.node.replace(SessionModelRequest.node.mapLayer(original=>Layer.effect(SessionModelRequest.Service,Effect.gen(function*(){
    const native=yield* SessionModelRequest.Service;
    const inner=options.decorateModelRequests?yield* options.decorateModelRequests(native):native;
    const prepare=<Event>(kind:PreparedObservation['kind'],input:SessionModelRequest.Input,action:Effect.Effect<SessionModelRequest.Prepared<Event>>)=>Effect.gen(function*(){
      const observed:PreparedObservation={schema:1,stage:'model-prepared',controllerInstanceID:options.controllerInstanceID,configurationDigest:options.configurationDigest,
        sessionID:input.session.id,directory:input.session.location.directory,requestID:randomUUID(),kind,
        execution:{agent:input.agent,providerID:input.model.ref.providerID,modelID:input.model.ref.id,variant:input.model.ref.variant??null},
        options:{},hookOptions:{},modelLimits:{context:input.model.limit.context,input:input.model.limit.input??null,output:input.model.limit.output}};
      const scope=kind==='primary'&&continuation?yield* continuation.beforePrepare(input,observed.requestID):undefined;
      const actionPrepared=yield* action;
      // Bound the request before the continuation captures it: the continuation
      // tracks the exact request object it decorates.
      const bounded=withNativeHeaderDeadline(actionPrepared.request);
      const originalPrepared=bounded===actionPrepared.request?actionPrepared:{...actionPrepared,request:bounded};
      const prepared=scope&&continuation?continuation.decorate(scope,originalPrepared):originalPrepared;
      const materialized:PreparedObservation={...observed,toolCount:prepared.request.tools.length};
      let finalizationInterval:FinalizationInterval|undefined;
      if(kind==='primary')registerNativeFinalizationObservation(prepared.request,movement=>Effect.gen(function*(){
        const attempt=yield* currentNativeAttemptIdentity,permit=yield* OperationPermitRef;
        const step=attempt?finalizationSteps.get(attemptKey(attempt)):undefined;
        if(!attempt||!permit||!step||step.sessionID!==movement.sessionID||step.assistantMessageID!==movement.assistantMessageID)return;
        const identity=JSON.stringify([materialized.requestID,step.stepID,attempt,permit]);
        if(finalizationInterval?.identity!==identity){
          if(movement.phase!=='finalizing'||movement.progress!==0)return;
          finalizationInterval?.queue.abort();
          const previous=finalizationQueues.get(step.sessionID);
          previous?.queue.abort();
          if(finalizationQueues.size>=256)return;
          const interval:FinalizationInterval={identity,queue:createNativeFinalizationQueue(()=>{
            if(finalizationQueues.get(step.sessionID)===interval)finalizationQueues.delete(step.sessionID);
          })};
          finalizationInterval=interval;finalizationQueues.set(step.sessionID,interval);
        }
        queueFinalization(permit,{schema:1,controllerInstanceID:options.controllerInstanceID,configurationDigest:options.configurationDigest,
          sessionID:step.sessionID,directory:step.directory,requestID:materialized.requestID,assistantMessageID:step.assistantMessageID,
          stepID:step.stepID,attempt,phase:movement.phase,progress:movement.progress,sequence:++finalizationSequence},finalizationInterval);
        // The terminal observation stays inside the original ensuring/permit
        // lifetime. It cannot acquire renewed authority or change native writes.
        if(movement.phase==='cleared')yield* drainNativeFinalizationQueue(finalizationInterval.queue);
      }));
      // Each public entry has the same SessionRequest options shape, but Event
      // stays generic to retain the native service's exact return signature.
      const event=prepared.event;
      const source=event!==null&&typeof event==='object'&&'options' in event?event.options:undefined;
      // Reuse the exact SDK merger/precedence used by LLMClient. Hook-only
      // options omit model/route defaults and cannot prove effective selection.
      yield* Effect.sync(()=>({...materialized,hookOptions:projectNativeReasoningOptions(source),options:projectNativeReasoningOptions(mergeProviderOptions(
        prepared.request.model.route.defaults.providerOptions,prepared.request.model.defaults?.providerOptions,prepared.request.providerOptions))})).pipe(
          Effect.flatMap(emit),Effect.catchCause(()=>Effect.logWarning('native_observation_unavailable',{stage:'model-prepared'})));
      let ordinal=0;
      const preparation:Preparation={observed:materialized,nextOrdinal:()=>++ordinal};
      const state:NativeTransportState={preparedAt:Date.now()};
      transports.set(prepared.request,{observed,state});
      const http:NonNullable<typeof prepared.options.http>=(request,handler)=>{
        const send:typeof handler=sent=>physical(materialized,'http',++ordinal,sent.body._tag==='Uint8Array'?sent.body.body:undefined,sent.headers['content-encoding']).pipe(
          Effect.andThen(Effect.suspend(()=>{Object.assign(state,{startedAt:Date.now(),lastByteAt:undefined,url:sent.url,providerRequestID:null});return handler(sent);})),
          Effect.map(response=>{
            timing(observed,'http','headers',response.status);
            let bytes=0,chunks=0,last=Date.now(),maxGapMs=0;
            Object.assign(state,{lastByteAt:last,providerRequestID:nativeProviderRequestID(response.headers)});
            const stream=response.stream.pipe(Stream.tap(chunk=>Effect.sync(()=>{
              const now=Date.now();maxGapMs=Math.max(maxGapMs,now-last);last=now;state.lastByteAt=now;bytes+=chunk.byteLength;
              if(scope&&continuation)continuation.progress(scope,chunk.byteLength);
              if(chunks++===0)timing(observed,'http','first-byte',response.status);
            })),Stream.ensuring(Effect.sync(()=>timing(observed,'http','body-end',response.status,{body:{bytes,chunks,maxGapMs:Math.max(maxGapMs,Date.now()-last)}}))));
            // Retain prototype getters and cancellation; tap observes only pulled bytes.
            return new Proxy(response,{get:(target,key,receiver)=>key==='stream'?stream:Reflect.get(target,key,receiver)});
          }));
        return prepared.options.http?prepared.options.http(request,send):send(request);
      };
      const webSocket=prepared.options.webSocket;
      // Only the first frames are inspected; `response.created` opens a stream.
      const markFrames=()=>{let seen=0,created=false;return (frame:string)=>{
        state.lastByteAt=Date.now();
        if(scope&&continuation)continuation.progress(scope,Buffer.byteLength(frame));
        if(seen<8){if(seen++===0)timing(observed,'ws','first-byte',null);
          if(!created&&frame.includes('"response.created"')){created=true;timing(observed,'ws','response-created',null);}}
        return frame;};};
      return {...prepared,options:{...prepared.options,http,...webSocket?{webSocket:{execute:(exchange:WebSocketChannelExchange)=>
        Effect.suspend(()=>{Object.assign(state,{startedAt:Date.now(),lastByteAt:undefined,url:undefined,providerRequestID:null});return webSocket.execute(exchange);}).pipe(Effect.provideService(PreparationRef,preparation),Effect.map(execution=>({
          get http(){return execution.http;},
          frames:execution.frames.pipe(Stream.map(markFrames()),Stream.provideService(PreparationRef,preparation)),
          complete:execution.complete.pipe(Effect.provideService(PreparationRef,preparation)),
        })))}}:{}}};
    });
    return SessionModelRequest.Service.of({primary:input=>prepare('primary',input,inner.primary(input)),title:input=>prepare('title',input,inner.title(input)),
      compaction:input=>prepare('compaction',input,inner.compaction(input)),generate:input=>prepare('generate',input,inner.generate(input))});
  })).pipe(Layer.provide(original))));
  const decorateHooks=(inner:PluginHooks.Interface):PluginHooks.Interface=>({...inner,
    trigger:(domain,name,event)=>Effect.suspend(()=>{
      const source=domain==='session'&&refusalHook(name)?refusalAttempt(event):null;
      return inner.trigger(domain,name,event).pipe(Effect.onError(cause=>Effect.gen(function*(){
        if(!source||!refusalHook(name))return;
        const reason=cause.reasons.slice(0,8).find(reason=>reason._tag==='Die'&&reason.defect instanceof HostRefusal
          &&isSafeNativeOpenAiRefusalCode(reason.defect.code));
        if(!reason||reason._tag!=='Die'||!(reason.defect instanceof HostRefusal))return;
        const actual=Option.getOrUndefined(Context.getOption(yield* Effect.context(),Location.Service));
        if(!actual)return yield* Effect.logWarning('native_observation_unavailable',{stage:'provider-refusal'});
        yield* emit({schema:1,stage:'provider-refusal',controllerInstanceID:options.controllerInstanceID,configurationDigest:options.configurationDigest,
          sessionID:source.sessionID,directory:actual.directory,kind:source.kind,hook:name,code:reason.defect.code});
      }).pipe(Effect.catchCause(()=>Effect.logWarning('native_observation_unavailable',{stage:'provider-refusal'})))),Effect.tap(result=>Effect.gen(function*(){
      if(domain!=='session'||name!=='experimental.ws.send')return;
      const preparation=yield* PreparationRef;
      if(preparation)yield* physical(preparation.observed,'ws',preparation.nextOrdinal(),result!==null&&typeof result==='object'&&'frame' in result?result.frame:undefined);
    })));})});
  const compactions=SessionCompaction.node.replace(SessionCompaction.node.mapLayer(original=>Layer.effect(SessionCompaction.Service,Effect.gen(function*(){
    const inner=yield* SessionCompaction.Service;
    return SessionCompaction.Service.of({...inner,compact:trigger=>Effect.gen(function*(){
      const scope:CompactionObservationScope={triggerID:randomUUID(),...trigger.reason==='manual'?{messageID:trigger.inputID}:{}};
      const entered=Date.now();let budget:NativeCompactionBudget|undefined;
      let orderedInputDigest:string|undefined;
      let unregister=()=>{};let registrationFailed=false;
      try{unregister=registerNativeCompactionObservation(trigger,snapshot=>{budget=snapshot;orderedInputDigest=sha256(JSON.stringify(trigger.context.messages));});}
      catch{registrationFailed=true;}
      return yield* inner.compact(trigger).pipe(Effect.provideService(CompactionRef,scope),Effect.tap(outcome=>Effect.gen(function*(){
        if(outcome.status==='skipped')return;
        const base={schema:1 as const,controllerInstanceID:options.controllerInstanceID,configurationDigest:options.configurationDigest,
          sessionID:trigger.context.session.id,directory:trigger.context.session.location.directory,triggerID:scope.triggerID};
        if(registrationFailed||!orderedInputDigest||!budget)yield* Effect.logWarning('native_observation_unavailable',{stage:'compaction-trigger'});
        else yield* emit({...base,stage:'compaction-trigger',reason:trigger.reason,inputID:trigger.reason==='manual'?trigger.inputID:null,entered,
          orderedInputDigest,inputCount:trigger.context.messages.length,budget:budget??null,
          anchorMessageID:budget?trigger.context.messages[budget.anchorIndex]?.id??null:null,
          checkpointMessageID:budget?trigger.context.messages[budget.checkpointIndex]?.id??null:null});
        yield* emit({...base,stage:'compaction-outcome',status:outcome.status,finished:Date.now()});
      }).pipe(Effect.catchCause(()=>Effect.logWarning('native_observation_unavailable',{stage:'compaction-trigger'})))),
        Effect.ensuring(Effect.sync(unregister)));
    })});
  })).pipe(Layer.provide(original))));
  const observePublished=(event:unknown,disposition?:PrimaryStepPublication)=>Effect.gen(function*(){
    if(event===null||typeof event!=='object'||!('type' in event))return;
    if(event.type==='session.step.started'){
      // External Cursor projection has its own canonical grant and process
      // receipt; it is not a native SessionStep provider attempt.
      if(yield* isNativeCursorIngress())return;
      // The constructor's primary-step wrapper proved this publication is native
      // interrupted cleanup. Its cancelled physical attempt remains unmatched;
      // no fresh primary/observation authority is acquired after Stop.
      if(disposition?.primaryStep==='interrupted-cleanup')return;
      const step=Schema.decodeUnknownSync(Schema.toType(SessionEvent.Step.Started))(event);
      const directory=step.location?.directory;
      if(!directory||!step.durable)return yield* Effect.logWarning('native_observation_unavailable',{stage:'step-link'});
      const attempt=yield* currentNativeAttemptIdentity;
      if(attempt){finalizationSteps.set(attemptKey(attempt),{sessionID:step.data.sessionID,directory,assistantMessageID:step.data.assistantMessageID,stepID:step.id});
        while(finalizationSteps.size>256)finalizationSteps.delete(finalizationSteps.keys().next().value!);}
      yield* emit({schema:1,stage:'step-link',controllerInstanceID:options.controllerInstanceID,configurationDigest:options.configurationDigest,
        sessionID:step.data.sessionID,directory,eventID:step.id,sequence:step.durable.seq,created:step.created,assistantMessageID:step.data.assistantMessageID,
        execution:{agent:step.data.agent,providerID:step.data.model.providerID,modelID:step.data.model.id,variant:step.data.model.variant??null},attempt});
      return;
    }
    if(!['session.compaction.started','session.compaction.ended','session.compaction.failed'].includes(String(event.type)))return;
    const raw=Schema.decodeUnknownSync(Schema.toType(Schema.Union([SessionEvent.Compaction.Started,SessionEvent.Compaction.Ended,SessionEvent.Compaction.Failed])))(event);
    const scope=yield* CompactionRef;
    const inputID='inputID' in raw.data?raw.data.inputID??null:null;
    if(!raw.location?.directory||!raw.durable||!scope&&(raw.data.reason!=='manual'||!inputID))return yield* Effect.logWarning('native_observation_unavailable',{stage:'compaction-event'});
    if(raw.type==='session.compaction.started'&&scope)scope.messageID=inputID??SessionMessage.ID.fromEvent(raw.id);
    if(raw.type==='session.compaction.ended'&&!scope?.messageID)return yield* Effect.logWarning('native_observation_unavailable',{stage:'compaction-event'});
    yield* emit({schema:1,stage:'compaction-event',controllerInstanceID:options.controllerInstanceID,configurationDigest:options.configurationDigest,
      sessionID:raw.data.sessionID,directory:raw.location.directory,triggerID:scope?.triggerID??null,eventID:raw.id,sequence:raw.durable.seq,created:raw.created,
      event:raw.type==='session.compaction.started'?'started':raw.type==='session.compaction.ended'?'ended':'failed',reason:raw.data.reason,inputID,
      messageID:raw.type==='session.compaction.ended'?scope?.messageID??null:null,
      witness:{native:'native' in raw.data?witness(raw.data.native):null,recent:'recent' in raw.data?witness(raw.data.recent):null,text:'text' in raw.data?witness(raw.data.text):null,
        providerState:'providerState' in raw.data?witness(raw.data.providerState):null,providerContext:'providerContext' in raw.data?witness(raw.data.providerContext):null}});
  }).pipe(Effect.catchCause(()=>Effect.logWarning('native_observation_unavailable',{stage:'committed-event'})));
  return {overrides:[requests,compactions,...continuation?[continuation.override]:[]],
    observePublished:(event:unknown,disposition?:PrimaryStepPublication)=>(continuation?continuation.observePublished(event):Effect.void)
      .pipe(Effect.andThen(observePublished(event,disposition))),decorateHooks};
}
