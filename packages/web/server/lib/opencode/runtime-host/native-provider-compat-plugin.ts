import {Integration as NativeIntegration} from '@opencode/core/integration';
import {SystemPart} from '@opencode/ai';
import {Location} from '@opencode/core/location';
import {Layer} from 'effect';
import {Model} from '@opencode/core/model';
import {Plugin} from '@opencode/plugin/effect';
import type {IntegrationDomain} from '@opencode/plugin/effect/integration';
import {Context,Effect,Option,Schema,Stream} from 'effect';
import {normalizeNativeOpenAiModels,normalizeNativeOpenAiRequest,nativeCopilotModelsFromAccount,nativeEncodableModels} from './native-provider-compat.js';
import {nativeCatalogStageFailure,withNativeCatalogStage} from './native-catalog-diagnostics.js';

export interface NativeProviderCompatibilityOptions {
  readonly policyForDirectory:(directory:string)=>{readonly compactionReserved?:number};
  /** The current scoped native Integration domain; no credential value crosses this callback. */
  readonly isOpenAiOAuth?:(input:{directory:string;integration:NativeIntegration.Interface})=>Effect.Effect<boolean>;
  /** Original-caller discovery owns networking and selected-connection reauthorization. */
  readonly discoverCopilot?:(input:{directory:string;integration:NativeIntegration.Interface})=>Effect.Effect<unknown>;
  readonly scrubAnthropicSystem?:(text:string)=>string;
}
const openaiOAuth=(integration:Pick<IntegrationDomain,'connection'>)=>Effect.gen(function*(){
  const connection=yield* integration.connection.active('openai');
  const value=connection?yield* integration.connection.resolve(connection).pipe(Effect.orElseSucceed(()=>undefined)):undefined;
  return value?.type==='oauth'&&['chatgpt-siwc'].includes(value.methodID);
});

/** Scoped registered data policy; the final physical credential hooks remain owned separately. */
export const createNativeProviderCompatibility=(options:NativeProviderCompatibilityOptions)=>{
  const modelOverride=Model.node.replace(Model.node.mapLayer(original=>{
    const reviewed=original.pipe(Layer.catchCause(cause=>Layer.effect(Model.Service,nativeCatalogStageFailure(cause,'native_model_build_failed'))));
    return Layer.effect(Model.Service,Effect.gen(function*(){
    const inner=yield* Model.Service,context=yield* Effect.context<never>();
    const integration=Option.getOrUndefined(Context.getOption(context,NativeIntegration.Service));
    const location=Option.getOrUndefined(Context.getOption(context,Location.Service));
    if(!integration||!location)return yield* Effect.die(new Error('native_provider_location_required'));
    const policy=Object.freeze({...options.policyForDirectory(location.directory)});let active=true;
    yield* Effect.addFinalizer(()=>Effect.sync(()=>{active=false;}));
    const normalize=(models:readonly Model.Info[])=>Effect.gen(function*(){
      if(!active)return yield* Effect.die(new Error('native_provider_location_expired'));
      models=yield* withNativeCatalogStage(Effect.sync(()=>nativeEncodableModels(models)), 'native_model_normalize_failed');
      const connection=yield* withNativeCatalogStage(integration.connection.active(Schema.decodeUnknownSync(NativeIntegration.ID)('openai')), 'native_model_account_failed');
      const value=connection?yield* withNativeCatalogStage(integration.connection.resolve(connection).pipe(Effect.orElseSucceed(()=>undefined)), 'native_model_account_failed'):undefined;
      const oauth=options.isOpenAiOAuth?yield* withNativeCatalogStage(options.isOpenAiOAuth({directory:location.directory,integration}), 'native_model_account_failed'):value?.type==='oauth'&&['chatgpt-siwc'].includes(value.methodID);
      if(!active)return yield* Effect.die(new Error('native_provider_location_expired'));
      const normalized=yield* withNativeCatalogStage(Effect.sync(()=>normalizeNativeOpenAiModels(models,{oauth,...policy})), 'native_model_normalize_failed');
      const rows=options.discoverCopilot?yield* withNativeCatalogStage(options.discoverCopilot({directory:location.directory,integration}), 'native_model_account_failed'):undefined;
      if(!active)return yield* Effect.die(new Error('native_provider_location_expired'));
      return Array.isArray(rows)?yield* withNativeCatalogStage(Effect.sync(()=>nativeEncodableModels([...normalized.filter(model=>model.providerID!=='github-copilot'),...nativeCopilotModelsFromAccount(rows,normalized.filter(model=>model.providerID==='github-copilot'))])), 'native_model_normalize_failed'):nativeEncodableModels(normalized);
    });
    const current=<A,E,R>(read:Effect.Effect<A,E,R>)=>Effect.suspend(()=>active?read:Effect.die(new Error('native_provider_location_expired'))).pipe(Effect.flatMap(value=>active?Effect.succeed(value):Effect.die(new Error('native_provider_location_expired'))));
    const read=<A>(effect:Effect.Effect<A>)=>withNativeCatalogStage(current(effect),'native_model_read_failed');
    const one=(effect:Effect.Effect<Model.Info|undefined>)=>read(effect).pipe(Effect.flatMap(model=>model?normalize([model]).pipe(Effect.map(rows=>rows.find(row=>row.providerID===model.providerID&&row.id===model.id))):Effect.succeed(undefined)));
    return {...inner,get:(providerID,modelID)=>providerID==='github-copilot'?read(inner.all()).pipe(Effect.flatMap(normalize),Effect.map(rows=>rows.find(model=>model.providerID===providerID&&model.id===modelID))):one(inner.get(providerID,modelID)),all:()=>read(inner.all()).pipe(Effect.flatMap(normalize)),available:()=>read(inner.available()).pipe(Effect.flatMap(normalize)),default:()=>one(inner.default()),small:providerID=>one(inner.small(providerID))} satisfies Model.Interface;
  })).pipe(Layer.provide(reviewed));
  }));
  const plugin=Plugin.define({
  id:'devryan.provider-compat',effect:ctx=>Effect.gen(function*(){
    const directory=ctx.location.directory;
    let active=true;
    yield* Effect.addFinalizer(()=>Effect.sync(()=>{active=false;}));
    const scrub=options.scrubAnthropicSystem;
    if(scrub)for(const name of ['context','compaction','title','generate'] as const)yield* ctx.session.hook(name,event=>Effect.sync(()=>{
      if(!active||event.model.providerID!=='anthropic')return;
      const original=event.system.map(part=>part.text).join('\n\n'),scrubbed=scrub(original);
      if(scrubbed!==original)event.system.splice(0,event.system.length,SystemPart.make(scrubbed));
    }),{providerID:'anthropic'});
    for(const name of ['context','compaction','title','generate'] as const)yield* ctx.session.hook(name,event=>Effect.gen(function*(){
      if(!active||event.model.providerID!=='openai')return;
      const models=yield* ctx.model.list({location:{directory}}).pipe(Effect.orDie);
      const model=models.data.find(row=>row.providerID===event.model.providerID&&row.id===event.model.id);if(!model)return;
      const currentOAuth=yield* openaiOAuth(ctx.integration);if(!active)return;
      const next=normalizeNativeOpenAiRequest(model,event.options,{}, {oauth:currentOAuth});
      if(next.settings!==event.options)event.options={...event.options,...next.settings};
      // Removed Spark summaries must not survive a spread over the old options.
      if(next.settings&&!Object.hasOwn(next.settings,'reasoningSummary'))delete event.options.reasoningSummary;
    }),{providerID:'openai'});
    yield* ctx.session.hook('model.request',event=>Effect.gen(function*(){
      if(!active||event.model.providerID!=='openai')return;
      const models=yield* ctx.model.list({location:{directory}}).pipe(Effect.orDie);
      const model=models.data.find(row=>row.providerID===event.model.providerID&&row.id===event.model.id);if(!model)return;
      const currentOAuth=yield* openaiOAuth(ctx.integration);if(!active)return;
      Object.assign(event.headers,normalizeNativeOpenAiRequest(model,undefined,event.headers,{oauth:currentOAuth}).headers);
    }),{providerID:'openai'});
    const refresh=ctx.provider.reload().pipe(Effect.andThen(ctx.model.reload()));
    yield* ctx.event.subscribe().pipe(Stream.filter(event=>event.type==='credential.switched'&&(!event.location||event.location.directory===directory)&&['openai','github-copilot'].includes(event.data.integrationID)),
      Stream.runForEach(()=>refresh),Effect.forkScoped({startImmediately:true}));
  }),
});
  return {plugin,overrides:[modelOverride]};
};
