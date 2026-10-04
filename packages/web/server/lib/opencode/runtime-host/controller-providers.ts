import {randomUUID} from 'node:crypto';
import {LanguageModel,LLMRequest} from '@opencode/ai';
import {Agent} from '@opencode/core/agent';
import {Location} from '@opencode/core/location';
import {SessionModelRequest} from '@opencode/core/session/model-request';
import type {HttpMiddleware} from '@opencode/ai/route';
import {Context,Effect,Layer,Option} from 'effect';
import {HttpClientRequest} from 'effect/unstable/http';
import {OperationPermitRef,requestPermit} from './native-admission-contract.js';
import {HostRefusal} from './host-refusal.js';
import {createNativeProviderCompatibility} from './native-provider-compat-plugin.js';
import type {createControllerIntegrations} from './controller-integrations.js';
import type {NativeConfigurationSnapshot} from './native-configuration-snapshot.js';
import type {NativeMeridianAttempt,NativeMeridianAttemptBinding,NativeProviderAttempt} from './native-provider-runtime-owner.js';
import type {RegistrationOrigin} from './registration-origin.js';

export interface ControllerProvidersOptions{
 readonly controllerInstanceID:string;
 readonly configurationSnapshot:NativeConfigurationSnapshot;
 readonly origin:RegistrationOrigin;
 readonly scrubSystem:(text:string)=>string;
 readonly integrations:Pick<ReturnType<typeof createControllerIntegrations>,'discoverCopilot'|'readCatalogSelectionOwned'>;
 readonly rpc:(method:string,input:unknown,options?:{readonly signal:AbortSignal})=>Promise<unknown>;
 readonly isBound:()=>boolean;readonly isExecutionReady:()=>boolean;
}
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function fail(code:string):never{throw new HostRefusal(code,403,'controller.providers');}
const parseAttempt=(value:unknown,input:Omit<NativeProviderAttempt,'signal'>):NativeMeridianAttempt=>{
 if(!record(value)||Object.keys(value).some(key=>!['attemptID','origin','directory','sessionID','controllerInstanceID','authorization'].includes(key))||typeof value.attemptID!=='string'||!/^[a-f0-9]{64}$/.test(value.attemptID)||typeof value.origin!=='string'||typeof value.authorization!=='string'||!/^[a-f0-9]{64}$/.test(value.authorization)||value.directory!==input.directory||value.sessionID!==input.sessionID||value.controllerInstanceID!==input.controllerInstanceID)return fail('native_provider_attempt_binding_invalid');
 const url=new URL(value.origin);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash)return fail('native_provider_origin_invalid');
 return {attemptID:value.attemptID,origin:url.origin,authorization:value.authorization,directory:input.directory,sessionID:input.sessionID,controllerInstanceID:input.controllerInstanceID};
};
/** Preserve native provider hooks and parsers. Only an actual request transport
 * scope can acquire the private Meridian URL, and that scope owns its release. */
export function createControllerProviders(options:ControllerProvidersOptions){
 if(options.origin.kind!=='plugin'||options.origin.id!=='devryan.provider-compat')fail('native_provider_origin_unreviewed');
 const locations=new Map(structuredClone(options.configurationSnapshot.locations).map(location=>[location.directory,location]));let closed=false;
 const current=(directory:string)=>{if(closed||!locations.has(directory)||!options.isBound()||!options.isExecutionReady())fail('native_provider_location_expired');};
 const compatibility=createNativeProviderCompatibility({scrubAnthropicSystem:options.scrubSystem,discoverCopilot:options.integrations.discoverCopilot,policyForDirectory:directory=>{
  const configuration=locations.get(directory)?.compatibility.legacy;
  const compaction=record(configuration?.compaction)?configuration.compaction:{};
  const reserved=compaction.reserved;
  return {compactionReserved:typeof reserved==='number'&&Number.isFinite(reserved)?reserved:undefined};
 }});
 interface OwnedAttempt{readonly binding:NativeMeridianAttempt;readonly agentName:string;readonly agentMode:'primary'|'subagent'|'all';readonly requestID:string}
 const Attempt=Context.Reference<OwnedAttempt|undefined>('DevRyan/PhysicalMeridianAttempt',{defaultValue:()=>undefined});
 const binding=(attempt:NativeMeridianAttempt):NativeMeridianAttemptBinding=>({attemptID:attempt.attemptID,directory:attempt.directory,sessionID:attempt.sessionID,controllerInstanceID:attempt.controllerInstanceID});
 const rpc=(method:string,input:unknown)=>Effect.tryPromise({try:signal=>options.rpc(method,input,{signal}),catch:error=>error instanceof Error?error:new Error('native_provider_rpc_failed')});
 const decorateModelRequests=(inner:SessionModelRequest.Interface)=>Effect.gen(function*(){
  const context=yield* Effect.context<never>();const location=Option.getOrUndefined(Context.getOption(context,Location.Service)),agents=Option.getOrUndefined(Context.getOption(context,Agent.Service));if(!location||!agents)fail('native_provider_location_required');let active=true;
  yield* Effect.addFinalizer(()=>Effect.sync(()=>{active=false;}));
  const wrap=<Event>(kind:NativeProviderAttempt['kind'],input:SessionModelRequest.Input,read:Effect.Effect<SessionModelRequest.Prepared<Event>>)=>Effect.gen(function*(){
   const prepared=yield* read;if(input.model.ref.providerID!=='anthropic')return prepared;
   if(!active)fail('native_provider_location_expired');current(location.directory);
   if(prepared.options.webSocket)fail('native_meridian_websocket_unsupported');
   const agent=yield* agents.get(input.agent);if(!agent)fail('native_provider_agent_unavailable');
   const originalHttp=prepared.options.http;
   const middleware:HttpMiddleware=(request,handler)=>Effect.gen(function*(){
    const owned=yield* Attempt;if(!owned||!active)fail('native_provider_attempt_scope_required');current(location.directory);
    const finalHandler:typeof handler=sent=>Effect.gen(function*(){
     yield* rpc('provider.meridian.assert',binding(owned.binding));current(location.directory);
     const physical=yield* HttpClientRequest.toWeb(sent);const url=new URL(physical.url);
     if(url.username||url.password||url.hash||url.pathname!=='/v1/messages')fail('native_meridian_route_unreviewed');
     const headers=new Headers(physical.headers);headers.delete('anthropic-beta');headers.delete('x-api-key');headers.set('authorization','Bearer '+owned.binding.authorization);headers.set('x-devryan-provider-attempt',owned.binding.attemptID);
     headers.set('x-devryan-directory',encodeURIComponent(location.directory));headers.set('x-opencode-directory',encodeURIComponent(location.directory));
     headers.set('x-opencode-session',input.session.id);headers.set('x-opencode-request',owned.requestID);headers.set('x-opencode-agent-name',owned.agentName);headers.set('x-opencode-agent-mode',owned.agentMode);
     const target=new Request(owned.binding.origin+url.pathname+url.search,new Request(physical,{headers}));
     let next=HttpClientRequest.fromWeb(target);if(target.body)next=HttpClientRequest.bodyUint8Array(next,new Uint8Array(yield* Effect.promise(()=>target.clone().arrayBuffer())),target.headers.get('content-type')??undefined);
     return yield* handler(next);
    });
    return yield* (originalHttp?originalHttp(request,finalHandler):finalHandler(request));
   });
   const source=prepared.request.model.route,transport=source.transport;
   const route=source.with({transport:{...transport,execute:(value,request,runtime,settings)=>Effect.gen(function*(){
    if(!active)fail('native_provider_location_expired');current(location.directory);
    const permit=(yield* OperationPermitRef)??requestPermit();if(!permit)fail('native_provider_attempt_scope_required');
    const requestInput={directory:location.directory,controllerInstanceID:options.controllerInstanceID,sessionID:input.session.id,kind,permit};
    const attempt=yield* Effect.acquireRelease(rpc('provider.meridian.begin',requestInput).pipe(Effect.map(value=>parseAttempt(value,requestInput)),Effect.orDie),attempt=>rpc('provider.meridian.end',binding(attempt)).pipe(Effect.orDie));
    if(!active)fail('native_provider_location_expired');current(location.directory);
    return yield* transport.execute(value,request,runtime,settings).pipe(Effect.provideService(Attempt,{binding:attempt,agentName:agent.name.replace(/[^\x20-\x7e]/g,'').trim()||'unknown',agentMode:agent.mode,requestID:'req_'+randomUUID()}));
   })}});
   return {...prepared,request:LLMRequest.update(prepared.request,{model:LanguageModel.update(prepared.request.model,{route})}),options:{...prepared.options,http:middleware}};
  });
  return {...inner,primary:input=>wrap('primary',input,inner.primary(input)),title:input=>wrap('title',input,inner.title(input)),compaction:input=>wrap('compaction',input,inner.compaction(input)),generate:input=>wrap('generate',input,inner.generate(input))} satisfies SessionModelRequest.Interface;
 });
 const override=SessionModelRequest.node.replace(SessionModelRequest.node.mapLayer(original=>Layer.effect(SessionModelRequest.Service,
  Effect.gen(function*(){return yield* decorateModelRequests(yield* SessionModelRequest.Service);})).pipe(Layer.provide(original))));
 return {plugin:compatibility.plugin,catalogOverrides:compatibility.overrides,decorateModelRequests,overrides:[...compatibility.overrides,override],readCatalogSelectionOwned:options.integrations.readCatalogSelectionOwned,close:()=>{closed=true;}};
}
