import path from 'node:path';
import {bootstrapNativeSetupCredentials} from './native-setup-credentials.js';
import {createControllerHelperText} from './controller-helper-text.js';
import { createNativeRuntimeHost } from './bootstrap.js';
import { createExecutionRouting } from './execution-routing.js';
import { createControllerHelper } from './controller-processes.js';
import { createRemoteNativeAdmissionBridge } from './native-admission-bridge.js';
import { createReviewedNativePluginRegistry } from './native-plugin-registry.js';
import { managedTaskPlugin,withManagedTaskExecution,MANAGED_TASK_PLUGIN_ID } from './managed-task.js';
import { councilPlugin,withCouncilExecution,COUNCIL_PLUGIN_ID } from './council.js';
import { nativeSkillsPlugin } from './native-skills.js';
import { nativeConfiguredInstructionsPlugin } from './native-configured-instructions.js';
import { createReviewedSkillExecution } from './native-reviewed-skill-execution.js';
import { createControllerIntegrations } from './controller-integrations.js';
import { createNativeSessionContext, nativeSessionContextPlugin, SESSION_CONTEXT_PLUGIN_ID } from './native-session-context.js';
import { createNativeObservation } from './native-observation.js';
import { primaryStepOverride } from './primary-step.js';
import { nativeBrowserPlugin, NATIVE_BROWSER_PLUGIN_ID } from './native-browser-plugin.js';
import { createNativeDocumentPlugin,NATIVE_DOCUMENT_PLUGIN_ID } from './native-document-plugin.js';
import { createControllerSlim } from './controller-slim.js';
import { createControllerWebfetch } from './controller-webfetch.js';
import { createControllerImages } from './controller-images.js';
import { createControllerInterview } from './controller-interview.js';
import { createControllerProviders } from './controller-providers.js';
import {nativeImagegenPlugin,NATIVE_IMAGEGEN_PLUGIN_ID} from './native-imagegen-plugin.js';
import {createNativeCursorIngress} from './native-cursor-ingress.js';
import * as slimOriginals from '../../../../runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js';
import {command as ponytailCommand} from 'devryan:reviewed-ponytail-instructions';
import {scrubOpencodeFingerprints} from 'devryan:reviewed-claude-scrub';
import {Effect,Schema} from 'effect';
import {HostRefusal,refuseHost} from './host-refusal.js';
import type {Plugin} from '@opencode/plugin/effect/plugin';
import { OperationPermitRef,runWithRequestPermit, type ExecuteOwned } from './native-admission-contract.js';
import type { NativeProcessBoot,NativeProcessCommand } from './native-process-protocol.js';
import type { RegistrationOrigin } from './registration-origin.js';
import { readResponseBody } from '../opencode-client/envelope.js';

const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export async function startNativeController(boot:NativeProcessBoot,identity:{coreDigest:string;hostDigest:string;reviewedPlugins:readonly Omit<RegistrationOrigin,'kind'>[];migration:'completed'|'not-needed'}) {
  const rpc: (method:string,params:unknown,options?:{readonly signal?:AbortSignal})=>Promise<unknown> = async(method,params,options)=>{
    const timeout=AbortSignal.timeout(method==='native.council'?240_000:method.startsWith('native.document.')||method.startsWith('native.slim.interview.')||method.startsWith('native.slim.images')?120_000:30_000);
    const signal=options?.signal?AbortSignal.any([options.signal,timeout]):timeout;
    const response=await fetch(boot.bridge.url,{method:'POST',headers:{authorization:`Bearer ${boot.bridge.token}`,'content-type':'application/json',connection:'close'},body:JSON.stringify({method,params}),signal});
    const body=await readResponseBody(response,{signal,maxResponseBytes:4*1024*1024});
    if(!body.parsed || !record(body.value) || !response.ok || body.value.ok!==true) {
      const code=record(body.value)&&record(body.value.error)&&typeof body.value.error.code==='string'?body.value.error.code:'native_bridge_failed';
      throw Object.assign(new Error(code),{code,status:response.ok?503:response.status});
    }
    return body.value.result;
  };
  const bridge=createRemoteNativeAdmissionBridge({rpc});
  const compiled=new Map(identity.reviewedPlugins.map(origin=>[origin.id,origin]));
  const origins:RegistrationOrigin[]=boot.reviewedPlugins.map(row=>{
    const expected=compiled.get(row.id);
    if(!expected || row.manifestDigest!==expected.manifestDigest || JSON.stringify(row.capabilities)!==JSON.stringify(expected.capabilities)) throw new Error('native_reviewed_plugin_mismatch');
    return {kind:'plugin',...row};
  });
  if(new Set(origins.map(row=>row.id)).size!==origins.length) throw new Error('native_reviewed_plugin_duplicate');
  let bound=false,executionReady=false,closing:Promise<void>|undefined;
  let host:Awaited<ReturnType<typeof createNativeRuntimeHost>>;
  // Catalog discovery can publish Project events before createNativeRuntimeHost
  // returns. Scope these callbacks before dereferencing its captured host.
  const prepareQueuedPublication=(events:Parameters<typeof host.prepareQueuedPublication>[0])=>{
    if(!events.some(event=>['session.inbox.enqueued','session.inbox.delivered'].includes(event.type)))return Effect.succeed([]);
    return host?host.prepareQueuedPublication(events):refuseHost(new HostRefusal('native_queued_input_unavailable',503,'queued.input.publish'));
  };
  const assertQueuedPublication=(event:Parameters<typeof host.assertQueuedPublication>[0])=>
    host?host.assertQueuedPublication(event):refuseHost(new HostRefusal('native_queued_input_unavailable',503,'queued.input.publish',event.data.sessionID));
  const wakeQueuedParents=(event:unknown)=>{
    if(!record(event)||!['session.execution.succeeded','session.execution.failed','session.execution.interrupted'].includes(String(event.type)))return Effect.void;
    return host?host.wakeQueuedParents(event):refuseHost(new HostRefusal('native_queued_input_unavailable',503,'queued.input.wake'));
  };
  const recoveredSessions=new Set(boot.recoveredSessionIDs??[]);
  const recoveredPublication=(events:readonly {readonly type:string;readonly data:unknown}[])=>Effect.gen(function*(){
    const guarded=events.filter(event=>['session.inbox.enqueued','session.inbox.delivered','session.inbox.cancelled','session.inbox.delivery.changed','session.compaction.started'].includes(event.type)
      &&record(event.data)&&typeof event.data.sessionID==='string'&&recoveredSessions.has(event.data.sessionID));
    if(!guarded.length)return;
    if(!host)return yield* refuseHost(new HostRefusal('native_recovered_input_unavailable',503,'recovered.input.publish'));
    const observation=yield* host.observeRecoveredPublication(guarded),permit=yield* OperationPermitRef;
    const approved=yield* Effect.tryPromise({try:()=>rpc('native.admission.recoveredPublication',{...observation,permit}),catch:()=>undefined})
      .pipe(Effect.catch(()=>refuseHost(new HostRefusal('native_recovered_input_fenced',409,'recovered.input.publish'))));
    return observation.pending.filter(item=>Array.isArray(approved)&&approved.some(row=>record(row)&&row.sessionID===item.sessionID&&row.inboxID===item.id)).map(item=>{
      if(typeof item.enqueuedSeq!=='number'||!Number.isSafeInteger(item.enqueuedSeq))throw Error('native_recovered_input_receipt_invalid');
      return {sessionID:item.sessionID,inboxID:item.id,enqueuedSeq:item.enqueuedSeq,type:item.type,delivery:item.delivery,payloadHash:item.payloadHash,instanceID:boot.instanceID};
    });
  });
  const recoveredSettled=(event:unknown)=>{
    if(!record(event)||!record(event.data)||typeof event.data.sessionID!=='string'||!recoveredSessions.has(event.data.sessionID)
      ||!['session.step.ended','session.step.failed','session.inbox.cancelled'].includes(String(event.type)))return Effect.void;
    const sessionID=event.data.sessionID;
    return Effect.promise(()=>rpc('native.recovered-input.settled',{sessionID,instanceID:boot.instanceID})).pipe(Effect.asVoid);
  };
  const slimOrigin=origins.find(row=>row.id==='devryan.slim');
  const webfetch=createControllerWebfetch({tmpDirectory:boot.globals.tmp,originals:slimOriginals,
    withSecondary:(invocation,request,execute)=>Effect.acquireUseRelease(
      Effect.promise(()=>rpc('native.slim.secondary.begin',{permit:invocation.existingPermit,directory:invocation.location.directory,
        sessionID:request.sessionID,messageID:invocation.nativeContext.messageID,callID:invocation.nativeContext.id,model:request.model,prompt:request.prompt}))
        .pipe(Effect.map(value=>Schema.decodeUnknownSync(Schema.Struct({token:Schema.String,sessionID:Schema.String,revision:Schema.Int}))(value))),
      permit=>execute.pipe(Effect.provideService(OperationPermitRef,permit)),
      permit=>Effect.promise(()=>rpc('native.slim.secondary.end',permit))),
  });
  const helperText=createControllerHelperText({generate:webfetch.generateHelper,rename:input=>host.renameHelperTitleOwned(input),rpc,isCurrent:()=>bound&&executionReady&&!closing});
  const locations=boot.locations.map(location=>({...location,readRoots:[...location.readRoots,...slimOrigin?[webfetch.binaryDirectory(location.directory)]:[]]}));
  const routing=createExecutionRouting({rpc,bridge,directory:boot.directory,locations,configurationSnapshot:boot.configurationSnapshot,
    reviewedAstOrigin:origins.find(row=>row.id==='devryan.slim'),reviewedBrowserOrigin:origins.find(row=>row.id===NATIVE_BROWSER_PLUGIN_ID),
    reviewedImagegenOrigin:origins.find(row=>row.id===NATIVE_IMAGEGEN_PLUGIN_ID)});
  const cursor=createNativeCursorIngress({controllerInstanceID:boot.instanceID,
    authorizeRecord:input=>Effect.promise(()=>rpc('native.cursor.assert',input)).pipe(Effect.asVoid),
    authorizeSettlement:input=>Effect.promise(()=>rpc('native.cursor.settle.assert',input)).pipe(Effect.asVoid)});
  const managed=origins.find(row=>row.id===MANAGED_TASK_PLUGIN_ID);
  const council=origins.find(row=>row.id===COUNCIL_PLUGIN_ID);
  const documentOrigin=origins.find(row=>row.id===NATIVE_DOCUMENT_PLUGIN_ID);
  const documents=documentOrigin&&boot.configurationSnapshot?createNativeDocumentPlugin({snapshot:boot.configurationSnapshot,origin:documentOrigin,
    rpc,executeOwned:routing.executeOwned,withControl:routing.withControl}):undefined;
  const nativePlugins=createReviewedNativePluginRegistry(identity.coreDigest,{hostDigest:identity.hostDigest});
  const remoteMcpOrigin=nativePlugins.get('devryan.remote-mcp');
  if(!remoteMcpOrigin)throw new Error('native_mcp_origin_unavailable');
  const skill=boot.configurationSnapshot?createReviewedSkillExecution({snapshot:boot.configurationSnapshot,withDirectRead:routing.withDirectRead}):undefined;
  let executeOwned:ExecuteOwned=invocation=>invocation.toolID==='skill'&&skill?skill(invocation):(documents?.executeOwned??routing.executeOwned)(invocation);
  const interview=createControllerInterview({controllerInstanceID:boot.instanceID,rpc,isCurrent:()=>bound&&!closing});
  const applyPonytailCommand=(input:Parameters<typeof host.assertReviewedCommand>[0])=>Effect.gen(function*(){
    const proof=yield* host.assertReviewedCommand(input);
    yield* Effect.promise(()=>rpc('native.ponytail.command',{...input,...proof}));
  });
  const slim=slimOrigin&&webfetch&&boot.configurationSnapshot?createControllerSlim({snapshot:boot.configurationSnapshot,origin:slimOrigin,
    originals:slimOriginals,ponytailCommand,rpc,executeOwned,withControl:routing.withControl,
    webfetchOwnersFor:webfetch.ownersFor,webfetchBinaryDirectory:webfetch.binaryDirectory,
    commands:{assertCommand:input=>host.assertReviewedCommand(input).pipe(Effect.asVoid),executeCommand:input=>host.executeReviewedCommand(input)},
    applyPonytailCommand,interviewForDirectory:interview.forDirectory,
    observePrompt:async authority=>{await rpc('native.slim.hook',{action:'assert',directory:authority.directory,sessionID:authority.sessionID,permit:authority.permit,phase:authority.phase,...authority.messageID?{messageID:authority.messageID}:{}},{signal:authority.signal});},
    observeLifecycle:async(directory,event)=>{if(record(event)&&['message.updated','session.idle'].includes(String(event.type)))await interview.event(directory,event);},
    transformImages:createControllerImages(rpc,async authority=>{await rpc('native.slim.images-skipped',{directory:authority.directory,sessionID:authority.sessionID,permit:authority.permit,phase:authority.phase},{signal:authority.signal});}),
    disposeLocation:async()=>{},log:()=>{},
  }):undefined;
  if(slim)executeOwned=slim.executeOwned;
  const providerOrigin=origins.find(row=>row.id==='devryan.provider-compat');
  const integrations=boot.configurationSnapshot?createControllerIntegrations({controllerInstanceID:boot.instanceID,
    configurationSnapshot:boot.configurationSnapshot,rpc,registrationOrigin:remoteMcpOrigin,
    providerCompatibilityOrigin:providerOrigin,
    reviewedNativeProviderOrigin:nativePlugins.get('opencode.provider.xai'),
    reviewedConfigurationOrigins:new Map([...nativePlugins].filter(([id])=>['opencode.config.mcp','opencode.mcp.codemode.defaults','opencode.provider.opencode'].includes(id))),
    isBound:()=>bound,isExecutionReady:()=>executionReady,executeOwnedFallback:executeOwned,
    authorizeMcpCall:(invocation,_binding,action)=>routing.withControl(invocation,action),
    bootstrapCredentials:()=>bootstrapNativeSetupCredentials({seedPath:path.join(boot.globals.config,'native-setup-credentials.json')}).pipe(Effect.asVoid),
    authorizeCursorKey:input=>Effect.promise(()=>rpc('native.cursor.key.assert',input)).pipe(Effect.asVoid),
    authorizeCursorReadOnlyKey:input=>Effect.promise(()=>rpc('native.cursor.readonly.key.assert',input)).pipe(Effect.asVoid),
  }):undefined;
  const providers=providerOrigin&&integrations&&boot.configurationSnapshot?createControllerProviders({controllerInstanceID:boot.instanceID,
    configurationSnapshot:boot.configurationSnapshot,origin:providerOrigin,integrations,rpc,scrubSystem:scrubOpencodeFingerprints,isBound:()=>bound,isExecutionReady:()=>executionReady}):undefined;
  const whenConfigured=(plugin:Plugin):Plugin=>({id:plugin.id,effect:context=>{
    const location=boot.configurationSnapshot?.locations.find(row=>row.directory===context.location.directory);
    return location&&(!location.activeRegistrationIDs||location.activeRegistrationIDs.includes(plugin.id))?plugin.effect(context):Effect.void;
  }});
  const plugins=origins.map(origin=>{
    if(origin.id===MANAGED_TASK_PLUGIN_ID)return {origin,plugin:managedTaskPlugin};
    if(origin.id===COUNCIL_PLUGIN_ID)return {origin,plugin:councilPlugin};
    if(origin.id===SESSION_CONTEXT_PLUGIN_ID)return {origin,plugin:nativeSessionContextPlugin};
    if(origin.id===NATIVE_BROWSER_PLUGIN_ID)return {origin,plugin:whenConfigured(nativeBrowserPlugin)};
    if(origin.id===NATIVE_IMAGEGEN_PLUGIN_ID)return {origin,plugin:whenConfigured(nativeImagegenPlugin)};
    if(origin.id===NATIVE_DOCUMENT_PLUGIN_ID&&documents)return {origin,plugin:documents.plugin};
    if(origin.id==='devryan.slim'&&slim)return {origin,plugin:slim.plugin};
    if(origin.id==='devryan.slim-commands'&&slim)return {origin,plugin:slim.commands};
    if(origin.id==='devryan.slim-lifecycle'&&slim)return {origin,plugin:slim.lifecycle};
    if(origin.id==='devryan.ponytail'&&slim)return {origin,plugin:slim.ponytail};
    if(origin.id==='devryan.provider-compat'&&providers)return {origin,plugin:providers.plugin};
    if(!boot.configurationSnapshot)throw new Error('native_configuration_snapshot_required');
    if(origin.id==='devryan.reviewed-skills')return {origin,plugin:nativeSkillsPlugin(boot.configurationSnapshot)};
    if(origin.id==='devryan.configured-instructions')return {origin,plugin:nativeConfiguredInstructionsPlugin(boot.configurationSnapshot)};
    throw new Error('native_reviewed_plugin_unavailable');
  });
  if(integrations)executeOwned=integrations.executeOwned;
  if(managed)executeOwned=withManagedTaskExecution({origin:managed,directory:boot.directory,rpc,executeOwned});
  if(council)executeOwned=withCouncilExecution({origin:council,rpc,executeOwned});
  const contextOrigin=origins.find(origin=>origin.id===SESSION_CONTEXT_PLUGIN_ID);
  const sessionContext=contextOrigin?createNativeSessionContext({origin:contextOrigin,rpc,executeOwned}):undefined;
  if(sessionContext)executeOwned=sessionContext.withPrimaryToolExecution(sessionContext.executeOwned);
  if(!boot.configurationSnapshot)throw new Error('native_configuration_snapshot_required');
  const observation=createNativeObservation({controllerInstanceID:boot.instanceID,configurationDigest:boot.configurationSnapshot.digest,rpc,decorateModelRequests:providers?.decorateModelRequests});
  try {
    host=await createNativeRuntimeHost({helperText,databasePath:boot.databasePath,token:boot.httpToken,configuration:boot.configuration,configurationSnapshot:boot.configurationSnapshot,cursorCatalog:boot.cursorCatalog,globals:boot.globals,
      plugins,nativePlugins,reviewedBehaviorCommands:origins.flatMap(origin=>{
        const declarations=origin.id==='devryan.slim-commands'&&slim?slim.commandDeclarations
          :origin.id==='devryan.ponytail'&&slim?{ponytail:slim.ponytailCommandDeclaration}:undefined;
        return Object.entries(declarations??{}).map(([name,definition])=>({origin,name,definition}));
      }),providerHooks:inner=>observation.decorateHooks(integrations?.providerHooks(inner)??inner),
      executionActivity:cursor.decorateExecution,
      captureSessionStore:cursor.captureStore,
      sessionHooks:(inner,location,owners)=>{const decorated=sessionContext?.decorateHooks(inner,location)??inner;return slim?.decorateHooks(decorated,location,owners)??decorated;},
      beforeConfiguredCommand:input=>input.name==='ponytail'&&boot.configurationSnapshot?.locations.find(row=>row.directory===input.directory)?.activeRegistrationIDs?.includes('devryan.ponytail')?applyPonytailCommand(input):Effect.void,
      executionOverrides:[...routing.overrides,...(webfetch?.overrides??[]),...(integrations?.overrides??[]),...(providers?.catalogOverrides??[]),...observation.overrides,primaryStepOverride(rpc,cursor.captureBus,(event,disposition)=>observation.observePublished(event,disposition).pipe(Effect.andThen(recoveredSettled(event)),Effect.andThen(wakeQueuedParents(event))),recoveredPublication,event=>host.persistRecoveredCancellation(event),event=>host.dropRecoveredCancellationReceipts(event),event=>host.assertHelperTitleCAS(event),prepareQueuedPublication,assertQueuedPublication,sessionID=>host.interruptStoppedHandoff(sessionID))],controllerHelper:createControllerHelper({rpc}),
      executeOwned,
      bridge,drainExecutions:routing.close,readiness:{hostVersion:'1.2.22',buildId:boot.buildId,migration:identity.migration,
        directories:boot.locations.map(row=>row.directory),requirements:boot.catalogRequirements}});
    bound=true;
  } catch(error) {
    providers?.close();const cleanup=await Promise.allSettled([cursor.close(),integrations?.close(),routing.close()]);
    const failures=cleanup.filter(row=>row.status==='rejected').map(row=>row.reason);
    if(failures.length)throw new AggregateError([error,...failures],'Native controller startup cleanup failed');throw error;
  }
  const close=()=>closing??=(async()=>{
    executionReady=false;
    const failures:unknown[]=[];
    try{await host.close();}catch(error){failures.push(error);}
    try{await integrations?.close();}catch(error){failures.push(error);}
    providers?.close();
    try{await cursor.close();}catch(error){failures.push(error);}
    if(failures.length)throw new AggregateError(failures,'Native controller cleanup failed');
  })();
  const requireIntegrations=(controllerInstanceID:string)=>{
    if(controllerInstanceID!==boot.instanceID||!integrations)throw new Error('native_integration_owner_unavailable');
    return integrations;
  };
  const command=async(input:NativeProcessCommand):Promise<unknown>=>{
    switch(input.action) {
      case 'cursor-record-owned':{
        const {action,protocol,id,...record}=input;void [action,protocol,id];return cursor.persistOwned(record);
      }
      case 'cursor-settle-owned':{
        const {action,protocol,id,...scope}=input;void [action,protocol,id];return cursor.settleOwned(scope);
      }
      case 'cursor-key-owned':{
        const {action,protocol,id,...scope}=input;void [action,protocol,id];return requireIntegrations(input.controllerInstanceID).readSelectedCursorKeyOwned(scope);
      }
      case 'cursor-readonly-key-owned':{
        const {action,protocol,id,...scope}=input;void [action,protocol,id];return requireIntegrations(input.controllerInstanceID).readCursorReadOnlyKeyOwned(scope);
      }
      case 'open':await host.openStartup();executionReady=true;return {opened:true};
      case 'open-recovery':await host.openStartup({announceReady:false});return {recovering:true};
      case 'close-startup':executionReady=false;host.closeStartup();return {closed:true};
      case 'quiesce':executionReady=false;return {held:await host.quiesce()};
      case 'hold':await host.holdAndStop(input.sessionID);return {held:true};
      case 'release':await host.release(input.sessionID);return {released:true};
      case 'close':await close();return {settled:true};
      case 'credential-commit-owned':await requireIntegrations(input.controllerInstanceID).commitCredentialOwned(input);return null;
      case 'credential-operation-owned':return requireIntegrations(input.controllerInstanceID).credentialOwned(input);
      case 'credential-metadata-owned':return requireIntegrations(input.controllerInstanceID).credentialMetadataOwned(input);
      case 'claude-lifecycle-read-owned':return requireIntegrations(input.controllerInstanceID).readClaudeLifecycleOwned(input);
      case 'claude-lifecycle-transition-owned':return requireIntegrations(input.controllerInstanceID).transitionClaudeLifecycleOwned(input);
      case 'openai-read-selected-owned':return requireIntegrations(input.controllerInstanceID).readSelectedOwned(input);
      case 'openai-cas-selected-owned':return requireIntegrations(input.controllerInstanceID).compareAndSwapSelectedOwned(input);
      case 'provider-catalog-selection-owned':{
        if(!providers||input.controllerInstanceID!==boot.instanceID)throw new Error('native_provider_owner_unavailable');
        const {action,protocol,id,...binding}=input;void [action,protocol,id];
        return providers.readCatalogSelectionOwned(binding);
      }
      case 'interview-action-owned':return host.interviewActionOwned(input);
      case 'recover-shell-owned':await host.recoverShellOwned(input);return undefined;
      case 'acquire-retention-owned':return host.retentionOwned(input);
      case 'archive-retention-owned':return host.retentionOwned(input);
      case 'queued-primary-idle-owned':return host.queuedPrimaryIdleOwned(input);
      case 'inspect-removal-owned':return host.inspectRemovalOwned(input);
      case 'remove-leaf-owned':return host.removeLeafOwned(input);
      case 'wake-owned':return runWithRequestPermit(new Headers({'x-devryan-native-permit':JSON.stringify(input.permit)}),()=>host.wakeOwned(input));
      case 'wake-deferred-owned':return runWithRequestPermit(new Headers({'x-devryan-native-permit':JSON.stringify(input.permit)}),()=>host.wakeDeferredOwned(input));
      case 'reconcile-shell-owned':return runWithRequestPermit(new Headers({'x-devryan-native-permit':JSON.stringify(input.permit)}),()=>host.reconcileShellOwned(input));
      case 'reconcile-primary-owned':return runWithRequestPermit(new Headers({'x-devryan-native-permit':JSON.stringify(input.permit)}),()=>host.reconcilePrimaryOwned(input));
      case 'cancel-recovered-input-owned':return runWithRequestPermit(new Headers({'x-devryan-native-permit':JSON.stringify(input.permit)}),()=>host.cancelRecoveredInputOwned(input));
    }
  };
  return {...host,close,command,closeStartup:()=>{executionReady=false;host.closeStartup();}};
}
