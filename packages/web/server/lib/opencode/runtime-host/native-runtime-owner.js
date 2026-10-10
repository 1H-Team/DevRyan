import {captureNativeSetupCredentialSeed} from './native-setup-credential-ack.js';
import {nativeBundleFileOperations} from './native-bundle-file-operations.js';
import {createNativeHelperOwner} from './native-helper-owner.js';
import fs from 'node:fs/promises';
import {bundleContinuationItem} from './bundle-owned-continuations.js';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createManagedOrchestrationPrivateHost } from '../../orchestration/private-host.js';
import { createRuntimeBundleStore } from './runtime-bundle.js';
import { verifyNativeRuntimeArtifacts } from './native-artifacts.js';
import { createNativeControllerProcess } from './native-process.js';
import { createNativeAdmissionOwner } from './native-admission-owner.js';
import { parseNativeProviderTiming } from './native-provider-timing.js';
import { createNativePrimaryStepOwner } from './primary-step-owner.js';
import { createNativeManagedTaskOwner } from './managed-task-owner.js';
import { createNativeRetention } from './native-retention.js';
import { createNativeSessionRemoval } from './native-session-removal.js';
import { createNativeConfigurationSnapshotResolver } from './native-configuration-snapshot.js';
import { loadNativeReviewedConfiguration } from './native-reviewed-configuration.js';
import { createNativeIntegrationOwner } from './native-integration-owner.js';
import { createNativeProviderConfigurationOperation } from './native-provider-configuration-operation.js';
import { createNativeCouncilOwner } from './council-owner.js';
import { reviewedCouncilMembers } from './reviewed-council-configuration.js';
import { createNativeSessionContextOwner } from './native-session-context-owner.js';
import { createNativeBrowserOwner } from './native-browser-owner.js';
import { readNativeBrowserAssets } from './native-browser-assets.js';
import { createPrivilegedOpenCodeClient } from '../opencode-client/privileged.js';
import { createNativeSlimOwner } from './native-slim-owner.js';
import { createNativeDocumentOwner } from './native-document-owner.js';
import { createNativeDocumentParser } from './native-document-parser.js';
import { createNativeDocumentRuntime } from './native-document-runtime.js';
import { createNativeImageRuntime } from './native-image-runtime.js';
import { createNativeSlimContextOwner } from './native-slim-context-owner.js';
import { createNativeControllerInterview } from './native-controller-interview.js';
import { createNativeProviderRuntimeOwner,migrateNativeClaudeLegacyFences } from './native-provider-runtime-owner.js';
import {nativeWebfetchBinaryDirectory} from './native-read-paths.js';
import {createNativeProjectLocations} from './native-project-locations.js';
import {resolveNativeProviderConfiguration} from './native-provider-configuration.js';
import {createNativeImageGeneration} from './native-image-generation.js';
import {createNativeCursorOwner} from './native-cursor-owner.js';
import {createNativeCursorRecovery} from './native-cursor-recovery.js';
import {createNativeObservationOwner} from './native-observation-owner.js';
import {createNativeRecoveredInputOwner} from './native-recovered-input.js';
import {createNativeClaudeLifecycleClient} from './native-claude-lifecycle-client.js';
import {CLAUDE_LIFECYCLE_PROTOCOL} from './native-claude-lifecycle.js';
import {createNativeClaudeEnrollmentOwner} from './native-claude-enrollment.js';
import {createNativeClaudeProfilePublication} from './native-claude-profile-publication.js';
import {projectNativeClaudeWorkerProfiles} from './native-claude-worker-profiles.js';

const fail = code => Object.assign(new Error(code), { code, status: 503, statusCode: 503 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const startupFailureCodes = new Set(['native_catalog_mismatch', 'native_clone_evidence_invalid', 'native_configuration_sources_changed',
  'native_cursor_catalog_invalid', 'native_checkpoint_admission_held', 'native_process_boot_timeout', 'native_process_command_timeout',
  'native_process_exit_unconfirmed', 'native_process_failed', 'native_controller_termination_unconfirmed',
  'runtime_bundle_reconciliation_required', 'runtime_bundle_recomposition_required']);
const catalogCauseCodes = 'helper_directory_denied|helper_denied|helper_timeout_invalid|controller_helper_denied|controller_helper_unavailable|mutation_runtime_unsupported|catalog_unavailable|catalog_file_invalid|model_build_failed|model_read_failed|model_account_failed|model_normalize_failed|provider_location_required|provider_location_expired|openai_method_unsupported|response_schema_invalid|schema_invalid|cause_unavailable';
const catalogStartupCode = new RegExp(`^native_catalog_(?:construction_failed|read_failed_(?:agent|plugin|model)_(?:http_[45][0-9]{2}|refusal_(?:403|409|503)))_(?:${catalogCauseCodes})$`);
const startupFailureCode = cause => {
  const code = cause?.code ?? cause?.message;
  return typeof code === 'string' && (startupFailureCodes.has(code) || catalogStartupCode.test(code)) ? code : 'native_startup_failed';
};

/** Every launch rechecks the frozen selection and the complete bundle. */
export function createRuntimeBundleVerifier(binding, privatePersistence={}) {
  const store = createRuntimeBundleStore({ controlRoot: binding.controlRoot,
    allowRecoveredInputStartup:true, ...privatePersistence,
    withQuiescedSource: async () => { throw fail('runtime_bundle_checkpoint_required'); },
    runMigration: async () => { throw fail('runtime_bundle_migration_not_requested'); } });
  return async () => {
    if (binding.admission === 'held') throw fail('runtime_bundle_reconciliation_required');
    const selected = await store.readSelected();
    if (!selected || selected.selection.revision !== binding.selection.revision
      || selected.selection.selectedBundleID !== binding.descriptor.bundleID
      || JSON.stringify(selected.descriptor) !== JSON.stringify(binding.descriptor)) throw fail('runtime_bundle_recomposition_required');
    const verified = await store.verify({ bundleID: binding.descriptor.bundleID, phase: 'resume' });
    if (selected.selection.reconciliationRequired) throw fail('runtime_bundle_reconciliation_required');
    return verified;
  };
}

/** Resume uses the complete selected bundle and its immutable reviewed configuration.
 * `verified` is the result of `verify()` that the caller has just awaited, so boot does
 * not stream every harness ledger or signed artifact twice. It must match the binding, otherwise loading fails closed.
 * Each launch still runs `verify` again. */
export async function loadNativeRuntimeBundle({ binding, launcher, verify = createRuntimeBundleVerifier(binding), verified, getRegisteredProjects }) {
  if (binding.admission === 'held') throw fail('runtime_bundle_reconciliation_required');
  if (binding.descriptor.generation !== 2) throw fail('native_runtime_generation_mismatch');
  if (verified === undefined) verified = await verify();
  if (verified?.integrity !== 'verified' || verified.phase !== 'resume'
    || verified.descriptor?.bundleID !== binding.descriptor.bundleID) throw fail('runtime_bundle_recomposition_required');
  const descriptor = binding.descriptor, launch = descriptor.launch;
  const artifacts = verified.artifacts ?? await verifyNativeRuntimeArtifacts({ manifestPath: launch.artifactManifestPath, manifestSha256: launch.artifactManifestSha256, launcher });
  if (artifacts.manifestPath !== launch.artifactManifestPath || artifacts.manifestSha256 !== launch.artifactManifestSha256
    || artifacts.launcher !== launcher || artifacts.controller !== launch.controllerBinary || artifacts.writer !== launch.writerBinary) throw fail('native_runtime_artifacts_unverified');
  const reviewed = JSON.parse(await fs.readFile(launch.reviewedNativeConfigPath, 'utf8'));
  const registrationBytes = await fs.readFile(launch.reviewedPluginManifestPath);
  const plugins = JSON.parse(registrationBytes.toString('utf8'));
  if (reviewed.schema !== 1 || !reviewed.configuration || !reviewed.catalogRequirements || !Array.isArray(reviewed.locations)
    || !reviewed.locations.length || plugins.schema !== 1 || !Array.isArray(plugins.plugins)) throw fail('native_reviewed_configuration_invalid');
  for (const location of reviewed.locations) {
    if (!descriptor.projectMap.some(mapping => mapping.targetDirectory === location.directory)
      || await fs.realpath(location.directory) !== location.directory) throw fail('native_location_unreviewed');
  }
  if (new Set(reviewed.locations.map(location => location.directory)).size !== descriptor.projectMap.length) throw fail('native_location_unreviewed');
  const reviewedConfiguration = await loadNativeReviewedConfiguration(artifacts);
  const locations=reviewed.locations.map(location=>({...location,readRoots:[...(location.readRoots??[location.directory]),
    nativeWebfetchBinaryDirectory(launch.global.tmp,location.directory)]}));
  const deriveLocations=typeof getRegisteredProjects==='function'?createNativeProjectLocations({baseLocations:reviewed.locations,launch,getRegisteredProjects}):undefined;
  const refreshLocations=async()=>{if(deriveLocations)locations.splice(0,locations.length,...await deriveLocations());};
  await refreshLocations();
  const resolveConfiguration=createNativeConfigurationSnapshotResolver({resolveSlimAgents:reviewedConfiguration?.resolveSlimAgents,ponytailCommands:reviewedConfiguration?.ponytailCommands,
    ...(deriveLocations?{getRuntimeLocations:()=>deriveLocations()}:{} )});
  return { descriptor, artifacts, controlRoot: binding.controlRoot, preparedManifestSha256: binding.selection.preparedManifestSha256, configuration: reviewed.configuration, locations,
    reviewedConfiguration, refreshLocations, prepareLocations:deriveLocations??(async()=>locations),
    catalogRequirements: reviewed.catalogRequirements,
    reviewedPlugins: plugins.plugins.map(({ id, manifestDigest, capabilities }) => ({ id, manifestDigest, capabilities })), verify,
    resolveConfiguration: revision => resolveConfiguration({ binding, revision, expectedRegistrationDigest: hash(registrationBytes) }) };
}

/** Compose native transport with the existing ledger, scheduler and primary owner. */
export function createNativeRuntimeOwner(options) {
  const { bundle, openCodeClient, admission, executionHost, primaryRuntime, taskContext, getManagedRuntime, authorization } = options;
  if (!bundle?.descriptor || typeof bundle.verify !== 'function' || typeof authorization?.captureWebAuthorization !== 'function'
    || typeof authorization.authorizeOperation !== 'function') throw fail('native_runtime_dependencies_required');
  const { descriptor, artifacts } = bundle;
  const recordStartupDiagnostic = (event, payload) => {
    try {
      if (options.recordDiagnostic?.({ type: 'lifecycle', event, payload: {
        bundleID: descriptor.bundleID, buildId: artifacts.manifest.buildId, ...payload,
      } }) === false) console.warn('native_observation_unavailable');
    } catch { console.warn('native_observation_unavailable'); }
  };
  const supportsClaudeLifecycle=artifacts.manifest.compiledContracts?.includes(CLAUDE_LIFECYCLE_PROTOCOL)===true;
  const selectedPreparedManifestSha256 = bundle.preparedManifestSha256;
  const assertSelectedClone = async () => {
    if (!descriptor.sourceBundleID) return;
    if (!/^[a-f0-9]{64}$/.test(selectedPreparedManifestSha256 ?? '')
      || hash(await fs.readFile(descriptor.preparedManifestPath)) !== selectedPreparedManifestSha256) throw fail('native_clone_evidence_invalid');
  };
  const cursorRecovery=createNativeCursorRecovery({directory:path.join(descriptor.launch.webDataDirectory,'harness','native-cursor'),
    ownerID:descriptor.bundleID,runtime:executionHost.runtime,...options.privatePersistence});
  let child, starting, primaryStep, stopping = false, stopped = false, phase = 'closed', checkpointHeld = false;
  let recoveredInputs;
  let claudeEnrollment;
  let httpToken, lastExit, unsettledLaunch, configurationSnapshot, integrations, providers, providerConfiguration, interviews, sessionContext, slim, slimContext, documents, images, cursor, nativeInstanceID, reviewedBrowser, observationOwner;
  const imageNotices=new Map();
  const imageGeneration=bundle.reviewedConfiguration?.reviewedImagegenOriginals?createNativeImageGeneration({
    originals:bundle.reviewedConfiguration.reviewedImagegenOriginals,
    withImageGeneration:(invocation,action)=>{
      if(!integrations)throw fail('native_image_generation_owner_required');return integrations.withImageGeneration(invocation,action);
    },
  }):undefined;
  const privileged = options.clientDependencies ? createPrivilegedOpenCodeClient(options.clientDependencies) : undefined;
  const readSessionMetadata = async ({ sessionID, directory }) => {
    if (!privileged) throw fail('native_context_metadata_owner_required');
    return privileged.readSessionMetadata(sessionID, { directory });
  };
  let configurationRevision = 0;
  const reviewedBehaviorCommands = options.reviewedBehaviorCommands ?? bundle.reviewedPlugins.flatMap(origin=>{
    const declarations=origin.id==='devryan.slim-commands'&&bundle.reviewedConfiguration?{...bundle.reviewedConfiguration.slimCommandDeclarations,interview:bundle.reviewedConfiguration.interviewCommandDeclaration}
      :origin.id==='devryan.ponytail'&&bundle.reviewedConfiguration?{ponytail:bundle.reviewedConfiguration.ponytailCommandDeclaration}:undefined;
    return Object.entries(declarations??{}).map(([name,definition])=>({origin:{kind:'plugin',...origin},name,definition}));
  });
  const active = () => { if (!child || child.hasExited()) throw fail('native_controller_unavailable'); return child; };
  const recordObservationGap = ({ stage, controllerInstanceID = nativeInstanceID, sessionID, directory }) => {
    try {
      if (typeof options.recordDiagnostic !== 'function' || options.recordDiagnostic({ type: 'lifecycle', event: 'native_observation_gap',
        ...(sessionID ? { sessionID, directory } : {}), payload: { stage, controllerInstanceID, code: 'native_observation_unavailable' } }) === false) {
        console.warn('native_observation_unavailable');
      }
    } catch { console.warn('native_observation_unavailable'); }
  };
  const nativeOwner = createNativeAdmissionOwner({ getInstanceID:()=>nativeInstanceID, runtime: executionHost.runtime, directory: bundle.locations[0].directory,
    assertRecoveredInputOperation:(request,entry)=>recoveredInputs?.assertOperation(request,entry),
    verifyRecoveredInputPublication:input=>recoveredInputs.beforePublish(input),
    withRecoveredPrimaryGrant:(input,record,action,originalRecheck)=>recoveredInputs.has(input.sessionID)
      ?recoveredInputs.automatic({...input,expectedItem:bundleContinuationItem(record)},record,()=>primaryRuntime.authorizeRecoveredInputOwner(record),action):action(originalRecheck),
    withRecoveredShellGrant:(input,authorize,action)=>recoveredInputs.automatic(input,null,authorize,action),
    verifyQueuedPrimaryIdle:input=>active().call({action:'queued-primary-idle-owned',...input}),captureQueuedPrimaryAdmission:sessionID=>primaryRuntime.captureNativePromptAdmission(sessionID),readQueuedPrimaryRecord:sessionID=>primaryRuntime.readRecord(sessionID),
    ownerID: descriptor.bundleID, protectedRoots: [path.dirname(descriptor.preparedManifestPath)],
    reviewedConfiguration: structuredClone(bundle.configuration),
    getReviewedConfiguration: directory => configurationSnapshot
      ? configurationSnapshot.locations.find(location => location.directory === directory)?.configuration : bundle.configuration,
    reviewedBehaviorCommands,
    withSessionLock: admission.withSessionLock, ...authorization,
    captureCommandPromptAdmission: input => {
      if (typeof options.captureCommandPromptAdmission !== 'function') throw fail('native_command_admission_owner_required');
      return options.captureCommandPromptAdmission(input);
    },
    observeAcceptedUser: input => {
      if (!observationOwner) throw fail('native_observation_unavailable');
      return observationOwner.observeAcceptedUser(input);
    },
    observeAcceptedUserGap: async ({ sessionID, directory }) => recordObservationGap({ stage: 'accepted-user', sessionID, directory }),
    captureWebAuthorization: async (...args) => {
      if (phase !== 'ready' || stopping) throw fail('native_runtime_not_ready');
      const reauthorize = await authorization.captureWebAuthorization(...args);
      return async () => {
        if (phase !== 'ready' || stopping) throw fail('native_runtime_not_ready');
        await reauthorize();
        if (phase !== 'ready' || stopping) throw fail('native_runtime_not_ready');
      };
    },
    getSession: sessionID => openCodeClient.sessions.get(sessionID),
    readSessionMetadata,
    readUserMessage: async ({sessionID,messageID,directory}) => {
      if(!privileged)throw fail('native_context_metadata_owner_required');
      return privileged.readUserMessage(sessionID,messageID,{directory});
    },
    bindShellJob: input => executionHost.nativeExecution({ ...input, action: 'bind-shell-job' }),
    getShellJobReceipt: input => executionHost.nativeShellJobReceipt(input),
    verifyManagedTaskDispatch: input => getManagedRuntime().verifyNativeTaskDispatch(input),
    verifyPrimaryContinuationDispatch: input => primaryRuntime.captureNativeContinuationDispatch({ ...input, instanceID: nativeInstanceID }),
    verifyPrimaryRecoveryDispatch:input=>primaryRuntime.captureNativeRecoveryDispatch({...input,instanceID:nativeInstanceID}),
    bindNativeRecoveryDispatchInput:input=>primaryRuntime.bindNativeRecoveryDispatchInput({...input,instanceID:nativeInstanceID}),
    onContinuation: async input => {
      if (input.operation === 'execution.wake') return active().call({ action: 'wake-deferred-owned', sessionID: input.sessionID, permit: input.permit });
      if (input.operation === 'shell.recover') return active().call({ action: 'recover-shell-owned', sessionID: input.sessionID, jobID: input.jobID });
      if (input.operation === 'shell.complete') return active().call({ action: 'reconcile-shell-owned', sessionID: input.sessionID, messageID: input.messageID, permit: input.permit });
      throw fail('native_continuation_unavailable');
    },
  });
  recoveredInputs=createNativeRecoveredInputOwner({databasePath:descriptor.launch.opencodeDatabasePath,primaryRuntime,
    withSessionLock:admission.withSessionLock,
    readiness:()=>{if(phase!=='ready'||stopping||stopped||!child||child.hasExited())throw fail('native_runtime_not_ready');},
    captureAuthorization:input=>authorization.captureWebAuthorization({operation:'recovery.input',sessionID:input.sessionID,directory:input.directory},
      {id:input.sessionID,directory:input.directory,parentID:input.session.parent_id??undefined}),
    runOwned:({action,input,recheck})=>nativeOwner.withRecoveredInputOperation({...input,action,recheck},permit=>active().call({
      action:action==='resume'?'reconcile-primary-owned':'cancel-recovered-input-owned',sessionID:input.sessionID,messageID:input.messageID,
      ...action==='discard'?{payloadHash:input.payloadHash,enqueuedSeq:input.enqueuedSeq,cancellationReceiptVersion:1}:{},permit})),
  });
  primaryRuntime.setRecoveredInputOwner(recoveredInputs);
  const readCanonicalMessages=async({sessionID,directory},usersOnly=false)=>{
    const users=[],cursors=new Set();let before,size=0,count=0,latestTurnParent;
    do{
      if(usersOnly&&!privileged)throw fail('native_context_metadata_owner_required');
      const page=usersOnly
        ? await privileged.readCanonicalUserPage(sessionID,{limit:200,...before?{before}:{}},{directory,maxResponseBytes:64*1024*1024})
        : await openCodeClient.sessions.messages(sessionID,{limit:200,...before?{before}:{}},{directory,maxResponseBytes:64*1024*1024});
      if(!Array.isArray(page?.records))throw fail('native_context_messages_invalid');
      count+=usersOnly?page.scannedCount:page.records.length;if(count>2000)throw fail('native_context_messages_limit');
      if(usersOnly&&page.latestTurnParent&&!latestTurnParent)latestTurnParent=page.latestTurnParent;
      const selected=page.records;
      if(selected.some(row=>row.info.sessionID!==sessionID||!Array.isArray(row.parts)))throw fail('native_context_messages_invalid');
      size+=usersOnly?Math.max(page.scannedBytes,Buffer.byteLength(JSON.stringify(selected))):Buffer.byteLength(JSON.stringify(selected));if(size>64*1024*1024)throw fail('native_context_messages_limit');
      users.unshift(...selected);before=page.cursor;
      if(before){if(cursors.has(before))throw fail('native_context_messages_invalid');cursors.add(before);}
    }while(before);
    return usersOnly?{records:users,latestTurnParent}:users;
  };
  const readCanonicalContext=input=>readCanonicalMessages(input,true);
  const readCanonicalUsers=async input=>(await readCanonicalContext(input)).records;
  const readUserAttachments=async scope=>(await readCanonicalUsers(scope)).flatMap(message=>message.parts.filter(part=>part.type==='file')
    .map(part=>({messageID:message.info.id,part:Object.fromEntries(['id','url','filename','mime','name','mimeType'].filter(key=>part[key]!==undefined).map(key=>[key,part[key]]))})));
  const captureContextAssets=async input=>{
    if(!Array.isArray(input?.messageIDs)||input.messageIDs.length>2000||new Set(input.messageIDs).size!==input.messageIDs.length
      ||!input.messageIDs.every(id=>typeof id==='string'&&/^msg[A-Za-z0-9_-]{1,128}$/.test(id))||!input.messageIDs.includes(input.messageID))throw fail('native_image_scope_invalid');
    const messageIDs=[...input.messageIDs];
    const location=configurationSnapshot?.locations.find(row=>row.directory===input.directory);
    const origin=bundle.reviewedPlugins.find(row=>row.id==='devryan.slim');
    if(!location||!origin||location.activeRegistrationIDs&&!location.activeRegistrationIDs.includes(origin.id))throw fail('native_slim_inactive');
    const captured=await nativeOwner.captureSessionHookAuthorization({...input,phase:'context'});
    const recheck=async()=>{await captured();const session=await openCodeClient.sessions.get(input.sessionID,{directory:input.directory});
      if(session?.id!==input.sessionID||session.directory!==input.directory||session.revert||session.time?.archived)throw fail('native_context_session_stale');await captured();};
    await recheck();const snapshot=await readCanonicalContext(input);await recheck();
    const anchor=snapshot.latestTurnParent;
    if(!anchor||anchor.id!==input.messageID||!messageIDs.includes(anchor.id))throw fail('native_context_message_stale');
    const messages=snapshot.records.filter(message=>messageIDs.includes(message.info.id));
    const recheckSnapshot=async()=>{await recheck();const current=await readCanonicalContext(input);await recheck();
      if(JSON.stringify(current)!==JSON.stringify(snapshot))throw fail('native_context_message_changed');};
    await recheckSnapshot();
    const config=location.compatibility.slim?.mergedConfig;
    if(!record(config))throw fail('native_slim_configuration_invalid');
    const disabledAgents=Array.isArray(config.disabled_agents)?config.disabled_agents:['observer'];
    const imageRouting=config.image_routing??(disabledAgents.includes('observer')?'direct':'auto');
    if(!['auto','direct'].includes(imageRouting))throw fail('native_slim_configuration_invalid');
    return {contextAssetID:randomUUID(),recheck:recheckSnapshot,anchor:structuredClone(anchor),messageIDs,messages:structuredClone(messages),imageRouting,disabledAgents,origin:{kind:'plugin',...origin}};
  };
  const removal = createNativeSessionRemoval({ runtime: executionHost.runtime, admissionOwner: nativeOwner,
    ownerID: descriptor.bundleID,
    inspectRemovalOwned: input => active().call({ action: 'inspect-removal-owned', ...input }),
    removeLeafOwned: input => active().call({ action: 'remove-leaf-owned', ...input }),
    cancelManaged: input => getManagedRuntime().cancelSessionsForRemoval(input),
    cancelAndWait: input => executionHost.executions.cancelAndWait(input),
  });
  const retention=createNativeRetention({admissionOwner:nativeOwner,controller:active,removal,runtime:executionHost.runtime,ownerID:descriptor.bundleID});
  const managedTask = createNativeManagedTaskOwner({ admissionOwner: nativeOwner, taskContext, executionHost, getManagedRuntime });
  const council = createNativeCouncilOwner({ admissionOwner: nativeOwner, taskContext, executionHost, getManagedRuntime,
    readCouncilMembers: async input => reviewedCouncilMembers(configurationSnapshot, input) });
  const browserOrigin = bundle.reviewedPlugins.find(origin => origin.id === 'devryan.browser');
  const browserOperation = browserOrigin ? createNativeBrowserOwner({ admissionOwner: nativeOwner, openCodeClient,
    origin: { kind: 'plugin', ...browserOrigin }, getLeaseRuntime: options.getBrowserLeaseRuntime }) : undefined;
  const helperText=createNativeHelperOwner({admissionOwner:nativeOwner,current:()=>{
    if(phase!=='ready'||stopping)throw fail('native_runtime_not_ready');return active();
  },headers:()=>({authorization:`Bearer ${httpToken}`,...nativeOwner.requestHeaders(),...integrations?.requestHeaders()}),fetchImpl:options.fetchImpl??fetch});
  const handleRpc = async ({ method, params }, context) => {
    if(method==='native.helper.assert')return helperText.assert(params);
    if(method==='native.helper.settled')return helperText.settled(params);
    if (stopped || typeof method !== 'string') throw fail('native_bridge_stopped');
    if (method.startsWith('native.admission.')) return nativeOwner.handleRpc(method, params);
    if(method==='native.recovered-input.settled'){
      if(params?.instanceID!==nativeInstanceID||typeof params.sessionID!=='string')throw fail('native_recovered_input_fenced');
      await recoveredInputs.published(params.sessionID);return null;
    }
    if (method === 'native.observation') {
      if (!observationOwner) throw fail('native_observation_unavailable');
      return observationOwner.handleRpc(method, params);
    }
    if (method === 'native.provider-timing') {
      // Turn timing only: no permit, no authority, nothing durable.
      const timing = parseNativeProviderTiming(params);
      if (timing.controllerInstanceID !== nativeInstanceID) throw fail('native_provider_timing_expired');
      try { options.onProviderTiming?.(timing); } catch { /* Observer only. */ }
      return null;
    }
    if (method === 'native.primary-step') {
      if (!primaryStep) throw fail('native_primary_owner_unavailable');
      return primaryStep(params);
    }
    if (method === 'native.managed-task') return managedTask(params, context);
    if (method === 'native.council') return council(params, context);
    if(method.startsWith('native.slim.interview.')){
      if(!interviews)throw fail('native_interview_owner_unavailable');
      return interviews.handleRpc(method,params,context);
    }
    if(method==='native.slim.secondary.begin')return nativeOwner.beginWebfetchSecondary(params);
    if(method==='native.cursor.assert'){
      if(!cursor)throw fail('native_cursor_owner_unavailable');return cursor.assertRecord(params);
    }
    if(method==='native.cursor.settle.assert'){
      if(!cursor)throw fail('native_cursor_owner_unavailable');return cursor.assertSettlement(params);
    }
    if(method==='native.cursor.key.assert'){
      if(!cursor)throw fail('native_cursor_owner_unavailable');return cursor.assertKey(params);
    }
    if(method==='native.cursor.readonly.key.assert'){
      if(!cursor)throw fail('native_cursor_owner_unavailable');return cursor.assertReadOnlyKey(params);
    }
    if(method==='native.slim.secondary.end')return nativeOwner.endWebfetchSecondary(params);
    if(method==='native.slim.images-skipped'){
      if(!record(params)||Object.keys(params).some(key=>!['directory','sessionID','permit','phase'].includes(key)))throw fail('native_image_context_invalid');
      const recheck=await nativeOwner.captureSessionHookAuthorization(params);await recheck();
      const now=Date.now();if(now-(imageNotices.get(params.directory)??0)>60_000){
        if(typeof options.emitIntegrationEvent!=='function')throw fail('native_image_web_owner_required');
        await options.emitIntegrationEvent({directory:params.directory,sessionID:params.sessionID,kind:'images-skipped'});
        imageNotices.set(params.directory,now);
      }await recheck();return null;
    }
    if(method==='native.slim.context'){
      if(!slimContext||!record(params))throw fail('native_slim_context_unavailable');
      const {action,...input}=params;
      if(action==='transform')return slimContext.transformMessages(input,context);
      if(action==='retry')return slimContext.retry(input,context);
      throw fail('native_slim_context_unavailable');
    }
    if(method==='native.slim.images'||method==='native.slim.images.settle'){
      if(!images)throw fail('native_image_owner_unavailable');
      return method==='native.slim.images'?images.transform(params,context):images.settle(params);
    }
    if(method==='native.document.context'||method==='native.document.tool'||method==='native.document.settle'){
      if(!documents)throw fail('native_document_owner_unavailable');
      if(method==='native.document.settle')return documents.settle(params);
      return method==='native.document.context'?documents.context(params,context):documents.tool(params,context);
    }
    if (['native.slim.hook','native.slim.path','native.slim.accepted-command','native.ponytail.command'].includes(method)) {
      if(!slim)throw fail('native_slim_owner_unavailable');
      if(method==='native.slim.path')return slim.path(params,context);
      if(method==='native.slim.accepted-command')return slim.acceptedCommand(params,context);
      return method==='native.slim.hook'?slim.hook(params,context):slim.ponytailCommand(params,context);
    }
    if (method.startsWith('native.session-context')) {
      if (!sessionContext) throw fail('native_context_owner_unavailable');
      if (method === 'native.session-context.tool') return sessionContext.tool(params, context);
      if (method === 'native.session-context.observe-tool') return sessionContext.observeTool(params, context);
      if (method === 'native.session-context') return sessionContext.context(params, context);
      throw fail('native_context_operation_unavailable');
    }
    if (method.startsWith('integration.') || method.startsWith('openai.')
      || ['credential.mutation.commit', 'credential.resolution.commit', 'provider.credential.assert', 'provider.attempt'].includes(method)) {
      if (!integrations) throw fail('native_integration_owner_unavailable');
      try { return await integrations.handleRpc(method, params, context); }
      catch (cause) {
        // The shared private host serializes error messages. Restrict this
        // credential boundary to codes, never provider/credential payloads.
        const code = typeof cause?.code === 'string' && /^[a-z][a-z0-9_]{0,95}$/.test(cause.code)
          ? cause.code : 'native_integration_failed';
        throw Object.assign(fail(code), { statusCode: [400, 401, 403, 409, 503].includes(cause?.statusCode ?? cause?.status)
          ? cause.statusCode ?? cause.status : 503 });
      }
    }
    if(method.startsWith('provider.')){
      if(!providers)throw fail('native_provider_owner_unavailable');
      return providers.handleRpc(method,params,context);
    }
    if (method.startsWith('execution.native.')) return executionHost.nativeExecution({ ...params, action: method.slice('execution.native.'.length) }, context);
    throw fail('native_rpc_unavailable');
  };
  // Every authorized controller RPC's route, duration, status and connection
  // reuse reaches turn timing (observer only).
  const bridge = createManagedOrchestrationPrivateHost({ handleRpc, onRequestTiming: options.onBridgeTiming });
  const start = ({ admission: launchAdmission = 'open', beforeConfiguration } = {}) => {
    if (!['open', 'checkpoint'].includes(launchAdmission) || checkpointHeld && launchAdmission !== 'checkpoint') return Promise.reject(fail('native_checkpoint_admission_held'));
    if (launchAdmission === 'checkpoint') checkpointHeld = true;
    if (starting) return starting;
    if (unsettledLaunch) return Promise.reject(unsettledLaunch);
    if (stopping || stopped || child && !child.hasExited()) return Promise.reject(fail('native_controller_already_owned'));
    phase = 'closed';
    const startupStartedAt = Date.now();
    let startupStage = 'settlement', startupInstanceID, startupFailureRecorded = false;
    const startupDiagnostic = (phase, code, diagnostics) => recordStartupDiagnostic('native_startup', {
      phase, stage: startupStage, controllerInstanceID: startupInstanceID ?? null,
      durationMs: Math.max(0, Date.now() - startupStartedAt), ...(code ? { code } : {}),
      ...(diagnostics ? { diagnostics } : {}),
    });
    const recordStartupFailure = cause => {
      if (startupFailureRecorded) return;
      startupFailureRecorded = true;
      startupDiagnostic('failed', startupFailureCode(cause), cause?.startupDiagnostics);
    };
    startupDiagnostic('starting');
    starting = (async () => {
      // A crash's OS event is insufficient: publication and ACK recovery may
      // still be settling. Every replacement waits for this same barrier.
      if (child?.hasExited()) await child.killForRecovery();
      await lastExit;
      await integrations?.invalidate();
      await providers?.close();
      await interviews?.close();
      await documents?.close();
      await images?.close();
      await cursor?.close();
      lastExit = undefined;
      startupStage = 'verification';
      await bundle.verify();
      const instanceID=randomUUID();
      startupInstanceID = instanceID;
      startupStage = 'configuration';
      // The lifecycle synchronizes config inside this verified launch, avoiding a second full bundle scan.
      await beforeConfiguration?.();
      const recoveredSessionIDs=await recoveredInputs.install(instanceID);
      await bundle.refreshLocations?.();
      configurationSnapshot = await bundle.resolveConfiguration?.(++configurationRevision);
      if(configurationSnapshot&&JSON.stringify(configurationSnapshot.locations.map(location=>location.directory))!==JSON.stringify(bundle.locations.map(location=>location.directory)))throw fail('native_configuration_sources_changed');
      slim=configurationSnapshot&&bundle.reviewedConfiguration?createNativeSlimOwner({admissionOwner:nativeOwner,openCodeClient,
        configurationSnapshot,locations:bundle.locations,configDirectory:descriptor.launch.opencodeConfigDirectory,ponytailInstructions:bundle.reviewedConfiguration.ponytailInstructions}):undefined;
      slimContext=configurationSnapshot&&bundle.reviewedConfiguration?createNativeSlimContextOwner({admissionOwner:nativeOwner,openCodeClient,primaryRuntime,
        getManagedRuntime,getInstanceID:()=>nativeInstanceID===instanceID?instanceID:undefined,originals:bundle.reviewedConfiguration,locations:configurationSnapshot.locations}):undefined;
      images=configurationSnapshot&&bundle.reviewedPlugins.some(row=>row.id==='devryan.slim')?createNativeImageRuntime({admissionOwner:nativeOwner,executionHost,readContext:readCanonicalContext,locations:configurationSnapshot.locations}):undefined;
      const documentOrigin=bundle.reviewedPlugins.find(row=>row.id==='devryan.document-reader');
      if(documentOrigin&&configurationSnapshot&&bundle.reviewedConfiguration){
        const documentOwner=createNativeDocumentOwner({locations:bundle.locations,cacheRoot:path.join(descriptor.launch.global.cache,'devryan-documents'),
          createCache:bundle.reviewedConfiguration.createReviewedDocumentCache,readUserAttachments,
          readSession:input=>openCodeClient.sessions.get(input.sessionID,{directory:input.directory}),
          authorizeParent:async input=>{
            if(typeof authorization.authorizeRelatedSessionRead!=='function')throw fail('native_document_parent_owner_required');
            const [session,source,parent]=await Promise.all([input.sessionID,input.sourceSessionID,input.parentID].map(id=>openCodeClient.sessions.get(id,{directory:input.directory})));
            return authorization.authorizeRelatedSessionRead({session,source,parent});
          },
          parseAttachment:createNativeDocumentParser({launcher:artifacts.launcher,command:artifacts.writer,windowsOwner:options.privatePersistence?.windowsLedgerOwner,
            storage:path.join(descriptor.launch.global.state,'document-parser'),deniedReadDirectories:options.supervisedController?.deniedReadDirectories??[]})});
        documents=createNativeDocumentRuntime({admissionOwner:nativeOwner,documentOwner,reviewedConfiguration:bundle.reviewedConfiguration,
          readUserAttachments,locations:configurationSnapshot.locations,origin:{kind:'plugin',...documentOrigin}});
      }else documents=undefined;
      reviewedBrowser = browserOrigin ? await readNativeBrowserAssets(await options.getManagedBrowserEnvironment?.()) : undefined;
      const privateEnvironment = await bridge.start();
      const globals = descriptor.launch.global;
      nativeInstanceID = instanceID;
      observationOwner = configurationSnapshot ? createNativeObservationOwner({ instanceID, snapshot: configurationSnapshot,
        controller: () => child, isReady: () => nativeInstanceID === instanceID && phase === 'ready' && !stopping && !stopped && Boolean(child && !child.hasExited()),
        admissionOwner: nativeOwner, openCodeClient, recordDiagnostic: options.recordDiagnostic,
        onObservation: options.onNativeObservation }) : undefined;
      cursor=createNativeCursorOwner({instanceID,admissionOwner:nativeOwner,runtime:executionHost.runtime,controller:active,recovery:cursorRecovery,
        isReady:()=>nativeInstanceID===instanceID&&phase==='ready'&&!stopping,
        abortAndWait:sessionID=>options.cursorRuntime.abortAndWait(sessionID),onStarted:(scope,recheck)=>primaryStep.external(scope,recheck)});
      imageNotices.clear();
      const interviewOrigin=bundle.reviewedPlugins.find(row=>row.id==='devryan.slim');
      interviews=interviewOrigin&&configurationSnapshot?.locations.some(row=>row.activeRegistrationIDs?.includes('devryan.slim'))?createNativeControllerInterview({
        instanceID,snapshot:configurationSnapshot,locations:bundle.locations,originals:bundle.reviewedConfiguration.reviewedSlimInterviewOriginals,
        origin:{kind:'plugin',...interviewOrigin},admissionOwner:nativeOwner,authorization,openCodeClient,readMessages:readCanonicalMessages,
        controller:active,isCurrent:()=>nativeInstanceID===instanceID&&!stopping&&!stopped&&Boolean(child&&!child.hasExited()),
        executeDocument:executionHost.nativeInterviewDocument,
        baseURL:async()=>{if(typeof options.getWebBaseURL!=='function')throw fail('native_interview_web_owner_required');return options.getWebBaseURL();},
        openBrowser:async(scope,url)=>{if(typeof options.emitIntegrationEvent!=='function')throw fail('native_interview_web_owner_required');
          await options.emitIntegrationEvent({directory:scope.directory,sessionID:scope.sessionID,kind:'interview-open',path:new URL(url).pathname});},
      }):undefined;
      const launchIntegrations = configurationSnapshot ? createNativeIntegrationOwner({ instanceID, snapshot: configurationSnapshot,
        stateDirectory: globals.state, controller: active, isReady: () => phase === 'ready' && !stopping,
        withMutationQueue: options.withCredentialMutationQueue,
        captureWebAuthorization: input => authorization.captureWebAuthorization(input), admissionOwner: nativeOwner,
        recordDiagnostic: options.recordDiagnostic }) : undefined;
      integrations = launchIntegrations;
      httpToken = randomBytes(32).toString('base64url');
      primaryStep = createNativePrimaryStepOwner({ admissionOwner: nativeOwner, openCodeClient, primaryRuntime, instanceID,
        allowStopHandoff:artifacts.manifest.compiledContracts?.includes('devryan.primary-step-stop/1')===true,
        getInstanceID:()=>nativeInstanceID===instanceID?instanceID:undefined });
      if (bundle.reviewedPlugins.some(origin => origin.id === 'devryan.harness-context')) {
        if (!privileged) throw fail('native_context_metadata_owner_required');
        sessionContext = createNativeSessionContextOwner({ admissionOwner: nativeOwner, taskContext, openCodeClient, primaryRuntime, instanceID,getInstanceID:()=>nativeInstanceID===instanceID?instanceID:undefined,
          readSessionMetadata,
          isHeld: async scope => { const state = await executionHost.runtime.nativeAdmissionState(scope); return state.held || state.reverting; },
          authorizeContext: input => nativeOwner.captureContextAuthorization(input),
          writeTodos: async ({ sessionID, directory, todos, invocation }, recheck) => {
            // withPermit already owns the existing per-session admission lock.
            await recheck();
            const current = await readSessionMetadata({ sessionID, directory });
            if (current?.id !== sessionID || current.directory !== directory || !record(current.metadata)) throw fail('native_todo_metadata_scope_invalid');
            const metadata = current.metadata, devryan = record(metadata.devryan) ? metadata.devryan : {};
            const prior = devryan.todo;
            const revision = record(prior) && prior.sessionID === sessionID && Number.isSafeInteger(prior.rev) && prior.rev >= 0 ? prior.rev : 0;
            const todo = { sessionID, items: todos, rev: revision + 1 };
            const next = { ...metadata, devryan: { ...devryan, todo } };
            return nativeOwner.withNativeTodoWrite({ invocation, metadata: next }, async () => {
              await recheck(); await privileged.setMetadata(sessionID, next, { directory }); await recheck();
              return todo;
            });
          },
          deliverContinuation: async ({ scope, prompt }, recheck) => {
            await recheck();
            await nativeOwner.withPrimaryContinuationDispatch(scope, () => openCodeClient.prompts.prompt(scope.sessionID, prompt,
              { directory: scope.directory, origin: 'managed-primary', objectiveID: prompt.objectiveID }));
            const current = await primaryRuntime.readRecord(scope.sessionID);
            if (!current?.nativeContinuation && current?.continuationID === scope.messageID) return;
            await nativeOwner.withPrimaryContinuationOperation(scope, permit => active().call({ action: 'reconcile-primary-owned', sessionID: scope.sessionID, messageID: scope.messageID, permit }));
          },
        });
      } else sessionContext = undefined;
      await assertSelectedClone();
      const receipt = await fs.readFile(descriptor.migrationReceiptPath);
      const declaredCursor = options.cursorRuntime?.getDeclaredVirtualProvider?.();
      if (declaredCursor && (declaredCursor.id !== 'cursor-acp' || !record(declaredCursor.models))) throw fail('native_cursor_catalog_invalid');
      const cursorCatalog = declaredCursor ? { id: 'cursor-acp', models: Object.entries(declaredCursor.models).map(([id, model]) => {
        if (!record(model) || model.id !== id || model.variants !== undefined && !record(model.variants)) throw fail('native_cursor_catalog_invalid');
        return { id, variants: Object.keys(model.variants ?? {}) };
      }) } : undefined;
      const setupCredentialSeed=process.platform==='win32'?await captureNativeSetupCredentialSeed(path.join(globals.config,'native-setup-credentials.json'),options.privatePersistence?.windowsOwner):undefined;
      const boot = { ...(setupCredentialSeed?{setupCredentialSeed:setupCredentialSeed.expected}:{}),protocol: 1, type: 'boot', bundleID: descriptor.bundleID, instanceID, buildId: artifacts.manifest.buildId,
        manifestSha256: artifacts.manifestSha256, databasePath: descriptor.launch.opencodeDatabasePath, globals,
        directory: bundle.locations[0].directory, locations: bundle.locations,
        bridge: { url: privateEnvironment.DEVRYAN_ORCHESTRATION_URL, token: privateEnvironment.DEVRYAN_ORCHESTRATION_TOKEN }, httpToken,
        configuration: bundle.configuration, reviewedPlugins: bundle.reviewedPlugins.filter(origin => origin.id !== 'devryan.browser' || reviewedBrowser),
        ...(configurationSnapshot ? { configurationSnapshot } : {}),
        ...(cursorCatalog ? { cursorCatalog } : {}),
        ...(recoveredSessionIDs.length?{recoveredSessionIDs}:{}),
        migrationEvidence: { path: descriptor.migrationReceiptPath, sha256: hash(receipt),
          ...(descriptor.sourceBundleID ? { clone: { preparedManifestPath: descriptor.preparedManifestPath,
            preparedManifestSha256: selectedPreparedManifestSha256 } } : {}) }, catalogRequirements: bundle.catalogRequirements };
      const environment = { PATH: options.environment?.PATH ?? process.env.PATH, LANG: 'en_US.UTF-8', ...options.environment,
        HOME: globals.home, XDG_CONFIG_HOME: globals.config, XDG_DATA_HOME: globals.data, XDG_STATE_HOME: globals.state,
        XDG_CACHE_HOME: globals.cache, TMPDIR: globals.tmp, TMP: globals.tmp, TEMP: globals.tmp };
      const providerOrigin=bundle.reviewedPlugins.find(row=>row.id==='devryan.provider-compat');
      if(providerOrigin&&configurationSnapshot){
        const profiles=await resolveNativeProviderConfiguration({globals,environment:options.providerEnvironment??{},controlRoot:bundle.controlRoot});
        providerConfiguration=hash(JSON.stringify(profiles));
        const storage=path.join(globals.state,'provider-transport');await nativeBundleFileOperations(options.privatePersistence).ensureDirectory(storage);
        if(!artifacts.reviewedClaude)throw fail('native_provider_assets_required');
        const claudeSupported=supportsClaudeLifecycle;
        const claudeLifecycle=createNativeClaudeLifecycleClient({controller:active,
          isCurrent:()=>nativeInstanceID===instanceID&&Boolean(child&&!child.hasExited())});
        const providerWorkerInstanceID=randomUUID();
        providers=createNativeProviderRuntimeOwner({instanceID,snapshot:configurationSnapshot,registrationOrigin:{kind:'plugin',...providerOrigin},
          claudeSupported,
          controller:active,isReady:()=>nativeInstanceID===instanceID&&phase!=='closed'&&!checkpointHeld&&!stopping,
          withMutationQueue:options.withCredentialMutationQueue,admissionOwner:nativeOwner,cursor:options.cursorRuntime,
          claudeCredentials:{profiles:profiles.profiles,asset:artifacts.reviewedClaudeCredentials,oauthTokenExpiries:profiles.oauthTokenExpiries,
            lifecycle:claudeLifecycle},
          prepareMeridianProfiles:context=>projectNativeClaudeWorkerProfiles({profiles:profiles.profiles,globals,
            controlRoot:bundle.controlRoot,workerInstanceID:providerWorkerInstanceID,lifecycle:claudeLifecycle},context),
          meridian:{binary:artifacts.controller,cwd:boot.directory,environment,databasePath:boot.databasePath,
            supervisor:{launcher:artifacts.launcher,deniedReadDirectories:options.supervisedController?.deniedReadDirectories??[]},
            boot:{protocol:1,type:'provider-boot',provider:'anthropic',instanceID:providerWorkerInstanceID,buildId:boot.buildId,
              requestAuthorization:randomBytes(32).toString('hex'),globals,profiles:profiles.profiles,...profiles.defaultProfile?{defaultProfile:profiles.defaultProfile}:{},
              assets:artifacts.reviewedClaude,transport:{launcher:artifacts.launcher,storage,directories:bundle.locations.map(location=>location.directory)}}},
        });
        if(claudeSupported&&artifacts.reviewedClaudeCredentials){
          const publication=createNativeClaudeProfilePublication({home:globals.home,controlRoot:bundle.controlRoot,...options.privatePersistence});
          const snapshot=configurationSnapshot,bindings=new WeakSet();
          const principalKey=()=>{
            const principal=options.getRequestPrincipal?.();
            if(!principal||!['local-admin','managed'].includes(principal.scope)||typeof principal.id!=='string')throw fail('native_claude_enrollment_principal_required');
            return hash(JSON.stringify({scope:principal.scope,id:principal.id,appSessionId:principal.appSessionId??null,sessionTokenHash:principal.sessionTokenHash??null}));
          };
          const assertAuthority=async(binding,context)=>{
            if(!bindings.has(binding)||binding.directory!==context?.directory||binding.principalID!==principalKey()
              ||phase!=='ready'||stopping||checkpointHeld||configurationSnapshot!==snapshot||nativeInstanceID!==instanceID||!child||child.hasExited())throw fail('native_claude_enrollment_binding_changed');
            await binding.authorization();
            if(phase!=='ready'||stopping||checkpointHeld||configurationSnapshot!==snapshot||nativeInstanceID!==instanceID||!child||child.hasExited())throw fail('native_claude_enrollment_binding_changed');
          };
          const recheckBinding=async(binding,context)=>{
            await assertAuthority(binding,context);
            const current=await resolveNativeProviderConfiguration({globals,environment:options.providerEnvironment??{},controlRoot:bundle.controlRoot});
            if(hash(JSON.stringify(current))!==binding.providerConfigurationDigest
              ||JSON.stringify(await publication.snapshot())!==JSON.stringify(binding.profileFilesBaseline))throw fail('native_claude_enrollment_configuration_changed');
            await assertAuthority(binding,context);
          };
          claudeEnrollment=createNativeClaudeEnrollmentOwner({controlRoot:bundle.controlRoot,home:globals.home,
            asset:artifacts.reviewedClaudeCredentials,lifecycle:claudeLifecycle,withMutationQueue:options.withCredentialMutationQueue,
            beforeEnrollment:context=>migrateNativeClaudeLegacyFences({profiles:profiles.profiles,home:globals.home,
              asset:artifacts.reviewedClaudeCredentials,lifecycle:claudeLifecycle},context),
            captureBinding:async context=>{
              const directory=context?.directory;
              if(!snapshot.locations.some(row=>row.directory===directory)||!descriptor.projectMap.some(row=>row.targetDirectory===directory))throw fail('native_claude_enrollment_location_unreviewed');
              if(profiles.sources.profiles==='env'||profiles.sources.defaultProfile==='env')throw fail('native_claude_enrollment_environment_override');
              const binding={principalID:principalKey(),directory,controllerInstanceID:instanceID,providerConfigurationDigest:providerConfiguration,
                profileFilesBaseline:await publication.snapshot(),authorization:await authorization.captureWebAuthorization({operation:'provider.configuration',scope:'user',directory})};
              bindings.add(binding);await recheckBinding(binding,context);return binding;
            },
            recheckBinding,
            publishProfile:async(profile,binding,context)=>{
              await recheckBinding(binding,context);
              await publication.publish(profile,binding.profileFilesBaseline,{recheck:()=>assertAuthority(binding,context)});
            },
          });
        }else claudeEnrollment=undefined;
      }else providers=undefined;
      startupStage = 'controller';
      child = await createNativeControllerProcess({ binary: artifacts.controller, cwd: boot.directory, environment, boot,
        onObservationUnavailable: controllerInstanceID => recordObservationGap({ stage: 'controller', controllerInstanceID }),
        supervisor: { launcher: artifacts.launcher,
          deniedReadDirectories: options.supervisedController?.deniedReadDirectories ?? [] },
        timeoutMs: options.timeoutMs, logFile: path.join(globals.log, 'native-controller.jsonl'),
        beforeSpawn: async () => {
          await verifyNativeRuntimeArtifacts({ manifestPath: artifacts.manifestPath, manifestSha256: artifacts.manifestSha256, launcher: artifacts.launcher });
          await assertSelectedClone();
        },
        afterExit: exit => {
          phase = 'closed';
          recordStartupDiagnostic('opencode_process_exit', {
            controllerInstanceID: instanceID, pid: exit.pid ?? null, code: exit.code ?? null, signal: exit.signal ?? null,
            expected: exit.expected === true, uptimeMs: Math.max(0, Date.now() - (exit.startedAt ?? startupStartedAt)),
          });
          // Do not await this queue here: a reverse credential command may be
          // waiting for this very exit callback before it releases the queue.
          void launchIntegrations?.invalidate();
          lastExit = (async () => {
            await claudeEnrollment?.close();
            await cursor?.close();
            await providers?.close();
            await interviews?.close();
            await documents?.close();
            await images?.close();
            await executionHost.settleController();
            await helperText.controllerSettled(instanceID);
            await nativeOwner.invalidateController();
            await options.onExit?.(exit);
            unsettledLaunch = undefined;
          })();
          return lastExit;
        },
      });
      try {
        startupDiagnostic('bound', undefined, child.startupDiagnostics);
        await setupCredentialSeed?.settle(child.bound.setupCredentialSeed);
        await options.onBound?.(child);
        if (!child.bound.catalog.asserted) {
          const missing = child.bound.catalog.missing;
          const ids = values => Array.isArray(values) ? values.filter(value => typeof value === 'string' && value.length <= 256).slice(0, 128) : [];
          throw Object.assign(fail('native_catalog_mismatch'), { missingCatalog: {
            agents: ids(missing?.agents), plugins: ids(missing?.plugins), tools: ids(missing?.tools),
            models: Array.isArray(missing?.models) ? missing.models.filter(model => typeof model?.providerID === 'string'
              && model.providerID.length <= 256 && typeof model.id === 'string' && model.id.length <= 256)
              .slice(0, 128).map(({ providerID, id, variant }) => ({ providerID, id,
                ...(typeof variant === 'string' && variant.length <= 256 ? { variant } : {}) })) : [],
          } });
        }
        if (checkpointHeld) { phase = 'checkpoint'; return child; }
        startupStage = 'recovery';
        await options.beforeOpen?.();
        if (checkpointHeld) { phase = 'checkpoint'; return child; }
        // Private recovery may run while HTTP readiness and fresh web grants
        // remain closed. This also restores scheduler fences before relaunch.
        for(const location of bundle.locations)await retention.recover({directory:location.directory,instanceID});
        if (checkpointHeld) { phase = 'checkpoint'; return child; }
        await child.call({ action: 'open-recovery' });
        if (checkpointHeld) throw fail('native_checkpoint_admission_held');
        phase = 'recovering';
        for (const location of bundle.locations) {
          if (checkpointHeld) throw fail('native_checkpoint_admission_held');
          await removal.recover({ directory: location.directory });
          // The new controller has reaped the original registry and verified
          // its clone before opening private recovery. Only the current bundle
          // and its proved immediate checkpoint source own temporary holds.
          const holdOwners = new Set([descriptor.bundleID]);
          if (descriptor.checkpoint?.generation === 2) {
            if (descriptor.checkpoint.ownerID !== descriptor.sourceBundleID) throw fail('native_clone_evidence_invalid');
            holdOwners.add(descriptor.checkpoint.ownerID);
          }
          for (const ownerID of holdOwners) await executionHost.runtime.recoverNativeTransientHolds({ directory: location.directory, ownerID });
          await nativeOwner.recoverTransactionHolds({ directory: location.directory });
          await nativeOwner.recoverShellContinuations({ directory: location.directory });
          await cursor.recover({ directory: location.directory });
          await sessionContext?.recoverContinuations({ directory: location.directory });
          await nativeOwner.recoverExecutionContinuations({ directory: location.directory });
        }
        if (checkpointHeld) throw fail('native_checkpoint_admission_held');
        startupStage = 'open';
        await child.call({ action: 'open' });
        if (checkpointHeld) throw fail('native_checkpoint_admission_held');
        phase = 'ready';
        launchIntegrations?.markReady();
        startupDiagnostic('ready');
        return child;
      } catch (cause) { recordStartupFailure(cause); await child.close(); throw cause; }
    })().catch(cause => {
      recordStartupFailure(cause);
      if (cause?.nativeProcessUnsettled) {
        unsettledLaunch = cause;
        if (lastExit) void lastExit.then(() => { if (unsettledLaunch === cause) unsettledLaunch = undefined; }, () => {});
      }
      throw cause;
    }).finally(() => { starting = undefined; });
    return starting;
  };
  return {
    nativeOwner, handleRpc, start,
    checkpointController: () => { if (!child) throw fail('bundle_checkpoint_controller_unknown'); return child; },
    closeAdmissionForCheckpoint: async () => {
      checkpointHeld = true; phase = 'checkpoint';
      await starting;
      if (child && !child.hasExited()) await child.call({ action: 'close-startup' });
    },
    assertCheckpointAdmissionClosed: async () => {
      if (!checkpointHeld || phase === 'ready' || phase === 'recovering' || starting) throw fail('bundle_checkpoint_admission_open');
    },
    drainCredentialOwners: async () => {
      if (!checkpointHeld) throw fail('bundle_checkpoint_admission_open');
      await claudeEnrollment?.close();
      await integrations?.invalidate();
      await providers?.close();
      await options.withCredentialMutationQueue?.(async () => {});
    },
    captureContextAssets,
    dispatchNativeRecovery:async(record,prompt)=>{
      if(phase!=='ready'||stopping)throw fail('native_runtime_not_ready');
      const scope={sessionID:record.sessionID,directory:record.directory,messageID:prompt.messageID};
      return nativeOwner.withPrimaryRecoveryDispatch(scope,()=>openCodeClient.prompts.prompt(scope.sessionID,prompt,{directory:scope.directory,origin:'provider-recovery'}));
    },
    getConfigurationSnapshot: () => configurationSnapshot,
    getCatalogAvailability: () => child?.bound.catalog.availability ?? { selections: [] },
    getClaudeEnrollmentOwner: () => phase==='ready'&&!stopping&&!checkpointHeld?claudeEnrollment:null,
    inspectClaude: async (input, {signal} = {}) => {
      if(!supportsClaudeLifecycle)throw fail('native_claude_update_required');
      const owner=providers,snapshot=configurationSnapshot,instanceID=nativeInstanceID,expected=providerConfiguration;
      const directory=input.directory??snapshot?.locations[0]?.directory;
      const live=()=>{
        if(phase!=='ready'||stopping||checkpointHeld||!child||child.hasExited()||!owner||providers!==owner||configurationSnapshot!==snapshot||nativeInstanceID!==instanceID)throw fail('native_runtime_not_ready');
        signal?.throwIfAborted();
      };
      live();
      if(!snapshot.locations.some(row=>row.directory===directory)||!descriptor.projectMap.some(row=>row.targetDirectory===directory))throw fail('native_provider_configuration_location_unreviewed');
      const grant=await authorization.captureWebAuthorization({operation:'provider.configuration',scope:'read',directory});
      const recheck=async()=>{
        live();await grant();live();
        const current=await resolveNativeProviderConfiguration({globals:descriptor.launch.global,environment:options.providerEnvironment??{},controlRoot:bundle.controlRoot});
        live();if(hash(JSON.stringify(current))!==expected)throw fail('native_provider_configuration_changed');
        await grant();live();
      };
      await recheck();
      return owner.inspectClaude({directory,kind:input.kind},{recheck,signal});
    },
    withProviderConfigurationAuthorization: createNativeProviderConfigurationOperation({
      descriptor, getSnapshot: () => configurationSnapshot,
      isReady: () => phase === 'ready' && Boolean(child && !child.hasExited()) && !stopping,
      captureWebAuthorization: input => authorization.captureWebAuthorization(input),
      credentialMetadata: input => { if (!integrations) throw fail('native_integration_owner_unavailable'); return integrations.credentialMetadata(input); },
      credentialOperation: (spec, mutation) => { if (!integrations) throw fail('native_integration_owner_unavailable'); return integrations.credentialOperation(spec, mutation); },
    }),
    handleInterviewRequest:async(request,response)=>{
      if(!interviews||phase!=='ready'||stopping)throw fail('native_interview_owner_unavailable');
      return interviews.handleRequest(request,response);
    },
    getReviewedBrowser: () => {
      if (!reviewedBrowser || phase !== 'ready' || stopping) throw fail('native_browser_host_unavailable');
      return reviewedBrowser;
    },
    browserOperation: (invocation, event, context) => {
      if (!browserOperation || !reviewedBrowser || phase !== 'ready' || stopping) throw fail('native_browser_host_unavailable');
      return browserOperation(invocation, event, context);
    },
    continueSessionTodos: async input => {
      if (phase !== 'ready' || stopping || !sessionContext) return;
      return sessionContext.continueTodos(input);
    },
    configurationForDirectory: directory => {
      const configuration = configurationSnapshot
        ? configurationSnapshot.locations.find(location => location.directory === directory)?.configuration : bundle.configuration;
      if (!configuration || !bundle.locations.some(location => location.directory === directory)) throw fail('native_configuration_location_unreviewed');
      return configuration;
    },
    renameGeneratedTitle:request=>helperText.generate(request,true),
    generateHelperText:async request=>{
      if(!bundle.locations.some(location=>location.directory===request.directory)||await fs.realpath(request.directory)!==request.directory)throw fail('native_helper_location_unreviewed');
      return helperText.generate(request);
    },
    retainSessions:input=>{if(phase!=='ready'||stopping)throw fail('native_runtime_not_ready');return retention.run(input);},
    readRetentionSnapshot:async()=>{
      if(phase!=='ready'||stopping)throw fail('native_runtime_not_ready');
      const instanceID=nativeInstanceID,current=active();
      const sessions=await openCodeClient.sessions.list({limit:10001});
      if(instanceID!==nativeInstanceID||active()!==current||phase!=='ready'||stopping)throw fail('native_retention_epoch_changed');
      if(!Array.isArray(sessions)||sessions.length>10000)throw fail('native_retention_tree_unbounded');
      return {protocol:1,complete:true,instanceID,sessions};
    },
    removeSession: (sessionID, options = {}) => removal.remove({ sessionID, directory: options.directory }),
    isExecutionReady: () => Boolean(!checkpointHeld && (phase === 'ready' || phase === 'recovering') && child && !child.hasExited() && child.bound.catalog.asserted && !stopping),
    isReady: () => Boolean(phase === 'ready' && child && !child.hasExited() && child.bound.catalog.asserted && !stopping),
    getAuthHeaders: () => {
      if (!httpToken) throw fail('native_controller_unavailable');
      return { authorization: `Bearer ${httpToken}`, ...nativeOwner.requestHeaders(), ...integrations?.requestHeaders() };
    },
    withIntegrationOperation: (input, action) => {
      if (!integrations) throw fail('native_integration_owner_unavailable');
      return integrations.withCallerOperation(input, action);
    },
    credentialOperation: (operation, mutation) => {
      if (!integrations) throw fail('native_integration_owner_unavailable');
      return integrations.credentialOperation(operation, mutation);
    },
    getOpenAiOAuthCoordinator: () => {
      if (!integrations || phase !== 'ready' || stopping) throw fail('native_integration_owner_unavailable');
      return integrations.getOpenAiOAuthCoordinator();
    },
    readOpenAiAccountSelection: operation => {
      if (!integrations) throw fail('native_integration_owner_unavailable');
      return integrations.readOpenAiAccountSelection(operation);
    },
    stopOpenAiRequests: async operation => {
      if (!integrations || phase !== 'ready' || stopping) throw fail('native_integration_owner_unavailable');
      const captured = active(), instanceID = nativeInstanceID;
      const unblock = await integrations.holdOpenAiSelection(operation);
      const held = [];
      const release = async cleared => {
        for (const sessionID of held) {
          if (active() !== captured || nativeInstanceID !== instanceID || captured.hasExited()) throw fail('native_chatgpt_siwc_settlement_changed');
          await captured.call({ action: 'release', sessionID });
        }
        unblock(cleared);
      };
      try {
        await helperText.stopProvider('openai');
        const sessions = await openCodeClient.sessions.list({ limit: 10001 });
        if (!Array.isArray(sessions) || sessions.length > 10000) throw fail('native_chatgpt_siwc_sessions_unbounded');
        for (const session of sessions.filter(row => row.model?.providerID === 'openai')) {
          if (active() !== captured || nativeInstanceID !== instanceID || phase !== 'ready' || stopping) throw fail('native_chatgpt_siwc_settlement_changed');
          const state = await executionHost.runtime.nativeAdmissionState({ directory: session.directory, sessionID: session.id });
          if (state.held) continue;
          // The native hold owns cancellation acknowledgement and descendant settlement.
          await captured.call({ action: 'hold', sessionID: session.id }); held.push(session.id);
        }
        return release;
      } catch (error) { await release(false); throw error; }
    },
    readOpenAiCredential: (operation, credentialID) => {
      if (!integrations) throw fail('native_integration_owner_unavailable');
      return integrations.readOpenAiCredential(operation, credentialID);
    },
    readOpenAiSelected: operation => {
      if (!integrations) throw fail('native_integration_owner_unavailable');
      return integrations.readOpenAiSelected(operation);
    },
    readProviderSelected: operation => {
      if (!integrations) throw fail('native_integration_owner_unavailable');
      return integrations.readProviderSelected(operation);
    },
    credentialMetadata: operation => {
      if (!integrations) throw fail('native_integration_owner_unavailable');
      return integrations.credentialMetadata(operation);
    },
    imageGeneration:(invocation,args,context)=>{
      if(!imageGeneration)throw fail('native_image_generation_owner_required');return imageGeneration(invocation,args,context);
    },
    ownedCursorPrompt:({directory,sessionID,userMessageID,assistantMessageID,agent,modelID,variant})=>{
      if(!cursor)throw fail('native_cursor_owner_unavailable');return cursor.ownedPrompt({directory,sessionID,userMessageID,assistantMessageID,agent,modelID,...variant?{variant}:{}});
    },
    persistCursorRecord:input=>{if(!cursor)throw fail('native_cursor_owner_unavailable');return cursor.persist(input);},
    withCursorExecution:(input,action)=>{if(!cursor)throw fail('native_cursor_owner_unavailable');return cursor.withExecution(input,action);},
    resolveCursorApiKey:input=>{if(!cursor)throw fail('native_cursor_owner_unavailable');return cursor.resolveApiKey(input);},
    withCursorReadOnly:async(input,action)=>{
      if(!cursor||phase!=='ready'||stopping||!record(input)||!['title','text','catalog','verify'].includes(input.kind)
        ||!bundle.locations.some(location=>location.directory===input.directory)||await fs.realpath(input.directory)!==input.directory
        ||(input.kind==='title'?!input.sessionID:input.kind!=='text'&&input.sessionID!==undefined))throw fail('native_cursor_readonly_scope_required');
      const target=active(),selectedCursor=cursor;
      const session=input.sessionID?await openCodeClient.sessions.get(input.sessionID,{directory:input.directory}):undefined;
      if(session&&(session.directory!==input.directory||session.time?.archived||session.revert||session.model?.providerID!=='cursor-acp'))throw fail('native_cursor_readonly_scope_required');
      if(input.kind==='title'&&input.modelID&&(session.model?.id!==input.modelID||(session.model?.variant??undefined)!==input.variant))throw fail('native_title_selection_changed');
      const reauthorize=input.kind==='title' ? await authorization.captureTitleHelperAuthorization(session) : await authorization.captureWebAuthorization({operation:'cursor.readonly',sessionID:input.sessionID,directory:input.directory},session);
      const initial=session?await executionHost.runtime.nativeAdmissionState({directory:input.directory,sessionID:input.sessionID}):{revision:0,held:false,reverting:false};
      const recheck=async()=>{
        if(phase!=='ready'||stopping||child!==target||cursor!==selectedCursor)throw fail('native_cursor_owner_expired');
        await reauthorize();
        if(session){
          const current=await openCodeClient.sessions.get(input.sessionID,{directory:input.directory}),state=await executionHost.runtime.nativeAdmissionState({directory:input.directory,sessionID:input.sessionID});
          if(current.directory!==input.directory||current.time?.archived||current.revert||current.model?.providerID!=='cursor-acp'
            ||JSON.stringify(current.model)!==JSON.stringify(session.model)||current.agent!==session.agent||state.held||state.reverting||state.revision!==initial.revision)throw fail('native_cursor_scope_revoked');
        }
        await reauthorize();if(phase!=='ready'||stopping||child!==target||cursor!==selectedCursor)throw fail('native_cursor_owner_expired');
      };
      const scope={kind:input.kind,directory:input.directory,...input.sessionID?{sessionID:input.sessionID}:{}};
      return selectedCursor.withReadOnly(scope,{revision:initial.revision,recheck},action);
    },
    beforeCursorReadOnlyExecution:()=>{if(!cursor)throw fail('native_cursor_owner_unavailable');return cursor.beforeReadOnlyExecution();},
    withCursorReadOnlyExecution:action=>{if(!cursor)throw fail('native_cursor_owner_unavailable');return cursor.withReadOnlyExecution(action);},
    dispatchExternalPrompt:async(receipt,request)=>{
      const metadata=request.metadata?.devryan;
      if(metadata?.providerID!=='cursor-acp'||request.resume===false)return false;
      if(!cursor||!options.cursorRuntime||phase!=='ready'||stopping)throw fail('native_cursor_owner_unavailable');
      const session=await openCodeClient.sessions.get(receipt.sessionID,{directory:receipt.directory});
      if(session.agent!==metadata.agent||session.model?.providerID!=='cursor-acp'||session.model.id!==metadata.modelID)throw fail('native_cursor_selection_changed');
      const result=await options.cursorRuntime.handlePromptAsync({sessionID:receipt.sessionID,directory:receipt.directory,
        body:{...receipt.body,agent:session.agent,model:{providerID:'cursor-acp',modelID:session.model.id},variant:session.model.variant??'default'}});
      if(!result?.handled||(result.status??200)<200||(result.status??200)>=300)throw fail('native_cursor_prompt_rejected');return true;
    },
    cursorPrompt:async input=>{
      if(input.body?.model?.providerID!=='cursor-acp')return {handled:false};
      await openCodeClient.prompts.prompt(input.sessionID,input.body,{directory:input.directory});return {handled:true,status:204};
    },
    stopSessions: async ({ sessions }) => {
      for(const sessionID of sessions)await options.cursorRuntime?.abortAndWait(sessionID);
      for (const sessionID of sessions) await active().call({ action: 'hold', sessionID });
      return { terminated: true, sessions };
    },
    async close() {
      if (stopped) return;
      stopping = true; phase = 'closed';
      let startupFailure;
      try { await starting; } catch (cause) { startupFailure = cause; }
      // A failed boot can still own an unbound process. Keep its private
      // authority alive until the real exit/recovery callback settles it.
      if (unsettledLaunch) throw unsettledLaunch;
      // Admitted refreshes must finish their durable KV fences while the same
      // physical controller is still alive. Closing public admission does not
      // revoke those already-owned finalizers.
      await claudeEnrollment?.close();
      await integrations?.invalidate();
      await providers?.close();
      await options.withCredentialMutationQueue?.(async () => {});
      const settlementFailures = [];
      try {
        if (child) {
          if (child.hasExited()) await child.killForRecovery();
          else await child.close();
        }
        await lastExit;
      } catch (cause) { settlementFailures.push(cause); }
      // Owner shutdown is terminal even if the old controller's settlement
      // failed. Replacement uses settleController and never revives old grants.
      try { await executionHost.drain(); } catch (cause) { settlementFailures.push(cause); }
      if (settlementFailures.length === 1) throw settlementFailures[0];
      if (settlementFailures.length) throw new AggregateError(settlementFailures, 'Native final execution settlement failed');
      await integrations?.invalidate();
      await providers?.close();
      await cursor?.close();
      await cursorRecovery.drain();
      await interviews?.close();
      await bridge.stop();
      nativeOwner.dispose(); stopped = true;
      if (startupFailure) throw startupFailure;
    },
  };
}
