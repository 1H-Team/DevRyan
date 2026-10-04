import { createHash, randomUUID } from 'node:crypto';
import { Context, Effect, Layer, Option, Schema, Stream, type Scope, type Tracer } from 'effect';
import { SessionModelRequest } from '@opencode/core/session/model-request';
import { PluginHooks } from '@opencode/core/plugin/hooks';
import type { WebSocketChannelExchange } from '@opencode/ai/route';
import { mergeProviderOptions } from '@opencode/ai/schema/options';
import { SessionCompaction } from '@opencode/core/session/compaction';
import { SessionMessage } from '@opencode/schema/session-message';
import { registerNativeCompactionObservation, type NativeCompactionBudget } from './native-compaction-observation.js';
import { SessionEvent } from '@opencode/schema/session-event';
import { OperationPermitRef } from './native-admission-contract.js';
import type { ExecutionRpc } from './worker-protocol.js';
import { projectNativeReasoningOptions, type NativeObservation } from './native-observation-contract.js';
import type { PrimaryStepPublication } from './primary-step.js';
import { isNativeCursorIngress } from './native-cursor-ingress.js';

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
export function projectNativeWireReasoningOptions(body:unknown):Readonly<Record<string,unknown>>|null {
  try {
    let text:string;
    if(typeof body==='string'){if(Buffer.byteLength(body)>NATIVE_OBSERVATION_WIRE_BYTES)return null;text=body;}
    else if(body instanceof Uint8Array){if(body.byteLength>NATIVE_OBSERVATION_WIRE_BYTES)return null;text=new TextDecoder().decode(body);}
    else if(body instanceof ArrayBuffer){if(body.byteLength>NATIVE_OBSERVATION_WIRE_BYTES)return null;text=new TextDecoder().decode(body);}
    else return null;
    return projectNativeReasoningOptions(JSON.parse(text));
  }catch{return null;}
}

export function createNativeObservation(options:{readonly controllerInstanceID:string;readonly configurationDigest:string;readonly rpc:ExecutionRpc;
  readonly decorateModelRequests?:(inner:SessionModelRequest.Interface)=>Effect.Effect<SessionModelRequest.Interface,never,Scope.Scope>}) {
  const emit=(observation:NativeObservation | Omit<Extract<NativeObservation,{stage:'step-link'}>,'userMessageID'>)=>Effect.gen(function*(){
    const permit=yield* OperationPermitRef;
    if(!permit)return yield* Effect.logWarning('native_observation_unavailable',{stage:observation.stage});
    yield* Effect.tryPromise({try:signal=>options.rpc('native.observation',{controllerInstanceID:options.controllerInstanceID,permit,observation},{signal}),catch:()=>new Error('native_observation_unavailable')})
      .pipe(Effect.catch(()=>Effect.logWarning('native_observation_unavailable',{stage:observation.stage})));
  }).pipe(Effect.catchCause(()=>Effect.logWarning('native_observation_unavailable',{stage:observation.stage})));
  const physical=(prepared:PreparedObservation,transport:'http'|'ws',ordinal:number,body:unknown)=>Effect.gen(function*(){
    const attempt=yield* currentNativeAttemptIdentity;
    yield* emit({schema:1,stage:'physical',controllerInstanceID:options.controllerInstanceID,configurationDigest:options.configurationDigest,
      sessionID:prepared.sessionID,directory:prepared.directory,requestID:prepared.requestID,kind:prepared.kind,transport,wireOptions:projectNativeWireReasoningOptions(body),ordinal,attempt});
  });
  const requests=SessionModelRequest.node.replace(SessionModelRequest.node.mapLayer(original=>Layer.effect(SessionModelRequest.Service,Effect.gen(function*(){
    const native=yield* SessionModelRequest.Service;
    const inner=options.decorateModelRequests?yield* options.decorateModelRequests(native):native;
    const prepare=<Event>(kind:PreparedObservation['kind'],input:SessionModelRequest.Input,action:Effect.Effect<SessionModelRequest.Prepared<Event>>)=>Effect.gen(function*(){
      const observed:PreparedObservation={schema:1,stage:'model-prepared',controllerInstanceID:options.controllerInstanceID,configurationDigest:options.configurationDigest,
        sessionID:input.session.id,directory:input.session.location.directory,requestID:randomUUID(),kind,
        execution:{agent:input.agent,providerID:input.model.ref.providerID,modelID:input.model.ref.id,variant:input.model.ref.variant??null},
        options:{},hookOptions:{},modelLimits:{context:input.model.limit.context,input:input.model.limit.input??null,output:input.model.limit.output}};
      const prepared=yield* action;
      // Each public entry has the same SessionRequest options shape, but Event
      // stays generic to retain the native service's exact return signature.
      const event=prepared.event;
      const source=event!==null&&typeof event==='object'&&'options' in event?event.options:undefined;
      // Reuse the exact SDK merger/precedence used by LLMClient. Hook-only
      // options omit model/route defaults and cannot prove effective selection.
      yield* Effect.sync(()=>({...observed,hookOptions:projectNativeReasoningOptions(source),options:projectNativeReasoningOptions(mergeProviderOptions(
        prepared.request.model.route.defaults.providerOptions,prepared.request.model.defaults?.providerOptions,prepared.request.providerOptions))})).pipe(
          Effect.flatMap(emit),Effect.catchCause(()=>Effect.logWarning('native_observation_unavailable',{stage:'model-prepared'})));
      let ordinal=0;
      const preparation:Preparation={observed,nextOrdinal:()=>++ordinal};
      const http:NonNullable<typeof prepared.options.http>=(request,handler)=>{
        const send:typeof handler=sent=>physical(observed,'http',++ordinal,sent.body._tag==='Uint8Array'?sent.body.body:undefined).pipe(Effect.andThen(handler(sent)));
        return prepared.options.http?prepared.options.http(request,send):send(request);
      };
      const webSocket=prepared.options.webSocket;
      return {...prepared,options:{...prepared.options,http,...webSocket?{webSocket:{execute:(exchange:WebSocketChannelExchange)=>
        webSocket.execute(exchange).pipe(Effect.provideService(PreparationRef,preparation),Effect.map(execution=>({
          get http(){return execution.http;},
          frames:execution.frames.pipe(Stream.provideService(PreparationRef,preparation)),
          complete:execution.complete.pipe(Effect.provideService(PreparationRef,preparation)),
        })))}}:{}}};
    });
    return SessionModelRequest.Service.of({primary:input=>prepare('primary',input,inner.primary(input)),title:input=>prepare('title',input,inner.title(input)),
      compaction:input=>prepare('compaction',input,inner.compaction(input)),generate:input=>prepare('generate',input,inner.generate(input))});
  })).pipe(Layer.provide(original))));
  const decorateHooks=(inner:PluginHooks.Interface):PluginHooks.Interface=>({...inner,
    trigger:(domain,name,event)=>inner.trigger(domain,name,event).pipe(Effect.tap(result=>Effect.gen(function*(){
      if(domain!=='session'||name!=='experimental.ws.send')return;
      const preparation=yield* PreparationRef;
      if(preparation)yield* physical(preparation.observed,'ws',preparation.nextOrdinal(),result!==null&&typeof result==='object'&&'frame' in result?result.frame:undefined);
    })))});
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
      yield* emit({schema:1,stage:'step-link',controllerInstanceID:options.controllerInstanceID,configurationDigest:options.configurationDigest,
        sessionID:step.data.sessionID,directory,eventID:step.id,sequence:step.durable.seq,created:step.created,assistantMessageID:step.data.assistantMessageID,
        execution:{agent:step.data.agent,providerID:step.data.model.providerID,modelID:step.data.model.id,variant:step.data.model.variant??null},attempt:yield* currentNativeAttemptIdentity});
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
      witness:{recent:'recent' in raw.data?witness(raw.data.recent):null,text:'text' in raw.data?witness(raw.data.text):null,
        providerState:'providerState' in raw.data?witness(raw.data.providerState):null,providerContext:'providerContext' in raw.data?witness(raw.data.providerContext):null}});
  }).pipe(Effect.catchCause(()=>Effect.logWarning('native_observation_unavailable',{stage:'committed-event'})));
  return {overrides:[requests,compactions],observePublished,decorateHooks};
}
