import fs from 'node:fs/promises';
import path from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createCursorSdkRuntime} from '../../packages/cursor-sdk-runtime/index.js';
import {createSessionExecutionHost} from '../../packages/web/server/lib/opencode/session-execution-host.js';
import {createOpenCodeClient} from '../../packages/web/server/lib/opencode/opencode-client/index.js';
import {createOpenCodeAdmission} from '../../packages/web/server/lib/opencode/v2/admission.js';
import {createNativeRevertConversation} from '../../packages/web/server/lib/opencode/session-revert-coordinator.js';
import {createRuntimeBundleStore} from '../../packages/web/server/lib/opencode/runtime-host/runtime-bundle.js';
import {createRuntimeBundleCheckpoint} from '../../packages/web/server/lib/opencode/runtime-host/bundle-checkpoint.js';
import {readRuntimeBundleBinding} from '../../packages/web/server/lib/opencode/runtime-host/runtime-bundle-binding.js';
import {runNativeMigrationProcess} from '../../packages/web/server/lib/opencode/runtime-host/native-migration-process.js';
import {verifyNativeRuntimeArtifacts} from '../../packages/web/server/lib/opencode/runtime-host/native-artifacts.js';
import {createNativeAuthorization} from '../../packages/web/server/lib/opencode/runtime-host/native-authorization.js';
import {loadNativeRuntimeBundle,createNativeRuntimeOwner} from '../../packages/web/server/lib/opencode/runtime-host/native-runtime-owner.js';
import {createNativeConfigurationSnapshotResolver} from '../../packages/web/server/lib/opencode/runtime-host/native-configuration-snapshot.js';
import {createOpenAiOAuthCoordinator} from '../../packages/web/server/lib/opencode/openai-oauth-coordinator.js';
import {credentialMutationFingerprint} from '../../packages/web/server/lib/opencode/runtime-host/native-credential-mutation-owner.js';
import {createQaHostLaunchEnvironment} from '../qa/launch-environment.mjs';
import {createEmptyRuntimeFixture,fixtureSha256} from './migration-fixture.mjs';
import {createNativeManagedFixture} from './managed-fixture.mjs';
import {DEFAULT_RG} from './artifacts.mjs';

const environmentFor=(globals,inherited)=>createQaHostLaunchEnvironment({...inherited,HOME:globals.home,XDG_CONFIG_HOME:globals.config,
 XDG_DATA_HOME:globals.data,XDG_STATE_HOME:globals.state,XDG_CACHE_HOME:globals.cache,TMPDIR:globals.tmp,TMP:globals.tmp,TEMP:globals.tmp});

/** Actual fresh native initialization, production web/native owners and original Cursor SDK.
 * Only the provider HTTP replies and local-admin caller are fixture inputs. */
export async function createCompiledCursorFixture({root,artifactRoot,provider,observations,diagnostics}){
 const manifestPath=path.join(artifactRoot,'native-bundle.json'),manifestSha256=fixtureSha256(await fs.readFile(manifestPath));
 const artifacts=await verifyNativeRuntimeArtifacts({manifestPath,manifestSha256,launcher:path.join(artifactRoot,'DevRyan-execution-darwin-arm64')});
 const fixture=await createEmptyRuntimeFixture({root});
 const configuration={model:'cursor-acp/composer-2.5',providers:{},
  agents:{orchestrator:{mode:'primary',model:'cursor-acp/composer-2.5'},title:{disabled:true}},formatter:false};
 const locations=fixture.projectMap.map(row=>({directory:row.targetDirectory,readRoots:[row.targetDirectory],protectedRoots:[fixture.sourceLaunch.global.home,fixture.sourceLaunch.webDataDirectory]}));
 const reviewedNativeConfigPath=path.join(root,'reviewed-native.json'),reviewedPluginManifestPath=path.join(root,'reviewed-plugins.json');
 const catalogRequirements={agents:['orchestrator'],plugins:[],tools:['read','write'],models:[]};
 await fs.writeFile(reviewedNativeConfigPath,JSON.stringify({schema:1,configuration,locations,catalogRequirements})+'\n');
 await fs.writeFile(reviewedPluginManifestPath,JSON.stringify({schema:1,plugins:[]})+'\n');
 const launchArtifacts={controllerBinary:artifacts.controller,writerBinary:artifacts.writer,artifactManifestPath:manifestPath,artifactManifestSha256:manifestSha256,reviewedNativeConfigPath,reviewedPluginManifestPath};
 let runtimeOwner,host,managed,cursor,nativeURL,controller,epoch=0;
 const readonlyScope=new AsyncLocalStorage();
 const deps={getRuntime:()=>({generation:2,baseUrl:nativeURL,version:'2.0.26',epoch}),getAuthHeaders:()=>runtimeOwner?.getAuthHeaders()??{},
  withNativeWebOperation:(spec,action)=>runtimeOwner.nativeOwner.withWebOperation(spec,action)};
 const admission=createOpenCodeAdmission(deps,{beforePromptDispatch:(receipt,context)=>managed.admitNativePrompt(receipt,context),
  onPromptDispatchFailure:receipt=>managed.markNativePromptUncertain(receipt),
  externalPromptDispatch:(input,request)=>runtimeOwner.dispatchExternalPrompt(input,request),nativeOwner:{requestHeaders:()=>runtimeOwner.nativeOwner.requestHeaders(),
   withAcceptedOperation:(receipt,action)=>runtimeOwner.nativeOwner.withAcceptedOperation(receipt,action),
   checkQueuedPromptAdmission:(...args)=>runtimeOwner.nativeOwner.checkQueuedPromptAdmission(...args),
    stageQueuedPromptAdmission:(...args)=>runtimeOwner.nativeOwner.stageQueuedPromptAdmission(...args),
    assertQueuedPromptReconciled:(...args)=>runtimeOwner.nativeOwner.assertQueuedPromptReconciled(...args),
    queuedPromptWasRejected:(...args)=>runtimeOwner.nativeOwner.queuedPromptWasRejected(...args),
    updateAcceptedOperation:receipt=>runtimeOwner.nativeOwner.updateAcceptedOperation(receipt)}});
 const client=createOpenCodeClient({...deps,getAdmission:()=>admission}),buildOpenCodeUrl=route=>new URL(route,nativeURL).href;
 const descriptors=new Map(),controlRoot=path.join(root,'bundles');
 const store=createRuntimeBundleStore({controlRoot,withQuiescedSource:async(input,action)=>{
  const source=input.kind==='legacy'?{generation:1,launch:input.launch}:descriptors.get(input.bundleID);
  const sourceHost=createSessionExecutionHost({dataDirectory:source.launch.webDataDirectory,openCodeClient:client,
   getLauncher:()=>artifacts.launcher,buildOpenCodeUrl,getOpenCodeAuthHeaders:deps.getAuthHeaders});
  return createRuntimeBundleCheckpoint({ownerID:input.kind==='legacy'?'cursor-owned-source':input.bundleID,generation:source.generation,launch:source.launch,neverStarted:true,
   closeAdmission:()=>sourceHost.runtime.drain(),getController:()=>null,stopProducers:async()=>{},executionHost:sourceHost,drainStores:()=>sourceHost.runtime.drain()})(input,action);
 },runMigration:request=>runNativeMigrationProcess({binary:artifacts.controller,request,cwd:root,
  environment:environmentFor(Object.fromEntries(['home','config','data','state','cache','tmp','bin','log','repos'].map(key=>[key,path.join(request.isolatedRoot,key)])),fixture.environment),
  beforeSpawn:()=>verifyNativeRuntimeArtifacts({manifestPath,manifestSha256,launcher:artifacts.launcher})})});
 const sourceLaunch={opencodeDatabasePath:fixture.sourceLaunch.opencodeDatabasePath,webDataDirectory:fixture.sourceLaunch.webDataDirectory,
  webConfigDirectory:fixture.sourceLaunch.webConfigDirectory,opencodeConfigDirectory:fixture.sourceLaunch.opencodeConfigDirectory,global:{home:fixture.sourceLaunch.global.home}};
 const descriptor=await store.prepare({bundleID:'candidate',generation:2,source:{kind:'legacy',launch:sourceLaunch},projectMap:fixture.projectMap,auxiliary:{kind:'absent'},launchArtifacts});
 descriptors.set('candidate',descriptor);
 await store.select({bundleID:'candidate',expectedRevision:0});
 const binding=readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:controlRoot}),bundle=await loadNativeRuntimeBundle({binding,launcher:artifacts.launcher});
 const resolve=createNativeConfigurationSnapshotResolver({loadLocation:async()=>({legacy:{model:'cursor-acp/composer-2.5',providers:configuration.providers,plugin:[]},
  agents:{orchestrator:{mode:'primary',model:'cursor-acp/composer-2.5'},title:{disabled:true}},commands:{},skills:[],slim:{mergedConfig:{}},parseMarkdown:()=>{throw Error('Unexpected skill');}})});
 const awaitBytes=await fs.readFile(descriptor.launch.reviewedPluginManifestPath);
 bundle.resolveConfiguration=revision=>resolve({binding,revision,expectedRegistrationDigest:fixtureSha256(awaitBytes)});
 const globals=descriptor.launch.global,directory=locations[0].directory;
 for(const value of Object.values(globals))await fs.mkdir(value,{recursive:true});
 await fs.writeFile(path.join(globals.tmp,'package.json'),'{"type":"commonjs"}\n');
 const rg=path.join(globals.cache,'opencode/bin/rg');await fs.mkdir(path.dirname(rg),{recursive:true});await fs.copyFile(DEFAULT_RG,rg);await fs.chmod(rg,0o755);
 const environment=environmentFor(globals,fixture.environment);
 host=createSessionExecutionHost({dataDirectory:descriptor.launch.webDataDirectory,openCodeClient:client,getLauncher:()=>artifacts.launcher,
  buildOpenCodeUrl,getOpenCodeAuthHeaders:deps.getAuthHeaders,stopCursor:input=>cursor.abortAndWait(input.sessionID),
  onDiagnostic:row=>diagnostics.push(row),recordReceipt:row=>observations.push({phase:'cursor_publication_receipt',...row}),
  nativeExecution:{isReady:()=>Boolean(nativeURL),locations,socketDirectory:null,workerBrowsers:false,helperRoots:locations.map(row=>row.directory),gitCommand:'/usr/bin/git',
   workerCommand:artifacts.writer,workerEnvironment:environment,writerConfig:{formatter:false},
   conversation:createNativeRevertConversation({openCodeClient:client,clientDeps:deps,isReady:()=>Boolean(nativeURL),
    admissionOwner:{withRevertOperation:(input,action)=>runtimeOwner.nativeOwner.withRevertOperation(input,action),
     releaseTransactionHolds:input=>runtimeOwner.nativeOwner.releaseTransactionHolds(input),
     recoverTransactionHolds:input=>runtimeOwner.nativeOwner.recoverTransactionHolds(input)}}),
   recheckPermit:input=>runtimeOwner.nativeOwner.recheckExecution(input),stopSessions:input=>runtimeOwner.stopSessions(input),
   cursor:{persist:input=>runtimeOwner.persistCursorRecord(input),withExecution:(input,action)=>runtimeOwner.withCursorExecution(input,action)}}});
 managed=createNativeManagedFixture({client,admissionOwner:{withManagedTaskDispatch:(input,action)=>runtimeOwner.nativeOwner.withManagedTaskDispatch(input,action),
  withPermit:(permit,action)=>runtimeOwner.nativeOwner.withPermit(permit,action)},executionHost:host,directory,dataDirectory:descriptor.launch.webDataDirectory,
  buildOpenCodeUrl,getOpenCodeAuthHeaders:deps.getAuthHeaders,environment,observations,diagnostics,executionModel:{providerID:'cursor-acp',modelID:'composer-2.5',variant:'default'}});
 cursor=createCursorSdkRuntime({storageDir:path.join(descriptor.launch.webDataDirectory,'cursor-sdk-sessions'),env:environment,
  readAuth:()=>{throw Error('Native Cursor must not read legacy auth');},resolveApiKey:input=>runtimeOwner.resolveCursorApiKey(input),
  ownedReadOnly:(input,action)=>runtimeOwner.withCursorReadOnly(input,()=>readonlyScope.run(input,action)),nativeWarming:false,
  nodeBinary:process.execPath,useNodeWorkerForPrompts:true,usePersistentWorkerForPrompts:false,ripgrepPath:DEFAULT_RG,
  workerEnv:{...environment,CURSOR_BACKEND_URL:provider.baseURL,OPENCHAMBER_CURSOR_SETTING_SOURCES:'none'},
  onPersistRecord:input=>host.persistCursorRecord(input),executionAdapter:{start:input=>host.startCursor(input),
   startReadOnly:input=>runtimeOwner.withCursorReadOnlyExecution(async()=>{
    const scope=readonlyScope.getStore();if(!scope)throw Error('Actual Cursor readonly scope required');
    const handle=await host.startReadOnly(input);
    void handle.result.then(receipt=>observations.push({phase:'cursor_readonly_receipt',...scope,pid:handle.pid,receipt}),
     error=>diagnostics.push({phase:'cursor_readonly_receipt_failure',code:error?.code??error?.name}));
    return handle;
   }),beforePrompt:input=>host.beforeCursorPrompt(input)},
  ownedPrompt:scope=>runtimeOwner.ownedCursorPrompt(scope),readAgentConfig:()=>({model:'cursor-acp/composer-2.5'}),
  getWorkspaceDiff:async()=>'',logger:{error:(message,error)=>diagnostics.push({phase:'cursor_error',message,code:error?.code,
   frames:typeof error?.stack==='string'?error.stack.split('\n').filter(line=>line.trim().startsWith('at ')).slice(0,24):[]}),warn:()=>{},info:()=>{},log:()=>{}}});
 const principal=Object.freeze({scope:'local-admin',id:'local-admin'});
 const authorization=createNativeAuthorization({locations,manifest:artifacts.manifest,getRequestPrincipal:()=>principal,
  captureLocalAuthorization:original=>original===principal?()=>true:null,getMultiUserRuntime:()=>({enabled:false,connection:{configured:false,isLocalAccessActive:()=>true}})});
 runtimeOwner=createNativeRuntimeOwner({bundle,openCodeClient:client,admission,executionHost:host,primaryRuntime:managed.primaryRuntime,taskContext:managed.taskContext,
  getManagedRuntime:managed.getManagedRuntime,authorization,cursorRuntime:cursor,clientDependencies:deps,
  recordDiagnostic:row=>{diagnostics.push(row);return true;},
  supervisedController:{deniedReadDirectories:[]},
  withCredentialMutationQueue:createOpenAiOAuthCoordinator({readAuth:()=>undefined}).withAuthMutation,environment,
  onBound:child=>{controller=child;nativeURL=child.url;epoch++;observations.push({phase:'compiled_cursor_bound',instanceID:child.instanceID,pid:child.pid,catalog:child.bound.catalog});},
  onExit:exit=>observations.push({phase:'compiled_cursor_exit',...exit})});
 const createAccount=async(label,key)=>{
  const body={integrationID:'cursor-acp',label,value:{type:'key',key}};
  const result=await runtimeOwner.credentialOperation({kind:'cursor',directory,integrationID:'cursor-acp',configurationDigest:credentialMutationFingerprint({}),
   operation:'cursor.credential.create',method:'POST',path:'/api/credential',body,valueType:'key',requestedFingerprint:credentialMutationFingerprint(body)},
   {operation:'create',input:body});
  if(!result?.credentialID)throw Error('Actual native Cursor credential ID required');return result.credentialID;
 };
 const selectAccount=async id=>{
  const metadata=await runtimeOwner.credentialMetadata({kind:'cursor',directory,integrationID:'cursor-acp',configurationDigest:credentialMutationFingerprint({}),
   operation:'cursor.integration',method:'GET',path:'/api/integration/cursor-acp'});
  const selected=metadata.find(row=>row.id===id);if(!selected)throw Error('Actual native Cursor credential metadata required');
  return runtimeOwner.credentialOperation({kind:'cursor',directory,integrationID:'cursor-acp',configurationDigest:credentialMutationFingerprint({}),
   operation:'cursor.credential.activate',method:'POST',path:`/api/credential/${id}/activate`,valueType:'key',credentialID:id,
   expectedFingerprint:selected.expectedFingerprint,requestedFingerprint:credentialMutationFingerprint({id})},{operation:'activate',id});
 };
 let accountA,accountB;
 try{await runtimeOwner.start();
  accountA=await createAccount('Owned Cursor A','owned-loopback-account-a');
  accountB=await createAccount('Owned Cursor B','owned-loopback-account-b');await selectAccount(accountB);
  observations.push({phase:'cursor_native_accounts_selected',accountA,accountB,selectedID:accountB});
 }catch(cause){
  const cleanup=await Promise.allSettled([cursor.dispose(),runtimeOwner.close(),managed.close(),host.drain()]);
  const errors=cleanup.filter(row=>row.status==='rejected').map(row=>row.reason);
  if(errors.length)throw new AggregateError([cause,...errors],'compiled_cursor_initialization_failed');throw cause;
 }
 return {root,artifacts,bundle,descriptor,client,host,managed,cursor,runtimeOwner,directory,accountA,accountB,selectAccount,controller:()=>controller,
  async close(){const results=await Promise.allSettled([cursor.dispose(),runtimeOwner.close(),managed.close(),host.drain()]);
   const errors=results.filter(row=>row.status==='rejected').map(row=>row.reason);if(errors.length)throw new AggregateError(errors,'compiled_cursor_cleanup_failed');}};
}
