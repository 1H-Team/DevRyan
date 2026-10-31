import {Location} from '@opencode/core/location';
import {SessionModelRequest} from '@opencode/core/session/model-request';
import {Context,Effect,Layer,Option} from 'effect';
import {HostRefusal} from './host-refusal.js';
import {createNativeProviderCompatibility} from './native-provider-compat-plugin.js';
import type {createControllerIntegrations} from './controller-integrations.js';
import type {NativeConfigurationSnapshot} from './native-configuration-snapshot.js';
import type {RegistrationOrigin} from './registration-origin.js';
import {nativeCompactionReserve} from './native-compaction-policy.js';

export interface ControllerProvidersOptions{
 readonly controllerInstanceID:string;
 readonly configurationSnapshot:NativeConfigurationSnapshot;
 readonly origin:RegistrationOrigin;
 readonly integrations:Pick<ReturnType<typeof createControllerIntegrations>,'discoverCopilot'|'readCatalogSelectionOwned'|'requiresOpenAiHttp'|'isOpenAiTokenSharing'>;
 readonly isBound:()=>boolean;readonly isExecutionReady:()=>boolean;
}
function fail(code:string):never{throw new HostRefusal(code,403,'controller.providers');}
/** Preserve native provider hooks and parsers; OpenAI OAuth requests keep HTTP transport. */
export function createControllerProviders(options:ControllerProvidersOptions){
 if(options.origin.kind!=='plugin'||options.origin.id!=='devryan.provider-compat')fail('native_provider_origin_unreviewed');
 const locations=new Map(structuredClone(options.configurationSnapshot.locations).map(location=>[location.directory,location]));let closed=false;
 const current=(directory:string)=>{if(closed||!locations.has(directory)||!options.isBound()||!options.isExecutionReady())fail('native_provider_location_expired');};
 const compatibility=createNativeProviderCompatibility({isOpenAiOAuth:options.integrations.isOpenAiTokenSharing,discoverCopilot:options.integrations.discoverCopilot,policyForDirectory:directory=>{
  return {compactionReserved:nativeCompactionReserve(locations.get(directory))};
 }});
 const decorateModelRequests=(inner:SessionModelRequest.Interface)=>Effect.gen(function*(){
  const context=yield* Effect.context<never>();const location=Option.getOrUndefined(Context.getOption(context,Location.Service));if(!location)fail('native_provider_location_required');let active=true;
  yield* Effect.addFinalizer(()=>Effect.sync(()=>{active=false;}));
  const wrap=<Event>(input:SessionModelRequest.Input,read:Effect.Effect<SessionModelRequest.Prepared<Event>>)=>Effect.gen(function*(){
   const prepared=yield* read;
   if(input.model.ref.providerID==='openai'){
    if(prepared.options.webSocket===undefined)return prepared;
    if(!active)fail('native_provider_location_expired');current(location.directory);
    const requiresHttp=yield* options.integrations.requiresOpenAiHttp(location.directory);
    if(!active)fail('native_provider_location_expired');current(location.directory);
    if(!requiresHttp)return prepared;
    const requestOptions={...prepared.options};delete requestOptions.webSocket;
    return {...prepared,options:requestOptions};
   }
   return prepared;
  });
  return {...inner,primary:input=>wrap(input,inner.primary(input)),title:input=>wrap(input,inner.title(input)),compaction:input=>wrap(input,inner.compaction(input)),generate:input=>wrap(input,inner.generate(input))} satisfies SessionModelRequest.Interface;
 });
 const override=SessionModelRequest.node.replace(SessionModelRequest.node.mapLayer(original=>Layer.effect(SessionModelRequest.Service,
  Effect.gen(function*(){return yield* decorateModelRequests(yield* SessionModelRequest.Service);})).pipe(Layer.provide(original))));
 return {plugin:compatibility.plugin,catalogOverrides:compatibility.overrides,decorateModelRequests,overrides:[...compatibility.overrides,override],readCatalogSelectionOwned:options.integrations.readCatalogSelectionOwned,close:()=>{closed=true;}};
}
