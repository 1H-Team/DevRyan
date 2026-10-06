import {randomUUID} from 'node:crypto';
import {KV} from '@opencode/core/kv';
import {Database} from '@opencode/core/database/database';
import {Credential} from '@opencode/core/credential';
import {Integration} from '@opencode/core/integration';
import type {PluginHooks} from '@opencode/core/plugin/hooks';
import {Location} from '@opencode/core/location';
import {LayerNode} from '@opencode/util/effect/layer-node';
import {Context,Effect,Layer,Logger,Option,Schema} from 'effect';
import {CredentialAuthorizationRef,isOwnedProviderIntegration,type OwnedProviderIntegration,type CredentialMutationBinding} from './credential-mutation-contract.js';
import {createCredentialMutationBridge} from './credential-mutation-bridge.js';
import {createControllerProviderCredentials} from './controller-provider-credentials.js';
import {createControllerCursorCredentials} from './controller-cursor-credentials.js';
import {createNativeOpenAi} from './native-openai.js';
import type {NativeOpenAiAttempt} from './native-openai-auth.js';
import {createOwnedRemoteMcp,type OwnedRemoteMcpOptions} from './remote-mcp.js';
import {reviewedMcpConfiguration} from './reviewed-mcp-configuration.js';
import type {NativeConfigurationSnapshot} from './native-configuration-snapshot.js';
import {decodeNativeConfigurationSnapshot} from './native-configuration.js';
import type {NativeIntegrationBinding} from './native-integration-authorization.js';
import {credentialMutationFingerprint} from './native-credential-mutation-owner.js';
import {requestIntegrationGrant,runWithIntegrationGrant} from './native-integration-context.js';
import type {RegistrationOrigin} from './registration-origin.js';
import {HostRefusal} from './host-refusal.js';
import {createControllerClaudeLifecycle} from './native-claude-lifecycle-kv.js';
import type {NativeCursorSettlement,NativeCursorReadOnlyKey} from './native-cursor-owner.js';

export interface ControllerIntegrationsOptions {
  readonly bootstrapCredentials?:()=>Effect.Effect<void,unknown,Credential.Service|KV.Service|Database.Service>;
  readonly controllerInstanceID:string;
  readonly configurationSnapshot:NativeConfigurationSnapshot;
  readonly rpc:(method:string,input:unknown,options?:{readonly signal:AbortSignal})=>Promise<unknown>;
  readonly registrationOrigin:RegistrationOrigin;
  readonly providerCompatibilityOrigin?:RegistrationOrigin;
  readonly reviewedNativeProviderOrigin?:RegistrationOrigin;
  readonly reviewedConfigurationOrigins:ReadonlyMap<string,RegistrationOrigin>;
  readonly isBound:()=>boolean;readonly isExecutionReady:()=>boolean;
  readonly executeOwnedFallback:OwnedRemoteMcpOptions['executeOwnedFallback'];
  readonly authorizeMcpCall:OwnedRemoteMcpOptions['authorizeCall'];
  readonly authorizeCursorKey?:(input:NativeCursorSettlement)=>Effect.Effect<void>;
  readonly authorizeCursorReadOnlyKey?:(input:NativeCursorReadOnlyKey)=>Effect.Effect<void>;
}
export type ControllerCredentialMutation =
  | {readonly operation:'create';readonly input:Parameters<Credential.Interface['create']>[0]}
  | {readonly operation:'update';readonly id:Credential.ID;readonly updates:Parameters<Credential.Interface['update']>[1]}
  | {readonly operation:'activate'|'remove';readonly id:Credential.ID};
const record=(input:unknown):input is Record<string,unknown>=>input!==null&&typeof input==='object'&&!Array.isArray(input);
const refuse=(code:string):never=>{throw new HostRefusal(code,403,'controller.integrations');};

/** One Credential service and one location-owned Integration service. Original
 * browser grant handles are transported explicitly; the private RPC bearer is
 * never an integration or credential grant. */
export function createControllerIntegrations(options:ControllerIntegrationsOptions){
  const snapshot=structuredClone(options.configurationSnapshot);
  const configurations=decodeNativeConfigurationSnapshot(snapshot);
  const reviewed=reviewedMcpConfiguration(snapshot,configurations.map(location=>location.directory));
  const digests=new Map<string,string>();
  for(const location of configurations){
    if(digests.has(location.directory))refuse('native_integration_location_duplicate');
    const raw=snapshot.locations.find(row=>row.directory===location.directory);
    if(!raw)return refuse('native_integration_location_required');
    const providers=record(raw.configuration.providers)?raw.configuration.providers:{};
    digests.set(location.directory,credentialMutationFingerprint(providers.openai??{}));
  }
  interface Acquisition{readonly id:string;readonly directory:string;readonly inner:Integration.Interface;mcpInner:Integration.Interface;readonly location:Location.Interface;readonly credentials:Credential.Interface;integration?:Integration.Interface;closed:boolean}
  const acquisitions=new Map<string,Acquisition>(),retained=new Set<Acquisition>();
  const CapturedAcquisition=Context.Reference<Acquisition|undefined>('DevRyan/IntegrationCredentialAcquisition',{defaultValue:()=>undefined});
  let composedCredentials:Credential.Interface|undefined;
  let claudeLifecycle:ReturnType<typeof createControllerClaudeLifecycle>|undefined;
  let closed=false;
  const assertAcquisition=(acquisition:Acquisition)=>{
    if(closed||acquisition.closed||acquisitions.get(acquisition.directory)!==acquisition)return refuse('native_integration_acquisition_expired');
  };
  const openaiBinding=(input:{directory:string;methodID?:string}):NativeIntegrationBinding=>{
    const acquisition=acquisitions.get(input.directory),configurationDigest=digests.get(input.directory);
    if(closed||!acquisition||acquisition.closed||!configurationDigest)return refuse('native_integration_acquisition_expired');
    if(input.methodID!==undefined&&input.methodID!=='chatgpt-siwc')refuse('native_openai_method_unsupported');
    return {kind:'openai',directory:input.directory,controllerInstanceID:options.controllerInstanceID,integrationID:'openai',
      acquisitionID:acquisition.id,configurationDigest,...(input.methodID==='chatgpt-siwc'?{methodID:input.methodID}:{})};
  };
  const cursorBinding=(directory:string):NativeIntegrationBinding=>{
    const acquisition=acquisitions.get(directory);
    if(!acquisition)return refuse('native_integration_acquisition_expired');
    assertAcquisition(acquisition);
    const configuration=snapshot.locations.find(location=>location.directory===directory)?.configuration;
    return {kind:'cursor',directory,controllerInstanceID:options.controllerInstanceID,integrationID:'cursor-acp',
      acquisitionID:acquisition.id,configurationDigest:credentialMutationFingerprint(record(configuration?.providers)?configuration.providers['cursor-acp']??{}:{})};
  };
  const providerBinding=(directory:string,integrationID:OwnedProviderIntegration,methodID?:string):NativeIntegrationBinding=>{
    const acquisition=acquisitions.get(directory);if(!acquisition)return refuse('native_integration_acquisition_expired');
    assertAcquisition(acquisition);
    if(methodID!==undefined&&(integrationID!=='xai'||methodID!=='device'))return refuse('native_provider_method_unsupported');
    const configuration=snapshot.locations.find(location=>location.directory===directory)?.configuration;
    return {kind:'provider',directory,integrationID,controllerInstanceID:options.controllerInstanceID,acquisitionID:acquisition.id,
      configurationDigest:credentialMutationFingerprint(record(configuration?.providers)?configuration.providers[integrationID]??{}:{}),
      ...(methodID==='device'?{methodID:'device'}:{})};
  };
  const fullBinding=(binding:CredentialMutationBinding):NativeIntegrationBinding=>{
    if(binding.kind==='openai'){
      if(binding.valueType==='oauth'&&binding.operation==='remove'&&(binding.methodID==='chatgpt-browser'||binding.methodID==='chatgpt-headless'))return {...openaiBinding({directory:binding.directory}),kind:'openai',methodID:binding.methodID};
      return openaiBinding(binding);
    }
    if(binding.kind==='cursor')return cursorBinding(binding.directory);
    if(binding.kind==='provider')return providerBinding(binding.directory,binding.integrationID,binding.valueType==='oauth'?binding.methodID:undefined);
    if(binding.valueType!=='oauth')return refuse('native_mcp_credential_scope_required');
    return {...binding,controllerInstanceID:options.controllerInstanceID};
  };
  const reauthorize=(authorizationID:string,binding:NativeIntegrationBinding)=>Effect.promise(async()=>{
    if(closed)refuse('native_integration_acquisition_expired');
    if(binding.kind!=='mcp'&&acquisitions.get(binding.directory)?.id!==binding.acquisitionID)refuse('native_integration_acquisition_expired');
    await options.rpc('integration.reauthorize',{authorizationID,binding});
    if(closed)refuse('native_integration_acquisition_expired');
    if(binding.kind!=='mcp'&&acquisitions.get(binding.directory)?.id!==binding.acquisitionID)refuse('native_integration_acquisition_expired');
  });
  const capture=(binding:NativeIntegrationBinding,operation:'oauth'|'connection'|'mutation',mutation?:CredentialMutationBinding)=>Effect.gen(function*(){
    if(closed)refuse('native_integration_acquisition_expired');
    const result=yield* Effect.promise(()=>options.rpc('integration.capture',{binding:{...binding,...mutation},operation,requestAuthorization:requestIntegrationGrant()}));
    if(!record(result)||typeof result.authorizationID!=='string'||! /^[a-f0-9]{64}$/.test(result.authorizationID))return refuse('native_integration_grant_invalid');
    if(closed)refuse('native_integration_acquisition_expired');
    return {authorizationID:result.authorizationID,reauthorize:reauthorize(result.authorizationID,binding)};
  });
  const mutation=createCredentialMutationBridge({controllerInstanceID:options.controllerInstanceID,rpc:options.rpc,
    captureAuthorization:binding=>Effect.gen(function*(){
      const captured=yield* CapturedAcquisition;if(captured)assertAcquisition(captured);
      const full=fullBinding(binding),authorizationID=yield* CredentialAuthorizationRef;
      if(authorizationID)return {authorizationID,reauthorize:reauthorize(authorizationID,full)};
      return yield* capture(full,'mutation',binding);
    })});
  const openai=createNativeOpenAi({controllerIdentity:()=>closed?undefined:options.controllerInstanceID,
    isBound:options.isBound,isExecutionReady:options.isExecutionReady,withCredentialMutation:mutation.withCredentialMutation,
    captureOAuthGrant:input=>capture(openaiBinding(input),'oauth'),
    assertAttempt:input=>Effect.promise(async()=>{await options.rpc('openai.attempt',input);}),
    access:async input=>{
      const value=await options.rpc('openai.access',input);
      if(value===undefined||value===null)return undefined;
      if(!record(value)||typeof value.credentialID!=='string'||typeof value.methodID!=='string'||typeof value.accountId!=='string'
        ||typeof value.accessToken!=='string'||typeof value.expiresAt!=='number'||!Number.isFinite(value.expiresAt)||typeof value.generation!=='string')return refuse('native_openai_access_invalid');
      if(value.credentialID!==input.credentialID||!['chatgpt-siwc'].includes(value.methodID))return refuse('native_openai_access_invalid');
      return {credentialID:value.credentialID,methodID:value.methodID,accountId:value.accountId,accessToken:value.accessToken,expiresAt:value.expiresAt,generation:value.generation} satisfies NativeOpenAiAttempt;
    }});
  const mcp=createOwnedRemoteMcp({reviewedServersByDirectory:reviewed,registrationOrigin:options.registrationOrigin,
    reviewedConfigurationOrigins:options.reviewedConfigurationOrigins,controllerInstanceID:options.controllerInstanceID,
    executeOwnedFallback:options.executeOwnedFallback,authorizeCall:options.authorizeMcpCall,withCredentialMutation:mutation.withCredentialMutation,
    captureOAuthGrant:binding=>capture({...binding,kind:'mcp',controllerInstanceID:options.controllerInstanceID},'oauth'),
    captureConnectionGrant:binding=>capture({...binding,kind:'mcp',controllerInstanceID:options.controllerInstanceID},'connection'),
    captureRemovalGrant:binding=>Effect.gen(function*(){
      const result=yield* Effect.promise(()=>options.rpc('integration.capture',{binding:{...binding,kind:'mcp',controllerInstanceID:options.controllerInstanceID},operation:'remove',requestAuthorization:requestIntegrationGrant()}));
      if(!record(result)||typeof result.authorizationID!=='string'||! /^[a-f0-9]{64}$/.test(result.authorizationID))return refuse('native_integration_grant_invalid');
      return {authorizationID:result.authorizationID,reauthorize:reauthorize(result.authorizationID,{...binding,kind:'mcp',controllerInstanceID:options.controllerInstanceID})};
    }),
    authorizeControl:(binding,operation,action)=>Effect.gen(function*(){
      yield* Effect.promise(()=>options.rpc('integration.control',{binding:{...binding,kind:'mcp',controllerInstanceID:options.controllerInstanceID},operation,requestAuthorization:requestIntegrationGrant()}));
      return yield* action;
    })});
  const cursor=createControllerCursorCredentials({controllerInstanceID:options.controllerInstanceID,
    withCredentialMutation:mutation.withCredentialMutation,captureLocation:directory=>{
      cursorBinding(directory);const acquisition=acquisitions.get(directory);
      if(!acquisition)return refuse('native_integration_acquisition_expired');
      return ()=>assertAcquisition(acquisition);
    }});
  const provider=createControllerProviderCredentials({controllerInstanceID:options.controllerInstanceID,
    withCredentialMutation:mutation.withCredentialMutation,withCredentialResolution:mutation.withCredentialResolution,
    captureLocation:(directory,integrationID)=>{
      const binding=providerBinding(directory,integrationID),acquisition=acquisitions.get(directory);
      if(!acquisition)return refuse('native_integration_acquisition_expired');
      return {acquisitionID:binding.acquisitionID,configurationDigest:binding.configurationDigest,assertCurrent:()=>assertAcquisition(acquisition)};
    },
    assertAttempt:input=>Effect.promise(()=>options.rpc('provider.attempt',input)).pipe(Effect.asVoid),
    assertResolution:binding=>Effect.promise(()=>options.rpc('provider.credential.assert',binding)).pipe(Effect.asVoid),
    captureOAuthGrant:directory=>capture(providerBinding(directory,'xai','device'),'oauth'),
    reviewedNativeProviderOrigin:options.reviewedNativeProviderOrigin,
    ownsDelegatedIntegration:id=>id==='openai'||id==='cursor-acp'||mcp.ownsCredentialIntegration(id),
  });
  const closeAcquisition=(acquisition:Acquisition)=>Effect.gen(function*(){
    acquisition.closed=true;
    if(acquisitions.get(acquisition.directory)===acquisition)acquisitions.delete(acquisition.directory);
    yield* openai.closeLocation(acquisition.directory,acquisition.inner);
    retained.delete(acquisition);
  });
  const overrides=[...mcp.overrides,...provider.overrides,
    Credential.node.replace(LayerNode.make({service:Credential.Service,tag:Credential.node.tag,
      // Keep the original dependency wiring; KV is not a dependency of Credential itself.
      deps:[Credential.node.mapLayer(original=>original),Database.node,KV.node],
      layer:Layer.effect(Credential.Service,Effect.gen(function*(){
      const inner=yield* Credential.Service;
      claudeLifecycle=createControllerClaudeLifecycle({controllerInstanceID:options.controllerInstanceID,kv:yield* KV.Service,database:yield* Database.Service,isCurrent:()=>!closed&&options.isBound()});
      if(options.bootstrapCredentials)yield* options.bootstrapCredentials().pipe(Effect.orDie);
      composedCredentials=provider.decorateCredential(mcp.decorateCredential(openai.decorateCredential(cursor.decorateCredential(inner))));return composedCredentials;
    }))})),
    Integration.node.replace(Integration.node.mapLayer(original=>Layer.effect(Integration.Service,Effect.gen(function*(){
      const inner=yield* Integration.Service;
      const location=Option.getOrUndefined(Context.getOption(yield* Effect.context<never>(),Location.Service));
      if(!location)return refuse('native_integration_location_required');
      if(closed||!digests.has(location.directory)||acquisitions.has(location.directory))return refuse('native_integration_acquisition_expired');
      if(!composedCredentials)return refuse('native_integration_credentials_required');
      // The existing external SDK provides Cursor models without a saved provider stanza.
      // Native owns only its key account; no generic model transport is registered here.
      const cursorID=Schema.decodeUnknownSync(Integration.ID)('cursor-acp');
      yield* inner.transform(editor=>{
        if(editor.get(cursorID))return;
        editor.method.update({integrationID:cursorID,method:{type:'key',label:'Cursor API Key'}});
        editor.update(cursorID,value=>{value.name='Cursor';});
      });
      const acquisition:Acquisition={id:randomUUID(),directory:location.directory,inner,mcpInner:inner,
        location:Object.freeze({...location,project:Object.freeze({...location.project})}),credentials:composedCredentials,closed:false};
      acquisitions.set(location.directory,acquisition);retained.add(acquisition);
      yield* Effect.addFinalizer(()=>closeAcquisition(acquisition));
      acquisition.mcpInner=provider.decorateIntegration(cursor.decorateIntegration(openai.decorateIntegration(inner,location),acquisition.location,()=>assertAcquisition(acquisition)),acquisition.location);
      acquisition.integration=mcp.decorateIntegration(acquisition.mcpInner,location);
      return acquisition.integration;
    })).pipe(Layer.provide(original)))),
  ] satisfies LayerNode.Replacements;
  const close=async()=>{
    closed=true;
    const results=await Promise.allSettled([mutation.close(),...Array.from(retained,acquisition=>Effect.runPromise(closeAcquisition(acquisition).pipe(Effect.provide(Logger.layer([],{mergeWithExisting:false}))))),
      ...configurations.map(location=>Effect.runPromise(mcp.closeLocation(location.directory).pipe(Effect.provide(Logger.layer([],{mergeWithExisting:false})))))]);
    const failures=results.filter(result=>result.status==='rejected').map(result=>result.reason);
    if(failures.length)throw new AggregateError(failures,'Native integration cleanup failed');
  };
  const credentialOwned=async(input:{readonly directory:string;readonly requestAuthorization:string;readonly mutation:ControllerCredentialMutation}):Promise<{credentialID?:string}>=>{
    const acquisition=acquisitions.get(input.directory);
    if(!acquisition)return refuse('native_integration_acquisition_expired');
    assertAcquisition(acquisition);
    const mutationInput=structuredClone(input.mutation);
    return runWithIntegrationGrant(new Headers({'x-devryan-native-integration-grant':input.requestAuthorization}),()=>Effect.runPromise(Effect.gen(function*(){
      assertAcquisition(acquisition);
      const store=acquisition.credentials;
      if(mutationInput.operation==='create'){
        if(!['openai','cursor-acp','xai','opencode','opencode-go'].includes(mutationInput.input.integrationID))return refuse('native_credential_mutation_denied');
        const result=yield* store.create(mutationInput.input);assertAcquisition(acquisition);return {credentialID:result.id};
      }
      const record=yield* store.get(mutationInput.id);assertAcquisition(acquisition);
      if(!record)return refuse('native_credential_changed');
      if(!['openai','cursor-acp','xai','opencode','opencode-go'].includes(record.integrationID)){
        if(mutationInput.operation!=='remove')return refuse('native_credential_mutation_denied');
        yield* mcp.removeCredentialOwned(acquisition.mcpInner,acquisition.location,store,mutationInput.id);
      }else if(mutationInput.operation==='update')yield* store.update(mutationInput.id,mutationInput.updates);
      else if(mutationInput.operation==='activate')yield* store.activate(mutationInput.id);
      else yield* store.remove(mutationInput.id);
      assertAcquisition(acquisition);return {};
    }).pipe(Effect.provideService(Location.Service,acquisition.location),Effect.provideService(CapturedAcquisition,acquisition),Effect.provide(Logger.layer([],{mergeWithExisting:false})))));
  };
  const readOpenAiCredentialOwned=async(input:{readonly directory:string;readonly credentialID:string})=>{
    const acquisition=acquisitions.get(input.directory);
    if(!acquisition)return refuse('native_integration_acquisition_expired');
    assertAcquisition(acquisition);
    const value=await Effect.runPromise(acquisition.credentials.get(Schema.decodeUnknownSync(Credential.ID)(input.credentialID)).pipe(Effect.provide(Logger.layer([],{mergeWithExisting:false}))));
    assertAcquisition(acquisition);
    if(value&&value.integrationID!=='openai')return refuse('native_integration_binding_invalid');
    return value?{...value,expectedFingerprint:credentialMutationFingerprint(value)}:null;
  };
  const credentialMetadataOwned=async(input:{readonly directory:string;readonly integrationID:string})=>{
    const acquisition=acquisitions.get(input.directory);
    if(!acquisition)return refuse('native_integration_acquisition_expired');
    assertAcquisition(acquisition);
    return Effect.runPromise(Effect.gen(function*(){
      const id=Schema.decodeUnknownSync(Integration.ID)(input.integrationID);
      if(id==='cursor-acp')cursorBinding(input.directory);
      else if(isOwnedProviderIntegration(id))providerBinding(input.directory,id);
      else if(id!=='openai'){
        const integration=yield* acquisition.mcpInner.get(id);assertAcquisition(acquisition);
        if(integration?.metadata?.source!=='mcp'||!reviewed.get(input.directory)?.has(integration.name))return refuse('native_integration_binding_invalid');
      }
      const records=yield* acquisition.credentials.list(id);assertAcquisition(acquisition);
      const active=yield* acquisition.mcpInner.connection.active(id);assertAcquisition(acquisition);
      return records.map(record=>({id:record.id,integrationID:record.integrationID,label:record.label,valueType:record.value.type,
        ...(record.value.type==='oauth'?{methodID:record.value.methodID}:{}),expectedFingerprint:credentialMutationFingerprint(record),
        active:active?.type==='credential'&&active.id===record.id}));
    }).pipe(Effect.provide(Logger.layer([],{mergeWithExisting:false}))));
  };
  const catalogBinding=(directory:string)=>{
    const acquisition=acquisitions.get(directory),origin=options.providerCompatibilityOrigin;
    if(!acquisition||!origin||origin.kind!=='plugin'||origin.id!=='devryan.provider-compat'||!/^[a-f0-9]{64}$/.test(origin.manifestDigest))return refuse('native_provider_catalog_unavailable');
    assertAcquisition(acquisition);
    const configuration=snapshot.locations.find(location=>location.directory===directory)?.configuration;
    const providers=record(configuration?.providers)?configuration.providers:{};
    return {directory,controllerInstanceID:options.controllerInstanceID,integrationID:'github-copilot' as const,acquisitionID:acquisition.id,
      configurationDigest:credentialMutationFingerprint(providers['github-copilot']??{}),origin:{id:origin.id,manifestDigest:origin.manifestDigest}};
  };
  const selectedCursorKey=async(input:{directory:string;controllerInstanceID:string},authorize:Effect.Effect<void>|undefined)=>{
    const acquisition=acquisitions.get(input.directory);
    if(!acquisition)return refuse('native_integration_acquisition_expired');
    if(!authorize||input.controllerInstanceID!==options.controllerInstanceID)return refuse('native_cursor_key_scope_invalid');
    return Effect.runPromise(Effect.gen(function*(){
      assertAcquisition(acquisition);yield* authorize;assertAcquisition(acquisition);
      const id=Schema.decodeUnknownSync(Integration.ID)('cursor-acp');
      const connection=yield* acquisition.inner.connection.active(id);assertAcquisition(acquisition);
      if(!connection||connection.type!=='credential')return refuse('native_cursor_credential_required');
      const credential=yield* acquisition.credentials.get(connection.id);assertAcquisition(acquisition);
      if(!credential||credential.integrationID!==id||credential.value.type!=='key'||!credential.value.key)return refuse('native_cursor_credential_required');
      const current=yield* acquisition.inner.connection.active(id);assertAcquisition(acquisition);
      const latest=yield* acquisition.credentials.get(connection.id);assertAcquisition(acquisition);
      if(!current||current.type!=='credential'||current.id!==connection.id||credentialMutationFingerprint(latest)!==credentialMutationFingerprint(credential))
        return refuse('native_cursor_credential_changed');
      yield* authorize;assertAcquisition(acquisition);
      return {key:credential.value.key,credentialID:credential.id,expectedFingerprint:credentialMutationFingerprint(credential)};
    }).pipe(Effect.provideService(Location.Service,acquisition.location),Effect.provide(Logger.layer([],{mergeWithExisting:false}))));
  };
  const readSelectedCursorKeyOwned=(input:NativeCursorSettlement)=>selectedCursorKey(input,options.authorizeCursorKey?.(input));
  const readCursorReadOnlyKeyOwned=(input:NativeCursorReadOnlyKey)=>selectedCursorKey(input,options.authorizeCursorReadOnlyKey?.(input));
  const readCatalogSelectionOwned=async(input:{directory:string;controllerInstanceID:string;integrationID:'github-copilot';acquisitionID:string;configurationDigest:string;origin:{id:string;manifestDigest:string}})=>{
    if(!options.isBound())return refuse('native_runtime_not_ready');
    const binding=catalogBinding(input.directory),acquisition=acquisitions.get(input.directory);
    if(!acquisition||credentialMutationFingerprint(binding)!==credentialMutationFingerprint(input))return refuse('native_provider_catalog_binding_invalid');
    return Effect.runPromise(Effect.gen(function*(){
      assertAcquisition(acquisition);
      const connection=yield* acquisition.inner.connection.active(Schema.decodeUnknownSync(Integration.ID)('github-copilot'));
      if(!connection||connection.type!=='credential')return null;
      const credential=yield* acquisition.credentials.get(connection.id);
      assertAcquisition(acquisition);
      if(!credential||credential.integrationID!=='github-copilot')return refuse('native_provider_catalog_selection_invalid');
      const current=yield* acquisition.inner.connection.active(Schema.decodeUnknownSync(Integration.ID)('github-copilot'));
      assertAcquisition(acquisition);
      if(!current||current.type!=='credential'||current.id!==connection.id)return refuse('native_provider_catalog_selection_changed');
      return {...binding,credential};
    }).pipe(Effect.provide(Logger.layer([],{mergeWithExisting:false}))));
  };
  const discoverCopilot=(input:{directory:string;integration:Integration.Interface})=>Effect.suspend(()=>{
    if(!options.isBound())return Effect.succeed(undefined);
    const acquisition=acquisitions.get(input.directory);
    if(!acquisition||acquisition.integration!==input.integration)return Effect.die(new HostRefusal('native_provider_catalog_acquisition_invalid',403,'provider.catalog'));
    const binding=catalogBinding(input.directory);
    return Effect.tryPromise({try:signal=>options.rpc('provider.catalog',binding,{signal}),catch:error=>error}).pipe(Effect.orDie,
      Effect.tap(()=>Effect.sync(()=>assertAcquisition(acquisition))));
  });
  return {overrides,executeOwned:mcp.executeOwned,providerHooks:(inner:PluginHooks.Interface)=>provider.decorateHooks(openai.decorateHooks(inner)),
    readClaudeLifecycleOwned:(input:Parameters<ReturnType<typeof createControllerClaudeLifecycle>['readOwned']>[0])=>{
      if(!claudeLifecycle)return refuse('native_claude_lifecycle_owner_expired');return claudeLifecycle.readOwned(input);
    },
    transitionClaudeLifecycleOwned:(input:Parameters<ReturnType<typeof createControllerClaudeLifecycle>['transitionOwned']>[0])=>{
      if(!claudeLifecycle)return refuse('native_claude_lifecycle_owner_expired');return claudeLifecycle.transitionOwned(input);
    },
    readSelectedOwned:openai.readSelectedOwned,compareAndSwapSelectedOwned:openai.compareAndSwapSelectedOwned,
    discoverCopilot,readCatalogSelectionOwned,readSelectedCursorKeyOwned,readCursorReadOnlyKeyOwned,commitCredentialOwned:mutation.commitOwned,credentialOwned,credentialMetadataOwned,readOpenAiCredentialOwned,close};
}
