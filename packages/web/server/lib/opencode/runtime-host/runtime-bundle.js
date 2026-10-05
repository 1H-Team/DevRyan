import {relocateNativeSetupProfiles} from './native-setup-profiles.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSqliteDriver } from '../db-maintenance-core.js';
import { executionArtifacts } from '../execution-artifacts.js';
import { verifyNativeRuntimeArtifacts } from './native-artifacts.js';
import { withCrossProcessFileLock } from '../../../../../harness-runtime/lib/atomic-file.js';
import { parseNativeMigrationReceipt } from './native-process-protocol.js';
import { assertNoPendingMigration, assertBundlePendingInput, bundleFailure, canonicalJSON, captureMigrationInventory, containsPath, isRecord,
  readBundleJSON, saveBundleJSON, sha256, verifyMigrationReferences } from './bundle-migration-inventory.js';
import { verifyBundleOwnedContinuations } from './bundle-owned-continuations.js';
import {verifyBundleRecoveredInputs} from './bundle-recovered-inputs.js';
import { inspectBundleHarness } from './bundle-harness-integrity.js';
import {BUNDLE_CREDENTIAL_OWNER_PROTOCOL,isBundleCredentialOwnerEvidence,captureBundleCredentialOwners,assertBundleCredentialOwners} from './bundle-credential-owner-guard.js';

import {NATIVE_BUNDLE_CREDENTIAL_CONTRACT} from './native-bundle-credential-contract.js';
import {readRollbackIntentSync,rollbackIntentUnresolved,saveRollbackIntent,assertPrivateBundleControlRoot,assertRollbackPhysicalExit,captureRollbackFiles} from './bundle-rollback-intent.js';

const validID = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = bundleFailure;
const absolute = value => { if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) throw fail('bundle_path_invalid'); return value; };
const fileHash = async file => {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw fail('bundle_file_invalid');
  return sha256(await fs.readFile(file));
};
const launch = value => {
  if (!isRecord(value) || !isRecord(value.global) || !validHash(value.artifactManifestSha256)) throw fail('bundle_descriptor_invalid');
  for (const key of ['controllerBinary','artifactManifestPath','opencodeDatabasePath','webDataDirectory','webConfigDirectory',
    'opencodeConfigDirectory','reviewedNativeConfigPath','reviewedPluginManifestPath']) absolute(value[key]);
  absolute(value.writerBinary);
  for (const key of ['home','data','config','state','cache','tmp','bin','log','repos']) absolute(value.global[key]);
  if (value.global.config !== value.opencodeConfigDirectory || value.webConfigDirectory === value.opencodeConfigDirectory) throw fail('bundle_config_binding_invalid');
  return value;
};
const legacySource = value => {
  if(!isRecord(value)||!isRecord(value.global)||Object.keys(value).some(key=>!['opencodeDatabasePath','webDataDirectory','webConfigDirectory','opencodeConfigDirectory','global'].includes(key))
    || Object.keys(value.global).some(key=>key!=='home'))throw fail('bundle_legacy_source_invalid');
  for(const key of ['opencodeDatabasePath','webDataDirectory','webConfigDirectory','opencodeConfigDirectory'])absolute(value[key]);
  absolute(value.global.home);
  if(value.webConfigDirectory===value.opencodeConfigDirectory)throw fail('bundle_config_binding_invalid');
  return value;
};
const descriptor = (controlRoot,id,value) => {
  if (!validID(id) || !isRecord(value) || value.schema !== 1 || value.bundleID !== id || value.generation !== 2
    || !Number.isFinite(value.createdAt) || !isRecord(value.checkpoint) || !validID(value.checkpoint.checkpointID)
    || !Array.isArray(value.projectMap) || !value.projectMap.length||value.sourceBundleID!==undefined&&!validID(value.sourceBundleID)) throw fail('bundle_descriptor_invalid');
  const root = path.join(controlRoot,'bundles',id); launch(value.launch);
  const expected = {opencodeDatabasePath:path.join(root,'opencode','opencode.db'),
    webDataDirectory:path.join(root,'web-data'),webConfigDirectory:path.join(root,'config','openchamber'),
    opencodeConfigDirectory:path.join(root,'config','opencode'),reviewedNativeConfigPath:path.join(root,'config','reviewed-native.json'),
    reviewedPluginManifestPath:path.join(root,'config','reviewed-plugins.json')};
  for (const [key,file] of Object.entries(expected)) if (value.launch[key] !== file) throw fail('bundle_descriptor_path_mismatch');
  if (value.preparedManifestPath !== path.join(root,'prepared.json') || (value.generation === 2 && value.migrationReceiptPath !== path.join(root,'sources','migration.json'))) throw fail('bundle_descriptor_path_mismatch');
  for (const [key,file] of Object.entries(value.launch.global)) if (key !== 'config'
    && file !== path.join(root,'global',key,)) throw fail('bundle_descriptor_path_mismatch');
  return value;
};
export async function readRuntimeBundleDescriptor(controlRoot,bundleID) {
  absolute(controlRoot);
  if (!validID(bundleID)) throw fail('bundle_id_invalid');
  return descriptor(controlRoot,bundleID,await readBundleJSON(path.join(controlRoot,'bundles',bundleID,'descriptor.json')));
}
const sqlite = file => {
  const raw = resolveSqliteDriver().open(file,{readonly:true});
  // VACUUM INTO takes a coherent SQLite snapshot, including committed WAL
  // pages, without copying or modifying the source database files.
  return { raw, backup:target => raw.prepare('VACUUM INTO ?').run(target),
    all:(sql,params=[]) => raw.prepare(sql).all(...params), run:() => { throw fail('bundle_read_only'); } };
};
const ignored = relative => relative === 'orchestration/owner.lock' || relative === 'harness/provider-recovery/runtime-owner.lock'
  || /^harness\/session-mutations\/[a-f0-9]{64}\/context-cache(\/|$)/.test(relative)
  || /^harness\/session-mutations\/[a-f0-9]{64}\/(owner\.lock|git\/index[^/]*)$/.test(relative)
  || /^harness\/(provider-recovery|context)\/[^/]+\.lock$/.test(relative)
  || /(^|\/)[^/]+\.tmp-[^/]+$/.test(relative);
const copyTree = async (source,target,{ignore=false,relative=''}={}) => {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) throw fail('bundle_symlink_source');
  if(await fs.realpath(source)!==source)throw fail('bundle_symlink_source');
  if (ignore && ignored(relative)) return;
  if (stat.isDirectory()) {
    await fs.mkdir(target,{recursive:true,mode:0o700});
    for (const name of (await fs.readdir(source)).sort()) await copyTree(path.join(source,name),path.join(target,name),{ignore,relative:relative ? relative+'/'+name:name});
  } else if (stat.isFile()) { await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700}); await fs.copyFile(source,target); await fs.chmod(target,stat.mode & 0o777); }
  else throw fail('bundle_special_file_source');
};
// These are the existing user data sources in skills.js. Copying HOME itself
// would import unrelated credentials and application state into the runtime.
const homeSkillRoots = [['.agents','skills'],['.opencode','skill'],['.opencode','skills'],
  ['.config','meridian','settings.json'],['.claude','.credentials.json']];
const copyHomeSkills = async (sourceHome,targetHome) => {
  const homeStat=await fs.lstat(sourceHome);
  if (homeStat.isSymbolicLink() || !homeStat.isDirectory() || await fs.realpath(sourceHome)!==sourceHome) throw fail('bundle_symlink_source');
  for (const segments of homeSkillRoots) {
    let source=sourceHome, absent=false;
    for (const segment of segments) {
      source=path.join(source,segment);
      let stat; try { stat=await fs.lstat(source); } catch (error) { if (error.code==='ENOENT') { absent=true; break; } throw error; }
      if (stat.isSymbolicLink() || await fs.realpath(source)!==source) throw fail('bundle_symlink_source');
      if (!stat.isDirectory() && !(segment===segments.at(-1) && stat.isFile())) throw fail('bundle_special_file_source');
    }
    if (absent) continue;
    const target=path.join(targetHome,...segments);
    if (containsPath(source,target) || containsPath(target,source)) throw fail('bundle_source_overlap');
    await copyTree(source,target);
  }
  const profileFile=path.join(sourceHome,'.config','meridian','profiles.json');
  let stat;try{stat=await fs.lstat(profileFile);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(stat){
    if(stat.isSymbolicLink()||!stat.isFile()||stat.size>1024*1024||await fs.realpath(profileFile)!==profileFile)throw fail('bundle_symlink_source');
    let profiles;try{profiles=JSON.parse(await fs.readFile(profileFile,'utf8'));}catch{throw fail('native_setup_profiles_invalid');}
    const relocated=await relocateNativeSetupProfiles({profiles,sourceHome,targetHome,copyAccount:async(source,target)=>{
      if(!containsPath(sourceHome,source))throw fail('bundle_symlink_source');
      await fs.mkdir(target,{recursive:true,mode:0o700});
      const file=path.join(source,'.credentials.json');let accountStat;
      try{accountStat=await fs.lstat(file);}catch(error){if(error.code==='ENOENT')return;throw error;}
      if(accountStat.size>1024*1024||await fs.realpath(source)!==source)throw fail('bundle_symlink_source');
      await copyTree(file,path.join(target,'.credentials.json'));
    }});
    const target=path.join(targetHome,'.config','meridian','profiles.json');await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});
    await fs.writeFile(target,JSON.stringify(relocated)+'\n',{mode:0o600});
  }
};
const treeManifest = async root => {
  const rows = [];
  const walk = async (directory,relative='') => {
    for (const entry of (await fs.readdir(directory,{withFileTypes:true})).sort((a,b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory,entry.name), name = relative ? relative+'/'+entry.name:entry.name;
      if (entry.isDirectory()) await walk(file,name);
      else if (entry.isFile()) rows.push({path:name,sha256:await fileHash(file)});
      else throw fail('bundle_special_file_source');
    }
  };
  await walk(root); return rows;
};
// SQLite's wal-index (*.db-shm) is rebuildable shared memory that every connection,
// including verify's read-only one, rewrites (read marks), so it is never snapshot
// content. *.db-wal stays covered: it holds committed pages, and a read-only
// connection never appends to, checkpoints or truncates it.
const durable = rows => rows.filter(row => !(isRecord(row) && typeof row.path === 'string' && row.path.endsWith('.db-shm')));
const verifyTree = async (root,rows) => {
  if (!Array.isArray(rows)) throw fail('bundle_manifest_invalid');
  for (const row of rows) if (!isRecord(row) || typeof row.path !== 'string' || row.path.split('/').some(part => !part || part === '..')
    || !validHash(row.sha256) || await fileHash(path.join(root,row.path)) !== row.sha256) throw fail('bundle_snapshot_changed');
};
const reviewedDocuments = async (value,maps) => {
  const configuration=await readBundleJSON(value.reviewedNativeConfigPath), plugins=await readBundleJSON(value.reviewedPluginManifestPath);
  const strings = rows => Array.isArray(rows) && rows.every(row => typeof row==='string' && row.length>0);
  if (!isRecord(configuration) || configuration.schema!==1 || !isRecord(configuration.configuration)
    || !isRecord(configuration.catalogRequirements) || !Array.isArray(configuration.locations) || !configuration.locations.length) throw fail('bundle_reviewed_config_invalid');
  const catalog=configuration.catalogRequirements;
  if (!['agents','plugins','tools'].every(key => strings(catalog[key])) || !Array.isArray(catalog.models)
    || catalog.models.some(row => !isRecord(row) || typeof row.providerID!=='string' || !row.providerID || typeof row.id!=='string' || !row.id)) throw fail('bundle_reviewed_config_invalid');
  for (const location of configuration.locations) {
    if (!isRecord(location) || !strings(location.readRoots) || !strings(location.protectedRoots)) throw fail('bundle_reviewed_config_invalid');
    absolute(location.directory); for (const root of [...location.readRoots,...location.protectedRoots]) absolute(root);
    if (maps && (!maps.some(map=>location.directory===map.targetDirectory)
      || location.readRoots.some(root=>maps.some(map=>map.mode==='synthetic-copy'
        && (containsPath(map.sourceDirectory,root) || containsPath(root,map.sourceDirectory)))))) throw fail('bundle_reviewed_source_access');
  }
  if (!isRecord(plugins) || plugins.schema!==1 || !Array.isArray(plugins.plugins)
    || plugins.plugins.some(row => !isRecord(row) || typeof row.id!=='string' || !row.id || !validHash(row.manifestDigest)
      || !Array.isArray(row.capabilities) || row.capabilities.some(item => !['read','write','process','network','managed-task','control','provider'].includes(item)))) throw fail('bundle_reviewed_plugins_invalid');
};
const checkpoint = (source,generation,value) => {
  if (!isRecord(value) || !validID(value.checkpointID) || !validID(value.ownerID) || value.generation !== generation
    || !Number.isFinite(value.settledAt) || value.settledAt <= 0) throw fail('bundle_quiescence_unverified');
  for (const [field,key] of [['databasePath','opencodeDatabasePath'],['webDataDirectory','webDataDirectory'],
    ['webConfigDirectory','webConfigDirectory'],['opencodeConfigDirectory','opencodeConfigDirectory']]) {
    if (value[field] !== source[key]) throw fail('bundle_quiescence_scope_mismatch');
  }
  return value;
};
const verifyRuntimeBundleArtifacts = async ({generation,launch:value}) => {
  const directory=path.dirname(absolute(value.artifactManifestPath));
  if (generation!==2) throw fail('bundle_artifact_generation_mismatch');
  const verified=await verifyNativeRuntimeArtifacts({manifestPath:value.artifactManifestPath,
    manifestSha256:value.artifactManifestSha256,launcher:executionArtifacts(directory).launcher});
  if (verified.controller!==value.controllerBinary || verified.writer!==value.writerBinary) throw fail('bundle_artifact_generation_mismatch');
  return verified;
};
const selection = value => {
  if (!isRecord(value) || value.schema !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !validID(value.selectedBundleID) || !(value.previousBundleID === null || validID(value.previousBundleID))
    || !['activate','rollback'].includes(value.transition) || typeof value.reconciliationRequired !== 'boolean'
    || !validHash(value.preparedManifestSha256)) throw fail('bundle_selection_invalid');
  return value;
};

/** Offline copied bundles and one atomic selector. Admission remains host-owned. */
export function createRuntimeBundleStore(options) {
  const controlRoot = absolute(options.controlRoot), now = options.now ?? Date.now;
  if (typeof options.withQuiescedSource !== 'function' || typeof options.runMigration !== 'function') throw new TypeError('owned bundle callbacks required');
  // Only the constructing host may replace verification for deterministic fixtures.
  // Bundle input, selected descriptors and RPC metadata never choose this policy.
  const verifyArtifacts=options.verifyArtifacts ?? verifyRuntimeBundleArtifacts;
  if (typeof verifyArtifacts!=='function') throw new TypeError('owned artifact verifier required');
  const readSelected = async () => {
    let current;
    try { current = selection(await readBundleJSON(path.join(controlRoot,'selection.json'))); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const value=await readRuntimeBundleDescriptor(controlRoot,current.selectedBundleID);
    if (await fileHash(value.preparedManifestPath)!==current.preparedManifestSha256) throw fail('bundle_selected_evidence_changed');
    return {selection:current,descriptor:value};
  };
  const verify = async ({bundleID,phase,allowOwnedContinuations=true}) => {
    if (!['prepared','resume'].includes(phase)) throw fail('bundle_verification_phase_invalid');
    const value = await readRuntimeBundleDescriptor(controlRoot,bundleID), root = path.join(controlRoot,'bundles',bundleID);
    const manifest = await readBundleJSON(value.preparedManifestPath);
    if (!isRecord(manifest) || manifest.schema !== 1 || manifest.bundleID !== bundleID || manifest.checkpointID !== value.checkpoint.checkpointID
      || manifest.descriptorSha256 !== await fileHash(path.join(root,'descriptor.json'))) throw fail('bundle_manifest_invalid');
    if (!Array.isArray(manifest.initialFiles) || !Array.isArray(manifest.immutableFiles)
      || new Set(manifest.initialFiles.map(row=>row.path)).size!==manifest.initialFiles.length
      || canonicalJSON(manifest.immutableFiles)!==canonicalJSON(manifest.initialFiles.filter(row=>/^(descriptor\.json|sources\/|config\/reviewed-)/.test(row.path)))) throw fail('bundle_manifest_invalid');
    const required=['descriptor.json','sources/baseline.json','sources/preparation.json','config/reviewed-native.json','config/reviewed-plugins.json',
      ...(value.sourceBundleID?['sources/clone.json']:[]),
      ...(value.generation===2 ? ['sources/migration.json','sources/migration.json.source.json','sources/migration.json.verification.json']:[])];
    if (required.some(file=>!manifest.immutableFiles.some(row=>row.path===file))) throw fail('bundle_manifest_invalid');
    await verifyTree(root,manifest.immutableFiles);
    await reviewedDocuments(value.launch,value.generation===2?value.projectMap:undefined);
    const expectedArtifacts=[value.launch.controllerBinary,value.launch.writerBinary,value.launch.artifactManifestPath].filter(Boolean).sort();
    if (!Array.isArray(manifest.artifactFiles) || canonicalJSON(manifest.artifactFiles.map(row=>row.path).sort())!==canonicalJSON(expectedArtifacts)
      || manifest.artifactFiles.find(row=>row.path===value.launch.artifactManifestPath)?.sha256!==value.launch.artifactManifestSha256) throw fail('bundle_manifest_invalid');
    for (const row of manifest.artifactFiles) if (!isRecord(row) || !validHash(row.sha256) || await fileHash(absolute(row.path))!==row.sha256) throw fail('bundle_artifact_changed');
    await verifyArtifacts({generation:value.generation,launch:value.launch});
    if (phase === 'prepared') {
      const initial=durable(manifest.initialFiles);
      await verifyTree(root,initial);
      const actual=durable(await treeManifest(root)).filter(row=>row.path!=='prepared.json');
      if (JSON.stringify(actual)!==JSON.stringify(initial)) throw fail('bundle_snapshot_changed');
    }
    const db = sqlite(value.launch.opencodeDatabasePath);
    try {
      const baseline=await readBundleJSON(path.join(root,'sources','baseline.json'));
      if (!isRecord(baseline) || !isRecord(baseline.harness) || !Array.isArray(baseline.harness.refs)) throw fail('bundle_manifest_invalid');
      const preservedRefs={checkpointID:value.checkpoint.checkpointID,refs:baseline.harness.refs};
      if (value.generation === 2) {
        const receipt = parseNativeMigrationReceipt(await readBundleJSON(value.migrationReceiptPath));
        let origin={bundleID,databasePath:value.launch.opencodeDatabasePath};
        if(value.sourceBundleID){
          const clone=await readBundleJSON(path.join(root,'sources','clone.json'));
          if(!isRecord(clone)||clone.schema!==1||clone.sourceBundleID!==value.sourceBundleID||!validHash(clone.sourceDescriptorSha256)
            ||!validHash(clone.sourcePreparedManifestSha256)||!validHash(clone.sourceCredentialSha256)||!isRecord(clone.migrationOrigin)||!validID(clone.migrationOrigin.bundleID))throw fail('bundle_clone_evidence_invalid');
          origin=clone.migrationOrigin;
        }
        if (receipt.bundleID !== origin.bundleID || receipt.databasePath !== origin.databasePath
          || receipt.sourceInventorySha256 !== await fileHash(value.migrationReceiptPath+'.source.json')
          || receipt.verificationSha256 !== await fileHash(value.migrationReceiptPath+'.verification.json')) throw fail('bundle_migration_evidence_invalid');
        const source = await readBundleJSON(value.migrationReceiptPath+'.source.json');
        if (!isRecord(source) || !isRecord(source.inventory)) throw fail('bundle_migration_evidence_invalid');
        const selected=phase==='resume' && allowOwnedContinuations ? await readSelected() : null;
        let verifiedContinuations;
        if(selected?.descriptor.bundleID===bundleID&&!selected.selection.reconciliationRequired&&selected.selection.transition==='activate'){
          if(options.allowRecoveredInputStartup===true)verifiedContinuations=await verifyBundleRecoveredInputs(db,value.launch.webDataDirectory);
          else {
            const cancelled=(await verifyBundleRecoveredInputs(db,value.launch.webDataDirectory)).filter(proof=>proof.cancellation);
            const owned=await verifyBundleOwnedContinuations(db,value.launch.webDataDirectory,{cancelledContinuations:cancelled});
            verifiedContinuations=[...owned.filter(proof=>!cancelled.some(item=>item.id===proof.id)),...cancelled];
          }
        }else verifiedContinuations=await verifyBundleRecoveredInputs(db,value.launch.webDataDirectory,{cancelledOnly:true});
        if(value.sourceBundleID&&phase==='prepared')assertNoPendingMigration(db);
        const graph = verifyMigrationReferences(db,source.inventory,{phase:value.sourceBundleID?'resume':phase,projectMap:value.projectMap,verifiedContinuations,migrationReceiptMarker:receipt.marker});
        await inspectBundleHarness(value.launch.webDataDirectory,{projectMap:value.projectMap,preservedRefs,
          sessionIDs:graph.sessionIDs,messageIDs:graph.nativeMessageIDs,verifiedContinuations});
        if (phase==='resume') assertBundlePendingInput(db,verifiedContinuations);
      }
    } finally { db.raw.close(); }
    return {descriptor:value,phase,integrity:'verified',admission:'held'};
  };
  const finishPreparation=async(value,artifacts,request)=>{
    const root=path.join(controlRoot,'bundles',value.bundleID);
    if (request) {
      const result=parseNativeMigrationReceipt(await options.runMigration(request));
      if (result.bundleID!==value.bundleID || result.databasePath!==value.launch.opencodeDatabasePath) throw fail('bundle_migration_evidence_invalid');
    }
    descriptor(controlRoot,value.bundleID,value);
    await saveBundleJSON(path.join(root,'descriptor.json'),value);
    const files=durable(await treeManifest(root));
    await saveBundleJSON(value.preparedManifestPath,{schema:1,bundleID:value.bundleID,checkpointID:value.checkpoint.checkpointID,
      descriptorSha256:await fileHash(path.join(root,'descriptor.json')),
      artifactFiles:await Promise.all([artifacts.controllerBinary,artifacts.writerBinary,artifacts.artifactManifestPath].filter(Boolean).map(async file=>({path:absolute(file),sha256:await fileHash(file)}))),
      immutableFiles:files.filter(row=>/^(descriptor\.json|sources\/|config\/reviewed-)/.test(row.path)),initialFiles:files});
    await verify({bundleID:value.bundleID,phase:'prepared'}); return value;
  };
  const prepareV2=async input=>{
    if(!validID(input.source.bundleID)||input.source.bundleID===input.bundleID)throw fail('bundle_clone_source_invalid');
    const current=await readSelected();
    if(current&&rollbackIntentUnresolved(readRollbackIntentSync(controlRoot),current.selection))throw fail('bundle_recovery_resume_required');
    if(current?.selection.reconciliationRequired||current?.descriptor.bundleID!==input.source.bundleID)throw fail('bundle_clone_source_not_selected');
    const source=current.descriptor,artifacts=input.launchArtifacts;
    if(canonicalJSON(input.projectMap)!==canonicalJSON(source.projectMap)||input.auxiliary?.kind!=='absent')throw fail('bundle_clone_mapping_changed');
    const compatibility={protocol:'devryan-v2-clone/1',sourceBundleID:source.bundleID,
      sourceManifestSha256:source.launch.artifactManifestSha256,targetManifestSha256:artifacts.artifactManifestSha256};
    if(source.launch.artifactManifestSha256!==artifacts.artifactManifestSha256){
      const proof=await options.verifyV2Compatibility?.({source,artifacts});
      if(!isRecord(proof)||proof.status!=='compatible'||canonicalJSON(proof.binding)!==canonicalJSON(compatibility))throw fail('bundle_v2_upgrade_compatibility_required');
    }
    const root=path.join(controlRoot,'bundles',input.bundleID),inputSha256=sha256(canonicalJSON(input));
    return options.withQuiescedSource(input.source,async (stamp,scope)=>{
      const sourceCheckpoint=checkpoint(source.launch,2,stamp);
      await verify({bundleID:source.bundleID,phase:'resume',allowOwnedContinuations:false});
      if(typeof scope?.assertHeld!=='function')throw fail('bundle_credential_checkpoint_required');
      await scope.assertHeld();
      const credentials=await options.captureCredentials?.({descriptor:source,checkpoint:sourceCheckpoint,assertHeld:scope.assertHeld});
      if(!isRecord(credentials)||credentials.protocol!==NATIVE_BUNDLE_CREDENTIAL_CONTRACT||credentials.status!=='captured'
        ||!validHash(credentials.sha256)||sha256(canonicalJSON(credentials.snapshot))!==credentials.sha256)throw fail('bundle_credential_checkpoint_required');
      const hostOwnerBaseline=await captureBundleCredentialOwners({descriptor:source,assertHeld:scope.assertHeld,controlRoot,claudeLifecycle:credentials.snapshot.claudeLifecycle});
      let prior;
      try{prior=await readBundleJSON(path.join(root,'sources','preparation.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
      if(prior){
        if(prior.inputSha256!==inputSha256||prior.sourceBundleID!==source.bundleID)throw fail('bundle_preparation_identity_conflict');
        try{return (await verify({bundleID:input.bundleID,phase:'prepared'})).descriptor;}catch(error){if(error.code!=='ENOENT')throw error;}
        await verifyTree(root,prior.copiedFiles);return finishPreparation(prior.descriptor,artifacts);
      }
      await fs.mkdir(path.dirname(root),{recursive:true,mode:0o700});
      try{await fs.mkdir(root,{mode:0o700});}catch(error){if(error.code==='EEXIST')throw fail('bundle_candidate_exists');throw error;}
      const globals=Object.fromEntries(Object.keys(source.launch.global).map(key=>[key,key==='config'?path.join(root,'config','opencode'):path.join(root,'global',key)]));
      const db=sqlite(source.launch.opencodeDatabasePath);let harness;
      try{
        const sessionIDs=db.all('SELECT id FROM session_v2').map(row=>row.id),messageIDs=db.all('SELECT id FROM session_message').map(row=>row.id);
        harness=await inspectBundleHarness(source.launch.webDataDirectory,{sessionIDs,messageIDs});
        await fs.mkdir(path.join(root,'opencode'),{mode:0o700});db.backup(path.join(root,'opencode','opencode.db'));
      }finally{db.raw.close();}
      await copyTree(source.launch.webDataDirectory,path.join(root,'web-data'),{ignore:true});
      await copyTree(source.launch.webConfigDirectory,path.join(root,'config','openchamber'));
      await copyTree(source.launch.opencodeConfigDirectory,globals.config);
      for(const [key,directory] of Object.entries(source.launch.global))if(key!=='config')await copyTree(directory,globals[key],{ignore:true});
      // Relocate only the existing typed account profile paths, never arbitrary JSON strings.
      const profiles=path.join(source.launch.global.home,'.config','meridian','profiles.json');
      try{
        const rows=await readBundleJSON(profiles);
        const relocated=await relocateNativeSetupProfiles({profiles:rows,sourceHome:source.launch.global.home,targetHome:globals.home,controlRoot,claudeLifecycle:credentials.snapshot.claudeLifecycle,
          copyAccount:async(account,destination)=>{if(!containsPath(source.launch.global.home,account))throw fail('bundle_symlink_source');await copyTree(account,destination);}});
        await saveBundleJSON(path.join(globals.home,'.config','meridian','profiles.json'),relocated);
      }catch(error){if(error.code!=='ENOENT')throw error;}
      await fs.mkdir(path.join(root,'sources'),{mode:0o700});
      for(const suffix of ['','.source.json','.verification.json'])await copyTree(source.migrationReceiptPath+suffix,path.join(root,'sources','migration.json')+suffix);
      const migrationOrigin=parseNativeMigrationReceipt(await readBundleJSON(source.migrationReceiptPath));
      await saveBundleJSON(path.join(root,'sources','baseline.json'),{schema:1,checkpoint:sourceCheckpoint,harness});
      await saveBundleJSON(path.join(root,'sources','clone.json'),{schema:1,sourceBundleID:source.bundleID,compatibility,
        sourceCredentialSha256:credentials.sha256,sourceHostOwners:hostOwnerBaseline,
        sourceDescriptorSha256:await fileHash(path.join(controlRoot,'bundles',source.bundleID,'descriptor.json')),
        sourcePreparedManifestSha256:await fileHash(source.preparedManifestPath),migrationOrigin:{bundleID:migrationOrigin.bundleID,databasePath:migrationOrigin.databasePath}});
      await reviewedDocuments(artifacts,input.projectMap);
      await copyTree(artifacts.reviewedNativeConfigPath,path.join(root,'config','reviewed-native.json'));
      await copyTree(artifacts.reviewedPluginManifestPath,path.join(root,'config','reviewed-plugins.json'));
      const value={schema:1,bundleID:input.bundleID,generation:2,sourceBundleID:source.bundleID,createdAt:now(),checkpoint:sourceCheckpoint,
        launch:{...artifacts,opencodeDatabasePath:path.join(root,'opencode','opencode.db'),webDataDirectory:path.join(root,'web-data'),
          webConfigDirectory:path.join(root,'config','openchamber'),opencodeConfigDirectory:globals.config,global:globals,
          reviewedNativeConfigPath:path.join(root,'config','reviewed-native.json'),reviewedPluginManifestPath:path.join(root,'config','reviewed-plugins.json')},
        projectMap:source.projectMap,preparedManifestPath:path.join(root,'prepared.json'),migrationReceiptPath:path.join(root,'sources','migration.json')};
      await inspectBundleHarness(value.launch.webDataDirectory,{projectMap:value.projectMap,relocate:true,sourceWebDataDirectory:source.launch.webDataDirectory,checkpointID:sourceCheckpoint.checkpointID});
      await saveBundleJSON(path.join(root,'sources','preparation.json'),{schema:1,inputSha256,sourceBundleID:source.bundleID,descriptor:value,copiedFiles:await treeManifest(root)});
      return finishPreparation(value,artifacts);
    });
  };
  const prepare = async input => {
    if (!validID(input.bundleID) || input.generation !== 2 || !isRecord(input.source) || !Array.isArray(input.projectMap) || !input.projectMap.length) throw fail('bundle_prepare_invalid');
    const artifacts=input.launchArtifacts;
    if (!isRecord(artifacts) || !validHash(artifacts.artifactManifestSha256)
      || await fileHash(absolute(artifacts.artifactManifestPath))!==artifacts.artifactManifestSha256) throw fail('bundle_artifact_manifest_changed');
    const verifiedArtifacts=await verifyArtifacts({generation:input.generation,launch:artifacts});
    if(input.source.kind==='bundle'){
      const contracts=verifiedArtifacts?.manifest?.compiledContracts;
      if(!Array.isArray(contracts)||!contracts.includes(BUNDLE_CREDENTIAL_OWNER_PROTOCOL))throw fail('bundle_credential_owner_unsupported');
      if(!contracts.includes(NATIVE_BUNDLE_CREDENTIAL_CONTRACT))throw fail('bundle_credential_contract_incompatible');
      return prepareV2(input);
    }
    if(input.source.kind!=='legacy') throw fail('bundle_migration_generation_invalid');
    const sourceLaunch=legacySource(input.source.launch),sourceGeneration=1;
    const root = path.join(controlRoot,'bundles',input.bundleID);
    if (containsPath(sourceLaunch.webDataDirectory,controlRoot) || containsPath(controlRoot,sourceLaunch.webDataDirectory)) throw fail('bundle_source_overlap');
    await fs.mkdir(path.dirname(root),{recursive:true,mode:0o700});
    try { await fs.mkdir(root,{mode:0o700}); }
    catch (error) {
      if (error.code!=='EEXIST') throw error;
      let draft;
      try { draft=await readBundleJSON(path.join(root,'sources','preparation.json')); }
      catch (cause) { if (cause.code==='ENOENT') throw fail('bundle_candidate_exists'); throw cause; }
      if (!isRecord(draft) || draft.schema!==1 || draft.inputSha256!==sha256(canonicalJSON(input))) throw fail('bundle_preparation_identity_conflict');
      const selected=await readSelected();
      if (selected?.descriptor.bundleID===input.bundleID) throw fail('bundle_candidate_selected');
      descriptor(controlRoot,input.bundleID,draft.descriptor);
      await verifyTree(root,draft.copiedFiles);
      let sealed=false;
      try { await fs.lstat(draft.descriptor.preparedManifestPath); sealed=true; }
      catch (cause) { if (cause.code!=='ENOENT') throw cause; }
      if (sealed) return (await verify({bundleID:input.bundleID,phase:'prepared'})).descriptor;
      return options.withQuiescedSource(input.source,async proof=>{
        checkpoint(sourceLaunch,sourceGeneration,proof);
        return finishPreparation(draft.descriptor,input.launchArtifacts,draft.request);
      });
    }
    return options.withQuiescedSource(input.source,async proof => {
      const sourceCheckpoint = checkpoint(sourceLaunch,sourceGeneration,proof);
      const sourceDB = sqlite(sourceLaunch.opencodeDatabasePath);
      let inventory,harness;
      try {
        inventory = captureMigrationInventory(sourceDB);
        harness=await inspectBundleHarness(sourceLaunch.webDataDirectory,{sessionIDs:inventory.sessions.map(row => row.id),messageIDs:inventory.messages.map(row => row.id)});
        await fs.mkdir(path.join(root,'opencode'),{recursive:true,mode:0o700});
        sourceDB.backup(path.join(root,'opencode','opencode.db'));
      } finally { sourceDB.raw.close(); }
      await copyTree(sourceLaunch.webDataDirectory,path.join(root,'web-data'),{ignore:true});
      await copyTree(sourceLaunch.webConfigDirectory,path.join(root,'config','openchamber'));
      await copyTree(sourceLaunch.opencodeConfigDirectory,path.join(root,'config','opencode'));
      await fs.mkdir(path.join(root,'sources'),{recursive:true,mode:0o700});
      await saveBundleJSON(path.join(root,'sources','baseline.json'),{schema:1,checkpoint:sourceCheckpoint,inventory,harness});
      await reviewedDocuments(artifacts,input.generation===2?input.projectMap:undefined);
      await fs.copyFile(absolute(artifacts.reviewedNativeConfigPath),path.join(root,'config','reviewed-native.json'));
      await fs.copyFile(absolute(artifacts.reviewedPluginManifestPath),path.join(root,'config','reviewed-plugins.json'));
      const globals = Object.fromEntries(['home','data','state','cache','tmp','bin','log','repos'].map(key =>
        [key,path.join(root,'global',key,)]));
      globals.config=path.join(root,'config','opencode');
      for (const directory of Object.values(globals)) await fs.mkdir(directory,{recursive:true,mode:0o700});
      await copyHomeSkills(sourceLaunch.global.home,globals.home);
      const value = {schema:1,bundleID:input.bundleID,generation:input.generation,createdAt:now(),
        checkpoint:sourceCheckpoint,
        launch:{...artifacts,opencodeDatabasePath:path.join(root,'opencode','opencode.db'),
          webDataDirectory:path.join(root,'web-data'),webConfigDirectory:path.join(root,'config','openchamber'),opencodeConfigDirectory:globals.config,global:globals,
          reviewedNativeConfigPath:path.join(root,'config','reviewed-native.json'),reviewedPluginManifestPath:path.join(root,'config','reviewed-plugins.json')},
        projectMap:input.projectMap,preparedManifestPath:path.join(root,'prepared.json')};
      await inspectBundleHarness(value.launch.webDataDirectory,{projectMap:input.generation===2 ? input.projectMap:
        input.projectMap.map(row=>({...row,targetDirectory:row.sourceDirectory,mode:'identity'})),
        sourceWebDataDirectory:sourceLaunch.webDataDirectory,relocate:true,checkpointID:sourceCheckpoint.checkpointID});
      let request;
      if (input.generation === 2) {
        let auxiliary = input.auxiliary;
        if (!isRecord(auxiliary) || !['absent','copy'].includes(auxiliary.kind)) throw fail('bundle_auxiliary_invalid');
        if (auxiliary.kind === 'copy') {
          const source = sqlite(absolute(auxiliary.databasePath));
          try { assertNoPendingMigration(source); source.backup(path.join(root,'sources','opencode-next.db')); }
          finally { source.raw.close(); }
          if (await fileHash(auxiliary.databasePath) !== auxiliary.sha256) throw fail('bundle_auxiliary_changed');
          auxiliary={kind:'copy',databasePath:path.join(root,'sources','opencode-next.db'),sha256:await fileHash(path.join(root,'sources','opencode-next.db'))};
        }
        value.migrationReceiptPath=path.join(root,'sources','migration.json');
        request={protocol:'devryan-native-migration/1',requestID:`import_${input.bundleID}`,bundleID:input.bundleID,
          candidateDatabasePath:value.launch.opencodeDatabasePath,isolatedRoot:path.join(root,'global'),receiptPath:value.migrationReceiptPath,auxiliary,projectMap:input.projectMap};
      }
      descriptor(controlRoot,input.bundleID,value);
      const copiedFiles=(await treeManifest(root)).filter(row=>!/^opencode\//.test(row.path));
      await saveBundleJSON(path.join(root,'sources','preparation.json'),{schema:1,inputSha256:sha256(canonicalJSON(input)),descriptor:value,request:request??null,copiedFiles});
      return finishPreparation(value,artifacts,request);
    });
  };
  const switchSelection = async ({bundleID,expectedRevision},transition,reconciliationRequired,previousBundleID,credentialBaseline) => withCrossProcessFileLock(path.join(controlRoot,'selection.lock'),async () => {
    const current = await readSelected(), revision=current?.selection.revision ?? 0;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== revision) throw fail('bundle_selection_revision_conflict');
    const verified=await verify({bundleID,phase:'resume',allowOwnedContinuations:false});
    const next={schema:1,revision:revision+1,selectedBundleID:bundleID,previousBundleID:previousBundleID ?? current?.selection.selectedBundleID ?? null,
      transition,reconciliationRequired,preparedManifestSha256:await fileHash(verified.descriptor.preparedManifestPath)};
    if(credentialBaseline)await saveBundleJSON(path.join(controlRoot,'rollback',bundleID+'.json'),credentialBaseline);
    await saveBundleJSON(path.join(controlRoot,'selection.json'),next); return next;
  });
  const select = async input => {
    const current=await readSelected(), source={kind:'bundle',bundleID:current?.descriptor.bundleID ?? input.bundleID};
    const value=current?.descriptor ?? await readRuntimeBundleDescriptor(controlRoot,input.bundleID);
    if(current&&rollbackIntentUnresolved(readRollbackIntentSync(controlRoot),current.selection))throw fail('bundle_recovery_resume_required');
    if (current?.selection.reconciliationRequired) throw fail('bundle_rollback_reconciliation_required');
    return options.withQuiescedSource(source,async (proof,scope) => {
      checkpoint(value.launch,value.generation,proof);
      let baseline;
      if(current&&current.descriptor.bundleID!==input.bundleID){
        if(typeof scope?.assertHeld!=='function')throw fail('bundle_credential_checkpoint_required');
        await scope.assertHeld();
        const captured=await options.captureCredentials?.({descriptor:current.descriptor,checkpoint:proof,assertHeld:scope.assertHeld});
        if(!isRecord(captured)||captured.protocol!==NATIVE_BUNDLE_CREDENTIAL_CONTRACT||captured.status!=='captured'
          ||!validHash(captured.sha256)||sha256(canonicalJSON(captured.snapshot))!==captured.sha256)throw fail('bundle_credential_checkpoint_required');
        const candidate=await readRuntimeBundleDescriptor(controlRoot,input.bundleID);
        let hostOwnerBaseline=await captureBundleCredentialOwners({descriptor:current.descriptor,assertHeld:scope.assertHeld,controlRoot,claudeLifecycle:captured.snapshot.claudeLifecycle});
        if(candidate.sourceBundleID===current.descriptor.bundleID){
          const clone=await readBundleJSON(path.join(controlRoot,'bundles',input.bundleID,'sources','clone.json'));
          if(clone.sourceCredentialSha256!==captured.sha256)throw fail('bundle_clone_credentials_changed');
          hostOwnerBaseline=clone.sourceHostOwners;
          await assertBundleCredentialOwners({candidate,target:current.descriptor,baseline:hostOwnerBaseline,assertHeld:scope.assertHeld,controlRoot,claudeLifecycle:captured.snapshot.claudeLifecycle});
        }
        baseline={schema:1,candidateBundleID:input.bundleID,targetBundleID:current.descriptor.bundleID,
          targetManifestSha256:current.descriptor.launch.artifactManifestSha256,expectedTargetSha256:captured.sha256,
          targetDescriptorSha256:await fileHash(path.join(controlRoot,'bundles',current.descriptor.bundleID,'descriptor.json')),hostOwnerBaseline};
      }
      await scope?.assertHeld?.();
      return switchSelection(input,'activate',false,undefined,baseline);
    });
  };
  const recoveryFiles = value => captureRollbackFiles(path.join(controlRoot,'bundles',value.bundleID));
  const resume = async input => {
    if(!isRecord(input)||Object.keys(input).length!==1||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1)throw fail('bundle_selection_revision_conflict');
    const {expectedRevision}=input;
    await assertPrivateBundleControlRoot(controlRoot);
    return withCrossProcessFileLock(path.join(controlRoot,'selection.lock'),async()=>{
    await assertPrivateBundleControlRoot(controlRoot);
    const current=await readSelected(),intent=readRollbackIntentSync(controlRoot);
    if(!current||!intent||!rollbackIntentUnresolved(intent,current.selection))throw fail('bundle_recovery_proof_required');
    if(!Number.isSafeInteger(expectedRevision)||current.selection.revision!==expectedRevision)throw fail('bundle_selection_revision_conflict');
    const candidate=await readRuntimeBundleDescriptor(controlRoot,intent.candidateBundleID);
    checkpoint(candidate.launch,2,intent.checkpoint);
    if(!(current.selection.selectedBundleID===intent.candidateBundleID&&expectedRevision===intent.revision
      ||current.selection.selectedBundleID===intent.targetBundleID&&expectedRevision===intent.revision+1&&current.selection.reconciliationRequired))throw fail('bundle_recovery_selection_changed');
    const assertHeld=async()=>{
      if(canonicalJSON(readRollbackIntentSync(controlRoot))!==canonicalJSON(intent))throw fail('bundle_recovery_proof_changed');
      await assertRollbackPhysicalExit(intent,candidate,options.readProcessIdentity);
      const selected=await readSelected();if(canonicalJSON(selected?.selection)!==canonicalJSON(current.selection))throw fail('bundle_selection_revision_conflict');
    };
    await assertHeld();
    await verify({bundleID:candidate.bundleID,phase:'resume',allowOwnedContinuations:false});
    if(intent.candidateDescriptorSha256!==await fileHash(path.join(controlRoot,'bundles',candidate.bundleID,'descriptor.json'))
      ||intent.candidatePreparedSha256!==await fileHash(candidate.preparedManifestPath)
      ||intent.candidateManifestSha256!==candidate.launch.artifactManifestSha256
      ||canonicalJSON(intent.files)!==canonicalJSON(await recoveryFiles(candidate)))throw fail('bundle_recovery_candidate_changed');
    const captured=await options.captureCredentials?.({descriptor:candidate,checkpoint:intent.checkpoint,assertHeld});
    if(captured?.protocol!==NATIVE_BUNDLE_CREDENTIAL_CONTRACT||captured.status!=='captured'||captured.sha256!==intent.nativeCredentialSha256
      ||sha256(canonicalJSON(captured.snapshot))!==captured.sha256)throw fail('bundle_recovery_candidate_changed');
    const owners=await captureBundleCredentialOwners({descriptor:candidate,assertHeld,controlRoot,claudeLifecycle:captured.snapshot.claudeLifecycle});
    if(canonicalJSON(owners)!==canonicalJSON(intent.hostOwners))throw fail('bundle_recovery_candidate_changed');
    await assertHeld();
    if(canonicalJSON(intent.files)!==canonicalJSON(await recoveryFiles(candidate)))throw fail('bundle_recovery_candidate_changed');
    await assertHeld();
    const next={schema:1,revision:expectedRevision+1,selectedBundleID:candidate.bundleID,previousBundleID:intent.targetBundleID,
      transition:'activate',reconciliationRequired:false,preparedManifestSha256:intent.candidatePreparedSha256};
    await saveRollbackIntent(controlRoot,{...intent,state:'resuming',resumeRevision:next.revision});
    await saveBundleJSON(path.join(controlRoot,'selection.json'),next);
    await saveRollbackIntent(controlRoot,{...intent,state:'resumed',resumeRevision:next.revision});
    return next;
  });
  };
  const rollback = async ({targetBundleID,expectedRevision}) => {
    const current=await readSelected();
    if (!current) throw fail('bundle_rollback_source_invalid');
    const target=await readRuntimeBundleDescriptor(controlRoot,targetBundleID);
    const retryHeld=current.selection.reconciliationRequired&&current.descriptor.bundleID===targetBundleID;
    const candidate=retryHeld?await readRuntimeBundleDescriptor(controlRoot,current.selection.previousBundleID):current.descriptor;
    if (candidate.bundleID===targetBundleID || !retryHeld&&current.selection.previousBundleID!==targetBundleID) throw fail('bundle_rollback_target_invalid');
    if (!options.reconcileRollback) throw fail('bundle_rollback_reconciliation_required');
    // Static incompatibility never closes B admission or changes its selector.
    if(current.selection.revision!==expectedRevision)throw fail('bundle_selection_revision_conflict');
    if(retryHeld)throw fail('bundle_recovery_resume_required');
    const targetArtifacts=await verifyArtifacts({generation:target.generation,launch:target.launch});
    const originBefore=await readBundleJSON(path.join(controlRoot,'rollback',candidate.bundleID+'.json')).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
    if(!targetArtifacts?.manifest.compiledContracts?.includes(NATIVE_BUNDLE_CREDENTIAL_CONTRACT)
      ||!isRecord(originBefore)||originBefore.schema!==1||originBefore.candidateBundleID!==candidate.bundleID||originBefore.targetBundleID!==target.bundleID
      ||originBefore.targetManifestSha256!==target.launch.artifactManifestSha256
      ||originBefore.targetDescriptorSha256!==await fileHash(path.join(controlRoot,'bundles',target.bundleID,'descriptor.json'))
      ||!validHash(originBefore.expectedTargetSha256)||!isBundleCredentialOwnerEvidence(originBefore.hostOwnerBaseline))throw fail('bundle_credential_contract_incompatible');
    const pending=readRollbackIntentSync(controlRoot);if(rollbackIntentUnresolved(pending,current.selection))throw fail('bundle_recovery_resume_required');
    return options.withQuiescedSource({kind:'bundle',bundleID:current.descriptor.bundleID},async (proof,scope) => {
      checkpoint(current.descriptor.launch,current.descriptor.generation,proof);
      await verify({bundleID:candidate.bundleID,phase:'resume',allowOwnedContinuations:false});
      await verify({bundleID:target.bundleID,phase:'resume',allowOwnedContinuations:false});
      let credentialBinding,capturedSource;
      let origin;try{origin=await readBundleJSON(path.join(controlRoot,'rollback',candidate.bundleID+'.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
      if(isRecord(origin)&&origin.schema===1&&origin.candidateBundleID===candidate.bundleID&&origin.targetBundleID===target.bundleID
        &&origin.targetManifestSha256===target.launch.artifactManifestSha256
        &&origin.targetDescriptorSha256===await fileHash(path.join(controlRoot,'bundles',target.bundleID,'descriptor.json'))){
        if(typeof scope?.assertHeld!=='function')throw fail('bundle_credential_checkpoint_required');
        await scope.assertHeld();
        const source=await options.captureCredentials?.({descriptor:candidate,checkpoint:proof,assertHeld:scope.assertHeld});capturedSource=source?.snapshot;
        if(validHash(origin.expectedTargetSha256)&&isRecord(source)&&source.protocol===NATIVE_BUNDLE_CREDENTIAL_CONTRACT&&source.status==='captured'
          &&validHash(source.sha256)&&sha256(canonicalJSON(source.snapshot))===source.sha256)credentialBinding={
            sourceBundleID:candidate.bundleID,targetBundleID:target.bundleID,targetManifestSha256:target.launch.artifactManifestSha256,
            expectedTargetSha256:origin.expectedTargetSha256,sourceSha256:source.sha256};
      }
      if(!credentialBinding||!scope?.settlement)throw fail('bundle_recovery_proof_required');
      await scope.assertHeld();
      const intent={protocol:'devryan.bundle.rollback-intent/1',state:'pending',revision:expectedRevision,
        candidateBundleID:candidate.bundleID,targetBundleID:target.bundleID,candidateDescriptorSha256:await fileHash(path.join(controlRoot,'bundles',candidate.bundleID,'descriptor.json')),
        candidatePreparedSha256:await fileHash(candidate.preparedManifestPath),candidateManifestSha256:candidate.launch.artifactManifestSha256,
        targetDescriptorSha256:await fileHash(path.join(controlRoot,'bundles',target.bundleID,'descriptor.json')),targetManifestSha256:target.launch.artifactManifestSha256,
        targetPreparedSha256:await fileHash(target.preparedManifestPath),expectedTargetCredentialSha256:credentialBinding.expectedTargetSha256,
        nativeCredentialSha256:credentialBinding.sourceSha256,hostOwners:await captureBundleCredentialOwners({descriptor:candidate,assertHeld:scope.assertHeld,controlRoot,claudeLifecycle:capturedSource?.claudeLifecycle}),
        checkpoint:proof,settlement:scope.settlement,files:await recoveryFiles(candidate)};
      await scope.assertHeld();
      await withCrossProcessFileLock(path.join(controlRoot,'selection.lock'),async()=>{
        if((await readSelected()).selection.revision!==expectedRevision)throw fail('bundle_selection_revision_conflict');
        await saveRollbackIntent(controlRoot,intent);
      });
      let result;
      if(credentialBinding){
        try{
          await assertBundleCredentialOwners({candidate,target,baseline:origin.hostOwnerBaseline,assertHeld:scope.assertHeld,controlRoot,claudeLifecycle:capturedSource?.claudeLifecycle});
          result=await options.reconcileRollback({candidate,target,credentialBinding,assertHeld:scope.assertHeld});
          if(result?.status==='reconciled')await assertBundleCredentialOwners({candidate,target,baseline:origin.hostOwnerBaseline,assertHeld:scope.assertHeld,controlRoot,claudeLifecycle:capturedSource?.claudeLifecycle});
        }catch(error){if(error.code!=='bundle_credential_owner_unsupported')throw error;result={status:'blocked',reason:error.code};}
      }else result={status:'blocked',reason:'bundle_credential_contract_incompatible'};
      if (!isRecord(result) || !['reconciled','blocked'].includes(result.status) || result.status==='blocked' && (typeof result.reason!=='string' || !/^[a-z][a-z0-9_]{1,127}$/.test(result.reason))) throw fail('bundle_rollback_reconciliation_unverified');
      if(result.status==='reconciled'&&(!isRecord(result.credentialReceipt)||result.credentialReceipt.protocol!==NATIVE_BUNDLE_CREDENTIAL_CONTRACT
        ||result.credentialReceipt.status!=='projected'||result.credentialReceipt.appliedSha256!==credentialBinding.sourceSha256
        ||Object.entries(credentialBinding).some(([key,value])=>result.credentialReceipt[key]!==value)))throw fail('bundle_credential_projection_unverified');
      await scope?.assertHeld?.();
      if(result.status==='reconciled')await saveRollbackIntent(controlRoot,{...intent,state:'completed',completion:result.credentialReceipt});
      const selected=await switchSelection({bundleID:targetBundleID,expectedRevision},'rollback',result.status!=='reconciled',candidate.bundleID);
      return {selection:selected,admission:'held',reason:result.status==='blocked' ? result.reason:null};
    });
  };
  return {prepare,verify,readSelected,select,rollback,resume};
}
