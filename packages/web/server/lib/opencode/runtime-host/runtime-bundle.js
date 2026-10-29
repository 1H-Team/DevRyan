import {nativeBundleFileOperations} from './native-bundle-file-operations.js';
import {runNativeHarnessRelocationProcess} from './native-harness-relocation.js';
import {isWindowsPrivateControlName} from '../../../../../harness-runtime/lib/windows-private-files.js';
import {relocateNativeSetupProfiles} from './native-setup-profiles.js';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { timeStartupPhase } from '../startup-timing.js';
import path from 'node:path';
import { resolveSqliteDriver } from '../sqlite-driver.js';
import { executionArtifacts } from '../execution-artifacts.js';
import { verifyNativeRuntimeArtifacts } from './native-artifacts.js';
import { withCrossProcessFileLock, writeFileAtomic } from '../../../../../harness-runtime/lib/atomic-file.js';
import { parseNativeMigrationReceipt } from './native-process-protocol.js';
import { assertNoPendingMigration, assertBundlePendingInput, undeliverableInboxIDs, bundleFailure, canonicalJSON, captureMigrationInventory, containsPath, isRecord,
  readBundleJSON as readBundleJSONOwned, saveBundleJSON as saveBundleJSONOwned, sha256, verifyMigrationReferences } from './bundle-migration-inventory.js';
import { verifyBundleOwnedContinuations } from './bundle-owned-continuations.js';
import {verifyBundleRecoveredInputs} from './bundle-recovered-inputs.js';
import {verifiedNativeUserCancellations} from './native-input-cancellation.js';
import { inspectBundleHarness } from './bundle-harness-integrity.js';
import { recordStartupFindings } from './startup-notices.js';
import {BUNDLE_CREDENTIAL_OWNER_PROTOCOL,isBundleCredentialOwnerEvidence,captureBundleCredentialOwners,assertBundleCredentialOwners} from './bundle-credential-owner-guard.js';

import {NATIVE_BUNDLE_CREDENTIAL_CONTRACT} from './native-bundle-credential-contract.js';
import {readRollbackIntentSync,rollbackIntentUnresolved,saveRollbackIntent,assertPrivateBundleControlRoot,assertRollbackPhysicalExit,captureRollbackFiles} from './bundle-rollback-intent.js';

const validID = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = bundleFailure;
const absolute = value => { if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) throw fail('bundle_path_invalid'); return value; };
// A clone hashes its whole copied tree for the preparation record, the prepared
// manifest and prepared-phase verification (~0.9 GB, 34k files, each pass serial).
// A digest is reused within this process while the file's device, inode, size,
// mode, mtime and ctime are unchanged; any write or replacement changes ctime.
// Only identities stable across the whole read are recorded.
const hashedFiles = new Map();
const fileIdentity = (file, stat) => `${file}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mode}:${stat.mtimeMs}:${stat.ctimeMs}`;
const fileHashOwned = async file => {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw fail('bundle_file_invalid');
  const identity = fileIdentity(file, stat), known = hashedFiles.get(identity);
  if (known) return known;
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(file, { highWaterMark: 1024 * 1024 })) digest.update(bytes);
  const value = digest.digest('hex');
  const after = await fs.lstat(file).catch(() => null);
  if (after && fileIdentity(file, after) === identity) {
    if (hashedFiles.size >= 200_000) hashedFiles.clear();
    hashedFiles.set(identity, value);
  }
  return value;
};
// Bounded parallel map that keeps input order.
const HASH_CONCURRENCY = 8;
const mapBounded = async (items, operation) => {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const index = next++; results[index] = await operation(items[index], index); } };
  await Promise.all(Array.from({ length: Math.min(HASH_CONCURRENCY, items.length) }, worker));
  return results;
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
    webDataDirectory:path.join(root,'web-data'),webConfigDirectory:path.join(root,'config','devryan'),
    opencodeConfigDirectory:path.join(root,'config','opencode'),reviewedNativeConfigPath:path.join(root,'config','reviewed-native.json'),
    reviewedPluginManifestPath:path.join(root,'config','reviewed-plugins.json')};
  for (const [key,file] of Object.entries(expected)) if (key !== 'webConfigDirectory' && value.launch[key] !== file) throw fail('bundle_descriptor_path_mismatch');
  if (![path.join(root,'config','devryan'),path.join(root,'config','openchamber')].includes(value.launch.webConfigDirectory)) throw fail('bundle_descriptor_path_mismatch');
  if (value.preparedManifestPath !== path.join(root,'prepared.json') || (value.generation === 2 && value.migrationReceiptPath !== path.join(root,'sources','migration.json'))) throw fail('bundle_descriptor_path_mismatch');
  for (const [key,file] of Object.entries(value.launch.global)) if (key !== 'config'
    && file !== path.join(root,'global',key,)) throw fail('bundle_descriptor_path_mismatch');
  return value;
};
export async function readRuntimeBundleDescriptor(controlRoot,bundleID,options={}) {
  absolute(controlRoot);
  if (!validID(bundleID)) throw fail('bundle_id_invalid');
  return descriptor(controlRoot,bundleID,await readBundleJSONOwned(path.join(controlRoot,'bundles',bundleID,'descriptor.json'),options));
}
const sqlite = file => {
  const raw = resolveSqliteDriver().open(file,{readonly:true});
  // VACUUM INTO takes a coherent SQLite snapshot, including committed WAL
  // pages, without copying or modifying the source database files.
  return { raw, backup:target => raw.prepare('VACUUM INTO ?').run(target),
    all:(sql,params=[]) => raw.prepare(sql).all(...params), run:() => { throw fail('bundle_read_only'); } };
};
/** Removes exactly the notices the source check set aside from the fresh copy;
 * the source, which stays the rollback target, is never written. */
const dropUndeliverableInbox = (file,ids) => {
  if (!ids.length) return;
  const raw = resolveSqliteDriver().open(file);
  try {
    raw.transaction(() => {
      if (canonicalJSON(undeliverableInboxIDs({all:(sql,params=[])=>raw.prepare(sql).all(...params)}))!==canonicalJSON(ids)) throw fail('bundle_snapshot_changed');
      for (const id of ids) raw.prepare('DELETE FROM session_inbox WHERE id=?').run(id);
    })();
  } finally { raw.close(); }
};
const ignored = relative => relative === 'orchestration/owner.lock' || relative === 'harness/provider-recovery/runtime-owner.lock'
  // Derived per-project state: execution caches, dependency link overlays
  // that preparation re-syncs from the project (links only, never copied), and
  // parked execution views, which only their own process could adopt.
  || /^harness\/session-mutations\/[a-f0-9]{64}\/(context-cache|module-overlays|view-standby)(\/|$)/.test(relative)
  || /^harness\/session-mutations\/[a-f0-9]{64}\/(owner\.lock|git\/index[^/]*)$/.test(relative)
  || /^harness\/(provider-recovery|context)\/[^/]+\.lock$/.test(relative)
  || /(^|\/)[^/]+\.tmp-[^/]+$/.test(relative);
// Links inside a project ledger are derived by its owner and rebuilt on use.
const derivedLedgerPath = relative => /^harness\/session-mutations\/[a-f0-9]{64}\//.test(relative);
/** `derivedLinks(relative)` names trees whose links are not data. Those, and
 * sockets or FIFOs anywhere below the root, are left behind and reported
 * through `onSkip`; every other link still refuses. */
const copyTreeOwned = async (source,target,{ignore=false,relative='',windowsOwner,derivedLinks,onSkip}={}) => {
  const operations=nativeBundleFileOperations({windowsOwner});
  const stat = await fs.lstat(source);
  if (relative && !operations.windows && (stat.isSocket() || stat.isFIFO() || stat.isSymbolicLink() && derivedLinks?.(relative))) {
    onSkip?.(relative); return;
  }
  if (stat.isSymbolicLink()) throw fail('bundle_symlink_source');
  if(await fs.realpath(source)!==source)throw fail('bundle_symlink_source');
  if (ignore && ignored(relative)) return;
  if(operations.windows){
    await operations.ensureDirectory(path.dirname(target));
    if(stat.isDirectory()){const exclusions=ignore?'runtime-bundle':'none';return windowsOwner.copyTree(source,target,await windowsOwner.tree(source,{exclusions}),{exclusions});}
    if(!stat.isFile())throw fail('bundle_special_file_source');
    const original=await windowsOwner.largeFile(source);
    return windowsOwner.streamFile(source,target,{expectedSha256:original.token.split(':')[2],expectedSize:original.size});
  }
  if (stat.isDirectory()) {
    await fs.mkdir(target,{recursive:true,mode:0o700});
    for (const name of (await fs.readdir(source)).sort()) await copyTreeOwned(path.join(source,name),path.join(target,name),{ignore,windowsOwner,derivedLinks,onSkip,relative:relative ? relative+'/'+name:name});
  } else if (stat.isFile()) { await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700}); await fs.copyFile(source,target,fs.constants.COPYFILE_FICLONE); await fs.chmod(target,stat.mode & 0o777); }
  else throw fail('bundle_special_file_source');
};
// These are the existing user data sources in skills.js. Copying HOME itself
// would import unrelated credentials and application state into the runtime.
const homeSkillRoots = [['.agents','skills'],['.opencode','skill'],['.opencode','skills'],
  ['.config','meridian','settings.json'],['.claude','.credentials.json']];
const copyHomeSkillsOwned = async (sourceHome,targetHome,options={}) => {
  const operations=nativeBundleFileOperations(options),copyTree=(source,target)=>copyTreeOwned(source,target,options);
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
      await operations.ensureDirectory(target);
      const file=path.join(source,'.credentials.json');let accountStat;
      try{accountStat=await fs.lstat(file);}catch(error){if(error.code==='ENOENT')return;throw error;}
      if(accountStat.size>1024*1024||await fs.realpath(source)!==source)throw fail('bundle_symlink_source');
      await copyTree(file,path.join(target,'.credentials.json'));
    }});
    const target=path.join(targetHome,'.config','meridian','profiles.json');await operations.writeFresh(target,JSON.stringify(relocated)+'\n');
  }
};
const treeManifestOwned = async (root,options={}) => {
  if(options.windowsOwner)await options.windowsOwner.tree(root);
  const files = [];
  const walk = async (directory,relative='') => {
    for (const entry of (await fs.readdir(directory,{withFileTypes:true})).sort((a,b) => a.name.localeCompare(b.name))) {
      if(options.windowsOwner&&isWindowsPrivateControlName(entry.name))continue;
      const file = path.join(directory,entry.name), name = relative ? relative+'/'+entry.name:entry.name;
      if (entry.isDirectory()) await walk(file,name);
      else if (entry.isFile()) files.push({path:name,file});
      else throw fail('bundle_special_file_source');
    }
  };
  await walk(root);
  if(options.windowsOwner){const rows=[];for(const {path:name,file} of files)rows.push({path:name,sha256:(await options.windowsOwner.largeFile(file)).token.split(':')[2]});return rows;}
  return mapBounded(files,async ({path:name,file})=>({path:name,sha256:await fileHashOwned(file)}));
};
// The bundle database's SQLite wal-index (opencode.db-shm) is rebuildable shared memory
// that every connection, including verify's read-only one, rewrites (read marks), so it
// is never snapshot content. Any other *.db-shm is ordinary content. *.db-wal stays
// covered: it holds committed pages, and a read-only connection never appends to,
// checkpoints or truncates it.
const durable = (rows,root,launch) => { const shm=path.relative(root,launch.opencodeDatabasePath)+'-shm';
  return rows.filter(row => !(isRecord(row) && row.path === shm)); };
const verifyTreeOwned = async (root,rows,options={}) => {
  if (!Array.isArray(rows)) throw fail('bundle_manifest_invalid');
  for (const row of rows) if (!isRecord(row) || typeof row.path !== 'string' || row.path.split('/').some(part => !part || part === '..')
    || !validHash(row.sha256)) throw fail('bundle_snapshot_changed');
  if (options.windowsOwner) {
    for (const row of rows) if ((await options.windowsOwner.largeFile(path.join(root,row.path))).token.split(':')[2] !== row.sha256) throw fail('bundle_snapshot_changed');
    return;
  }
  const digests = await mapBounded(rows, row => fileHashOwned(path.join(root,row.path)));
  if (digests.some((digest,index) => digest !== rows[index].sha256)) throw fail('bundle_snapshot_changed');
};
const reviewedDocuments = async (value,maps,options={}) => {
  const configuration=await readBundleJSONOwned(value.reviewedNativeConfigPath,options), plugins=await readBundleJSONOwned(value.reviewedPluginManifestPath,options);
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
const verifyRuntimeBundleArtifacts = async ({generation,launch:value,purpose}) => {
  const directory=path.dirname(absolute(value.artifactManifestPath));
  if (generation!==2) throw fail('bundle_artifact_generation_mismatch');
  const verified=await verifyNativeRuntimeArtifacts({manifestPath:value.artifactManifestPath,
    manifestSha256:value.artifactManifestSha256,launcher:executionArtifacts(directory).launcher,purpose});
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

// An artifact-only rebind rewrites these launch documents of the selected bundle in
// place. Its journal keeps byte copies of the previous ones; the selector is the commit.
const REBIND_PROTOCOL='devryan.bundle.rebind/1';
const rebindFiles=['descriptor.json','config/reviewed-plugins.json','prepared.json'];
// A cloned bundle's clone proof names its target manifest, which every boot,
// resume and rollback check compares with the launch, so a rebind reseals it.
// Journals written before this carry only the three launch documents.
const CLONE_PROOF='sources/clone.json';
const journaledFiles=intent=>Object.hasOwn(intent.previous,CLONE_PROOF)?[...rebindFiles,CLONE_PROOF]:rebindFiles;
const rebindRoot=controlRoot=>path.join(controlRoot,'rebind');
const rebindCopy=(controlRoot,relative)=>path.join(rebindRoot(controlRoot),'previous-'+path.basename(relative));
const readOwnedBytes=async file=>{
  const stat=await fs.lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink())throw fail('bundle_file_invalid');
  return fs.readFile(file);
};
const writeOwnedBytes=(file,bytes)=>writeFileAtomic(file,bytes,{mode:0o600,directoryMode:0o700});
const readRebindIntent=async controlRoot=>{
  let value;
  try{value=await readBundleJSONOwned(path.join(rebindRoot(controlRoot),'intent.json'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(!isRecord(value)||value.schema!==1||value.protocol!==REBIND_PROTOCOL||!['pending','committed','abandoned','restoring','restored'].includes(value.state)
    ||!validID(value.bundleID)||!isRecord(value.previous)||!isRecord(value.next)
    ||rebindFiles.some(file=>!validHash(value.previous[file])||!validHash(value.next[file]))
    ||Object.hasOwn(value.previous,CLONE_PROOF)!==Object.hasOwn(value.next,CLONE_PROOF)
    ||(Object.hasOwn(value.previous,CLONE_PROOF)&&(!validHash(value.previous[CLONE_PROOF])||!validHash(value.next[CLONE_PROOF]))))throw fail('bundle_rebind_intent_invalid');
  selection(value.sourceSelection);selection(value.selection);
  if(['restoring','restored'].includes(value.state))selection(value.restoreSelection);
  return value;
};
const saveRebindIntent=(controlRoot,value)=>saveBundleJSONOwned(path.join(rebindRoot(controlRoot),'intent.json'),value);
/** Whether `selection` is the committed result of an artifact rebind (read-only). */
export const isCommittedRebindSelection=async(controlRoot,selection)=>{
  const intent=await readRebindIntent(controlRoot);
  return intent?.state==='committed'&&canonicalJSON(intent.selection)===canonicalJSON(selection);
};
/** Whether the selected cloned bundle was rebound by a build that left its clone
 * proof naming the previous manifest; such a launch cannot boot (read-only). */
export const isStaleRebindClone=async(controlRoot,descriptor,selection)=>{
  if(!descriptor?.sourceBundleID||!await isCommittedRebindSelection(controlRoot,selection))return false;
  const clone=await readBundleJSONOwned(path.join(controlRoot,'bundles',descriptor.bundleID,CLONE_PROOF));
  return clone?.compatibility?.targetManifestSha256!==descriptor.launch.artifactManifestSha256;
};
/** Puts each launch document of the bundle back to its journaled previous bytes. */
const restoreRebindFiles=async (controlRoot,intent)=>{
  const root=path.join(controlRoot,'bundles',intent.bundleID);
  for(const relative of journaledFiles(intent)){
    const file=path.join(root,relative);
    if(await fileHashOwned(file)===intent.previous[relative])continue;
    const bytes=await readOwnedBytes(rebindCopy(controlRoot,relative));
    if(sha256(bytes)!==intent.previous[relative])throw fail('bundle_rebind_recovery_changed');
    await writeOwnedBytes(file,bytes);
  }
};

/** Cold bootstrap only, inside bootstrap.lock and before any binding read. Settles
 * an artifact rebind or its rollback that a crash interrupted: before the selector
 * flips a rebind is undone, and an interrupted rollback of one is completed. */
export async function recoverRuntimeBundleRebind({controlRoot}){
  absolute(controlRoot);
  // A settled journal never needs the selector lock a lifecycle may be holding.
  if(!['pending','restoring'].includes((await readRebindIntent(controlRoot))?.state))return null;
  return withCrossProcessFileLock(path.join(controlRoot,'selection.lock'),async()=>{
    const intent=await readRebindIntent(controlRoot);
    if(!intent||!['pending','restoring'].includes(intent.state))return null;
    const selected=canonicalJSON(selection(await readBundleJSONOwned(path.join(controlRoot,'selection.json'))));
    if(intent.state==='pending'){
      // Every rebound document is written before the selector flips.
      if(selected===canonicalJSON(intent.selection)){await saveRebindIntent(controlRoot,{...intent,state:'committed'});return 'committed';}
      if(selected!==canonicalJSON(intent.sourceSelection))throw fail('bundle_rebind_selection_changed');
      await restoreRebindFiles(controlRoot,intent);
      await saveRebindIntent(controlRoot,{...intent,state:'abandoned'});return 'abandoned';
    }
    if(selected===canonicalJSON(intent.selection)){
      await restoreRebindFiles(controlRoot,intent);
      await saveBundleJSONOwned(path.join(controlRoot,'selection.json'),intent.restoreSelection);
    }else if(selected!==canonicalJSON(intent.restoreSelection))throw fail('bundle_rebind_selection_changed');
    await saveRebindIntent(controlRoot,{...intent,state:'restored'});return 'restored';
  });
}

/** Offline copied bundles and one atomic selector. Admission remains host-owned. */
export function createRuntimeBundleStore(options) {
  const controlRoot = absolute(options.controlRoot), now = options.now ?? Date.now;
  const operations=nativeBundleFileOperations(options);
  const copyTree=(source,target,copyOptions={})=>copyTreeOwned(source,target,{...copyOptions,windowsOwner:options.windowsOwner});
  const copyHomeSkills=(source,target)=>copyHomeSkillsOwned(source,target,options);
  const treeManifest=root=>treeManifestOwned(root,options);
  const verifyTree=(root,rows)=>verifyTreeOwned(root,rows,options);
  const createCandidate=async root=>{
    await operations.ensureDirectory(path.dirname(root));
    if(!operations.windows)return fs.mkdir(root,{mode:0o700});
    return options.windowsOwner.createDirectory(root);
  };
  const documentOptions={...options,windowsOwner:options.windowsLedgerOwner??options.windowsOwner};
  const readBundleJSON=file=>readBundleJSONOwned(file,documentOptions);
  const saveBundleJSON=(file,value)=>saveBundleJSONOwned(file,value,documentOptions);
  const fileHash=file=>operations.windows&&containsPath(controlRoot,file)?options.windowsOwner.largeFile(file).then(value=>value.token.split(':')[2]):fileHashOwned(file);
  const inspectHarness=async(directory,input,artifacts)=>{const result=await inspectBundleHarnessOwned(directory,input,artifacts);recordStartupFindings('bundle_verifier',result?.findings);return result;};
  const inspectBundleHarnessOwned=(directory,input,artifacts)=>inspectBundleHarness(directory,{...input,windowsOwner:options.windowsOwner,windowsLedgerOwner:options.windowsLedgerOwner,
    runWindowsInspection:request=>runNativeHarnessRelocationProcess({binary:artifacts.controllerBinary,controlRoot,windowsOwner:options.windowsOwner,
      request:{protocol:'devryan-native-harness-relocation/1',requestID:'harness_'+sha256(canonicalJSON({directory,...request})).slice(0,32),webDataDirectory:directory,...request},
      beforeSpawn:()=>verifyArtifacts({generation:2,launch:artifacts})})});
  const readDescriptor=id=>readRuntimeBundleDescriptor(controlRoot,id,documentOptions);
  const lock=(file,action)=>withCrossProcessFileLock(file,action,{windowsLauncher:options.windowsLauncher});
  if (typeof options.withQuiescedSource !== 'function' || typeof options.runMigration !== 'function') throw new TypeError('owned bundle callbacks required');
  // Only the constructing host may replace verification for deterministic fixtures.
  // Bundle input, selected descriptors and RPC metadata never choose this policy.
  const verifyArtifacts=options.verifyArtifacts ?? verifyRuntimeBundleArtifacts;
  if (typeof verifyArtifacts!=='function') throw new TypeError('owned artifact verifier required');
  const readSelected = async () => {
    let current;
    try { current = selection(await readBundleJSON(path.join(controlRoot,'selection.json'))); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const value=await readDescriptor(current.selectedBundleID);
    if (await fileHash(value.preparedManifestPath)!==current.preparedManifestSha256) throw fail('bundle_selected_evidence_changed');
    return {selection:current,descriptor:value};
  };
  const verify = async ({bundleID,phase,allowOwnedContinuations=true,artifactPurpose,cloneSource=false}) => {
    if (!['prepared','resume'].includes(phase)) throw fail('bundle_verification_phase_invalid');
    if (artifactPurpose !== undefined && (phase !== 'resume' || !['bundle-source','bundle-rollback'].includes(artifactPurpose))) throw fail('bundle_artifact_generation_mismatch');
    const value = await readDescriptor(bundleID), root = path.join(controlRoot,'bundles',bundleID);
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
    await reviewedDocuments(value.launch,value.generation===2?value.projectMap:undefined,documentOptions);
    const expectedArtifacts=[value.launch.controllerBinary,value.launch.writerBinary,value.launch.artifactManifestPath].filter(Boolean).sort();
    if (!Array.isArray(manifest.artifactFiles) || canonicalJSON(manifest.artifactFiles.map(row=>row.path).sort())!==canonicalJSON(expectedArtifacts)
      || manifest.artifactFiles.find(row=>row.path===value.launch.artifactManifestPath)?.sha256!==value.launch.artifactManifestSha256) throw fail('bundle_manifest_invalid');
    for (const row of manifest.artifactFiles) if (!isRecord(row) || !validHash(row.sha256) || await fileHash(absolute(row.path))!==row.sha256) throw fail('bundle_artifact_changed');
    const verifiedArtifacts = await verifyArtifacts({generation:value.generation,launch:value.launch,...artifactPurpose?{purpose:artifactPurpose}:{}});
    if (phase === 'prepared') {
      const initial=durable(manifest.initialFiles,root,value.launch);
      await verifyTree(root,initial);
      const actual=durable(await treeManifest(root),root,value.launch).filter(row=>row.path!=='prepared.json');
      if (JSON.stringify(actual)!==JSON.stringify(initial)) throw fail('bundle_snapshot_changed');
    }
    let removalInheritance;
    const db = sqlite(value.launch.opencodeDatabasePath);
    try {
      const baseline=await readBundleJSON(path.join(root,'sources','baseline.json'));
      if (!isRecord(baseline) || !isRecord(baseline.harness) || !Array.isArray(baseline.harness.refs)) throw fail('bundle_manifest_invalid');
      const preservedRefs={checkpointID:value.checkpoint.checkpointID,refs:baseline.harness.refs};
      if (value.sourceBundleID && value.checkpoint.generation === 2 && value.checkpoint.ownerID === value.sourceBundleID) {
        removalInheritance = preservedRefs;
      }
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
        // Only a clone's quiesced source tolerates notices the copy leaves behind.
        const setAside=cloneSource&&phase==='resume'&&!allowOwnedContinuations?undeliverableInboxIDs(db):[];
        let verifiedContinuations;
        if(selected?.descriptor.bundleID===bundleID&&!selected.selection.reconciliationRequired&&selected.selection.transition==='activate'){
          if(options.allowRecoveredInputStartup===true)verifiedContinuations=await verifyBundleRecoveredInputs(db,value.launch.webDataDirectory);
          else {
            const cancelled=(await verifyBundleRecoveredInputs(db,value.launch.webDataDirectory)).filter(proof=>proof.cancellation);
            const owned=await verifyBundleOwnedContinuations(db,value.launch.webDataDirectory,{cancelledContinuations:cancelled});
            verifiedContinuations=[...owned.filter(proof=>!cancelled.some(item=>item.id===proof.id)),...cancelled];
          }
        }else verifiedContinuations=await verifyBundleRecoveredInputs(db,value.launch.webDataDirectory,{cancelledOnly:true,setAside});
        if(value.sourceBundleID&&phase==='prepared')assertNoPendingMigration(db);
        const graph = verifyMigrationReferences(db,source.inventory,{phase:value.sourceBundleID?'resume':phase,projectMap:value.projectMap,verifiedContinuations,migrationReceiptMarker:receipt.marker,setAside});
        const nativeUsers = db.all("SELECT id,session_id,data FROM session_message WHERE type='user'").flatMap(row => {
          try {
            const admission = JSON.parse(row.data)?.metadata?.devryan?.admission;
            return admission?.v === 1 && /^[a-f0-9]{64}$/.test(admission.fingerprint ?? '')
              ? [{ id:row.id, sessionID:row.session_id, fingerprint:admission.fingerprint }] : [];
          } catch { return []; }
        });
        await inspectHarness(value.launch.webDataDirectory,{projectMap:value.projectMap,preservedRefs,
          sessionIDs:graph.sessionIDs,messageIDs:graph.nativeMessageIDs,verifiedContinuations,nativeUsers,
          verifiedCancellations:verifiedNativeUserCancellations(db)},value.launch);
        if (phase==='resume') assertBundlePendingInput(db,verifiedContinuations,setAside);
      }
    } finally { db.raw.close(); }
    const result = {descriptor:value,phase,integrity:'verified',admission:'held'};
    if (removalInheritance) Object.defineProperty(result, 'removalInheritance', { value: removalInheritance });
    // Keep the fresh signature receipt private; the wire verification contract stays unchanged.
    if (verifiedArtifacts?.manifestPath) Object.defineProperty(result, 'artifacts', { value: verifiedArtifacts });
    return result;
  };
  const finishPreparation=async(value,artifacts,request)=>{
    const root=path.join(controlRoot,'bundles',value.bundleID);
    if (request) {
      const result=parseNativeMigrationReceipt(await options.runMigration(request));
      if (result.bundleID!==value.bundleID || result.databasePath!==value.launch.opencodeDatabasePath) throw fail('bundle_migration_evidence_invalid');
    }
    descriptor(controlRoot,value.bundleID,value);
    await saveBundleJSON(path.join(root,'descriptor.json'),value);
    const files=durable(await treeManifest(root),root,value.launch);
    await saveBundleJSON(value.preparedManifestPath,{schema:1,bundleID:value.bundleID,checkpointID:value.checkpoint.checkpointID,
      descriptorSha256:await fileHash(path.join(root,'descriptor.json')),
      artifactFiles:await Promise.all([artifacts.controllerBinary,artifacts.writerBinary,artifacts.artifactManifestPath].filter(Boolean).map(async file=>({path:absolute(file),sha256:options.windowsOwner?(await options.windowsOwner.largeFile(file)).token.split(':')[2]:await fileHashOwned(file)}))),
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
      await verify({bundleID:source.bundleID,phase:'resume',allowOwnedContinuations:false,artifactPurpose:'bundle-source',cloneSource:true});
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
      try{await createCandidate(root);}catch(error){if(error.code==='EEXIST')throw fail('bundle_candidate_exists');throw error;}
      const globals=Object.fromEntries(Object.keys(source.launch.global).map(key=>[key,key==='config'?path.join(root,'config','opencode'):path.join(root,'global',key)]));
      const db=sqlite(source.launch.opencodeDatabasePath);let harness;
      try{
        const sessionIDs=db.all('SELECT id FROM session_v2').map(row=>row.id),messageIDs=db.all('SELECT id FROM session_message').map(row=>row.id);
        harness=await inspectHarness(source.launch.webDataDirectory,{sessionIDs,messageIDs},source.launch);
        const setAside=undeliverableInboxIDs(db);
        await timeStartupPhase('bundle_database_checkpoint',()=>operations.withSqliteOutput(path.join(root,'opencode','opencode.db'),file=>{
          db.backup(file);dropUndeliverableInbox(file,setAside);}));
        recordStartupFindings('bundle_copy',setAside.map(key=>({code:'bundle_inbox_notice_undelivered',scope:'opencode',key})));
      }finally{db.raw.close();}
      await timeStartupPhase('bundle_data_copy',async()=>{
        const skipped=scope=>relative=>recordStartupFindings('bundle_copy',[{code:'bundle_copy_entry_skipped',scope,key:relative}]);
        await copyTree(source.launch.webDataDirectory,path.join(root,'web-data'),{ignore:true,derivedLinks:derivedLedgerPath,onSkip:skipped('web-data')});
        await copyTree(source.launch.webConfigDirectory,path.join(root,'config','devryan'),{onSkip:skipped('config')});
        await copyTree(source.launch.opencodeConfigDirectory,globals.config,{onSkip:skipped('config')});
        // Home and data may hold user configuration behind a link; only disposable trees drop theirs.
        for(const [key,directory] of Object.entries(source.launch.global))if(key!=='config')await copyTree(directory,globals[key],
          {ignore:true,onSkip:skipped(`global/${key}`),...['cache','tmp','log'].includes(key)?{derivedLinks:()=>true}:{}});
      });
      let copiedHomeToken=operations.windows?await options.windowsOwner.tree(globals.home):undefined;
      // Relocate only the existing typed account profile paths, never arbitrary JSON strings.
      const profiles=path.join(source.launch.global.home,'.config','meridian','profiles.json');
      try{
        const rows=await readBundleJSON(profiles);
        const relocated=await relocateNativeSetupProfiles({profiles:rows,sourceHome:source.launch.global.home,targetHome:globals.home,controlRoot,claudeLifecycle:credentials.snapshot.claudeLifecycle,
          copyAccount:async(account,destination)=>{
            if(!containsPath(source.launch.global.home,account))throw fail('bundle_symlink_source');
            if(operations.windows){
              if(await options.windowsOwner.tree(globals.home)!==copiedHomeToken)throw fail('bundle_snapshot_changed');
              const exists=await fs.lstat(destination).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
              if(exists){if(destination!==path.join(globals.home,path.relative(source.launch.global.home,account)))throw fail('bundle_candidate_exists');return;}
            }
            await copyTree(account,destination);if(operations.windows)copiedHomeToken=await options.windowsOwner.tree(globals.home);
          }});
        await saveBundleJSON(path.join(globals.home,'.config','meridian','profiles.json'),relocated);
      }catch(error){if(error.code!=='ENOENT')throw error;}
      await operations.ensureDirectory(path.join(root,'sources'));
      for(const suffix of ['','.source.json','.verification.json'])await copyTree(source.migrationReceiptPath+suffix,path.join(root,'sources','migration.json')+suffix);
      const migrationOrigin=parseNativeMigrationReceipt(await readBundleJSON(source.migrationReceiptPath));
      await saveBundleJSON(path.join(root,'sources','baseline.json'),{schema:1,checkpoint:sourceCheckpoint,harness});
      await saveBundleJSON(path.join(root,'sources','clone.json'),{schema:1,sourceBundleID:source.bundleID,compatibility,
        sourceCredentialSha256:credentials.sha256,sourceHostOwners:hostOwnerBaseline,
        sourceDescriptorSha256:await fileHash(path.join(controlRoot,'bundles',source.bundleID,'descriptor.json')),
        sourcePreparedManifestSha256:await fileHash(source.preparedManifestPath),migrationOrigin:{bundleID:migrationOrigin.bundleID,databasePath:migrationOrigin.databasePath}});
      await reviewedDocuments(artifacts,input.projectMap,documentOptions);
      await copyTree(artifacts.reviewedNativeConfigPath,path.join(root,'config','reviewed-native.json'));
      await copyTree(artifacts.reviewedPluginManifestPath,path.join(root,'config','reviewed-plugins.json'));
      const value={schema:1,bundleID:input.bundleID,generation:2,sourceBundleID:source.bundleID,createdAt:now(),checkpoint:sourceCheckpoint,
        launch:{...artifacts,opencodeDatabasePath:path.join(root,'opencode','opencode.db'),webDataDirectory:path.join(root,'web-data'),
          webConfigDirectory:path.join(root,'config','devryan'),opencodeConfigDirectory:globals.config,global:globals,
          reviewedNativeConfigPath:path.join(root,'config','reviewed-native.json'),reviewedPluginManifestPath:path.join(root,'config','reviewed-plugins.json')},
        projectMap:source.projectMap,preparedManifestPath:path.join(root,'prepared.json'),migrationReceiptPath:path.join(root,'sources','migration.json')};
      await inspectHarness(value.launch.webDataDirectory,{projectMap:value.projectMap,relocate:true,sourceWebDataDirectory:source.launch.webDataDirectory,checkpointID:sourceCheckpoint.checkpointID},value.launch);
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
    try { await createCandidate(root); }
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
        harness=await inspectHarness(sourceLaunch.webDataDirectory,{sessionIDs:inventory.sessions.map(row => row.id),messageIDs:inventory.messages.map(row => row.id)},artifacts);
        await operations.withSqliteOutput(path.join(root,'opencode','opencode.db'),file=>sourceDB.backup(file));
      } finally { sourceDB.raw.close(); }
      await copyTree(sourceLaunch.webDataDirectory,path.join(root,'web-data'),{ignore:true});
      await copyTree(sourceLaunch.webConfigDirectory,path.join(root,'config','devryan'));
      await copyTree(sourceLaunch.opencodeConfigDirectory,path.join(root,'config','opencode'));
      await operations.ensureDirectory(path.join(root,'sources'));
      await saveBundleJSON(path.join(root,'sources','baseline.json'),{schema:1,checkpoint:sourceCheckpoint,inventory,harness});
      await reviewedDocuments(artifacts,input.generation===2?input.projectMap:undefined,documentOptions);
      await copyTree(absolute(artifacts.reviewedNativeConfigPath),path.join(root,'config','reviewed-native.json'));
      await copyTree(absolute(artifacts.reviewedPluginManifestPath),path.join(root,'config','reviewed-plugins.json'));
      const globals = Object.fromEntries(['home','data','state','cache','tmp','bin','log','repos'].map(key =>
        [key,path.join(root,'global',key,)]));
      globals.config=path.join(root,'config','opencode');
      for (const directory of Object.values(globals)) await operations.ensureDirectory(directory);
      await copyHomeSkills(sourceLaunch.global.home,globals.home);
      const value = {schema:1,bundleID:input.bundleID,generation:input.generation,createdAt:now(),
        checkpoint:sourceCheckpoint,
        launch:{...artifacts,opencodeDatabasePath:path.join(root,'opencode','opencode.db'),
          webDataDirectory:path.join(root,'web-data'),webConfigDirectory:path.join(root,'config','devryan'),opencodeConfigDirectory:globals.config,global:globals,
          reviewedNativeConfigPath:path.join(root,'config','reviewed-native.json'),reviewedPluginManifestPath:path.join(root,'config','reviewed-plugins.json')},
        projectMap:input.projectMap,preparedManifestPath:path.join(root,'prepared.json')};
      await inspectHarness(value.launch.webDataDirectory,{projectMap:input.generation===2 ? input.projectMap:
        input.projectMap.map(row=>({...row,targetDirectory:row.sourceDirectory,mode:'identity'})),
        sourceWebDataDirectory:sourceLaunch.webDataDirectory,relocate:true,checkpointID:sourceCheckpoint.checkpointID},value.launch);
      let request;
      if (input.generation === 2) {
        let auxiliary = input.auxiliary;
        if (!isRecord(auxiliary) || !['absent','copy'].includes(auxiliary.kind)) throw fail('bundle_auxiliary_invalid');
        if (auxiliary.kind === 'copy') {
          const source = sqlite(absolute(auxiliary.databasePath));
          try { assertNoPendingMigration(source); await operations.withSqliteOutput(path.join(root,operations.windows?'auxiliary':'sources','opencode-next.db'),file=>source.backup(file)); }
          finally { source.raw.close(); }
          if (await fileHash(auxiliary.databasePath) !== auxiliary.sha256) throw fail('bundle_auxiliary_changed');
          auxiliary={kind:'copy',databasePath:path.join(root,operations.windows?'auxiliary':'sources','opencode-next.db'),sha256:await fileHash(path.join(root,operations.windows?'auxiliary':'sources','opencode-next.db'))};
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
  const switchSelection = async ({bundleID,expectedRevision},transition,reconciliationRequired,previousBundleID,credentialBaseline,claudeIntent) => lock(path.join(controlRoot,'selection.lock'),async () => {
    const current = await readSelected(), revision=current?.selection.revision ?? 0;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== revision) throw fail('bundle_selection_revision_conflict');
    const verified=await verify({bundleID,phase:'resume',allowOwnedContinuations:false,
      ...(transition==='rollback'?{artifactPurpose:'bundle-rollback'}:{})});
    const next={schema:1,revision:revision+1,selectedBundleID:bundleID,previousBundleID:previousBundleID ?? current?.selection.selectedBundleID ?? null,
      transition,reconciliationRequired,preparedManifestSha256:await fileHash(verified.descriptor.preparedManifestPath)};
    if(credentialBaseline)await saveBundleJSON(path.join(controlRoot,'rollback',bundleID+'.json'),credentialBaseline);
    if (claudeIntent) await saveBundleJSON(path.join(controlRoot, 'claude-activation.json'), claudeIntent);
    await saveBundleJSON(path.join(controlRoot,'selection.json'),next); return next;
  });
  const select = async input => {
    const current=await readSelected(), source={kind:'bundle',bundleID:current?.descriptor.bundleID ?? input.bundleID};
    const value=current?.descriptor ?? await readDescriptor(input.bundleID);
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
        const candidate=await readDescriptor(input.bundleID);
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
      let claudeIntent;
      if (input.claudeUpdate === true) {
        if (!current || !baseline) throw fail('bundle_claude_activation_invalid');
        claudeIntent = { schema: 1, state: 'pending',
          candidateBundleID: input.bundleID, sourceSelection: current.selection,
          sourceFiles: await captureRollbackFiles(path.join(controlRoot, 'bundles', current.descriptor.bundleID)) };
      }
      return switchSelection(input,'activate',false,undefined,baseline,claudeIntent);
    });
  };
  const recoveryFiles = value => captureRollbackFiles(path.join(controlRoot,'bundles',value.bundleID));
  const resume = async input => {
    if(!isRecord(input)||Object.keys(input).length!==1||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1)throw fail('bundle_selection_revision_conflict');
    const {expectedRevision}=input;
    await assertPrivateBundleControlRoot(controlRoot);
    return lock(path.join(controlRoot,'selection.lock'),async()=>{
    await assertPrivateBundleControlRoot(controlRoot);
    const current=await readSelected(),intent=readRollbackIntentSync(controlRoot);
    if(!current||!intent||!rollbackIntentUnresolved(intent,current.selection))throw fail('bundle_recovery_proof_required');
    if(!Number.isSafeInteger(expectedRevision)||current.selection.revision!==expectedRevision)throw fail('bundle_selection_revision_conflict');
    const candidate=await readDescriptor(intent.candidateBundleID);
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
    await saveRollbackIntent(controlRoot,{...intent,state:'resuming',resumeRevision:next.revision},options);
    await saveBundleJSON(path.join(controlRoot,'selection.json'),next);
    await saveRollbackIntent(controlRoot,{...intent,state:'resumed',resumeRevision:next.revision},options);
    return next;
  });
  };
  const rollback = async ({targetBundleID,expectedRevision}) => {
    const current=await readSelected();
    if (!current) throw fail('bundle_rollback_source_invalid');
    const target=await readDescriptor(targetBundleID);
    const retryHeld=current.selection.reconciliationRequired&&current.descriptor.bundleID===targetBundleID;
    const candidate=retryHeld?await readDescriptor(current.selection.previousBundleID):current.descriptor;
    if (candidate.bundleID===targetBundleID || !retryHeld&&current.selection.previousBundleID!==targetBundleID) throw fail('bundle_rollback_target_invalid');
    if (!options.reconcileRollback) throw fail('bundle_rollback_reconciliation_required');
    // Static incompatibility never closes B admission or changes its selector.
    if(current.selection.revision!==expectedRevision)throw fail('bundle_selection_revision_conflict');
    if(retryHeld)throw fail('bundle_recovery_resume_required');
    const targetArtifacts=await verifyArtifacts({generation:target.generation,launch:target.launch,purpose:'bundle-rollback'});
    const originBefore=await readBundleJSON(path.join(controlRoot,'rollback',candidate.bundleID+'.json')).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
    if(!targetArtifacts?.manifest.compiledContracts?.includes(NATIVE_BUNDLE_CREDENTIAL_CONTRACT)
      ||!isRecord(originBefore)||originBefore.schema!==1||originBefore.candidateBundleID!==candidate.bundleID||originBefore.targetBundleID!==target.bundleID
      ||originBefore.targetManifestSha256!==target.launch.artifactManifestSha256
      ||originBefore.targetDescriptorSha256!==await fileHash(path.join(controlRoot,'bundles',target.bundleID,'descriptor.json'))
      ||!validHash(originBefore.expectedTargetSha256)||!isBundleCredentialOwnerEvidence(originBefore.hostOwnerBaseline))throw fail('bundle_credential_contract_incompatible');
    const pending=readRollbackIntentSync(controlRoot);if(rollbackIntentUnresolved(pending,current.selection))throw fail('bundle_recovery_resume_required');
    return options.withQuiescedSource({kind:'bundle',bundleID:current.descriptor.bundleID},async (proof,scope) => {
      checkpoint(current.descriptor.launch,current.descriptor.generation,proof);
      await verify({bundleID:candidate.bundleID,phase:'resume',allowOwnedContinuations:false,artifactPurpose:'bundle-source'});
      await verify({bundleID:target.bundleID,phase:'resume',allowOwnedContinuations:false,artifactPurpose:'bundle-rollback'});
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
      await lock(path.join(controlRoot,'selection.lock'),async()=>{
        if((await readSelected()).selection.revision!==expectedRevision)throw fail('bundle_selection_revision_conflict');
        await saveRollbackIntent(controlRoot,intent,options);
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
      if(result.status==='reconciled')await saveRollbackIntent(controlRoot,{...intent,state:'completed',completion:result.credentialReceipt},options);
      const selected=await switchSelection({bundleID:targetBundleID,expectedRevision},'rollback',result.status!=='reconciled',candidate.bundleID);
      return {selection:selected,admission:'held',reason:result.status==='blocked' ? result.reason:null};
    });
  };
  // Cold bootstrap only. An untouched prepared clone has never accepted work;
  // restore its unchanged source without replay or credential projection.
  const restoreUnstartedClaude = async () => lock(path.join(controlRoot, 'selection.lock'), async () => {
    if (typeof options.assertNoLiveOwner !== 'function') throw fail('bundle_claude_recovery_owner_required');
    const current = await readSelected(), intent = await readBundleJSON(path.join(controlRoot, 'claude-activation.json'));
    if (intent?.schema !== 1 || intent.state !== 'pending' || !current || current.selection.reconciliationRequired
      || current.selection.transition !== 'activate' || intent.candidateBundleID !== current.descriptor.bundleID
      || current.descriptor.sourceBundleID !== current.selection.previousBundleID) throw fail('bundle_claude_activation_invalid');
    const previous = selection(intent.sourceSelection);
    if (current.selection.revision !== previous.revision + 1 || previous.selectedBundleID !== current.selection.previousBundleID) throw fail('bundle_selection_revision_conflict');
    const source = await readDescriptor(previous.selectedBundleID), candidate = current.descriptor;
    await options.assertNoLiveOwner(candidate.launch); await options.assertNoLiveOwner(source.launch);
    if (await fileHash(source.preparedManifestPath) !== previous.preparedManifestSha256) throw fail('bundle_claude_recovery_changed');
    const root = path.join(controlRoot, 'bundles', candidate.bundleID), prepared = await readBundleJSON(candidate.preparedManifestPath);
    if (prepared.descriptorSha256 !== await fileHash(path.join(root, 'descriptor.json')) || !Array.isArray(prepared.initialFiles)) throw fail('bundle_claude_recovery_changed');
    const initial = durable(prepared.initialFiles, root, candidate.launch);
    await verifyTree(root, initial);
    if (canonicalJSON(durable(await treeManifest(root), root, candidate.launch).filter(row => row.path !== 'prepared.json')) !== canonicalJSON(initial)
      || canonicalJSON(intent.sourceFiles) !== canonicalJSON(await captureRollbackFiles(path.join(controlRoot, 'bundles', source.bundleID)))) throw fail('bundle_claude_recovery_changed');
    if (rollbackIntentUnresolved(readRollbackIntentSync(controlRoot), current.selection)) throw fail('bundle_recovery_resume_required');
    await verify({ bundleID: source.bundleID, phase: 'resume', artifactPurpose: 'bundle-rollback', allowOwnedContinuations: false });
    await options.assertNoLiveOwner(candidate.launch); await options.assertNoLiveOwner(source.launch);
    const next = { ...previous, revision: current.selection.revision + 1, transition: 'rollback' };
    await saveBundleJSON(path.join(controlRoot, 'selection.json'), next);
    await saveBundleJSON(path.join(controlRoot, 'claude-activation.json'), { ...intent, state: 'restored' });
    return next;
  });
  const assertRebindable = async current => {
    if (operations.windows) throw fail('bundle_rebind_unsupported');
    if (rollbackIntentUnresolved(readRollbackIntentSync(controlRoot), current.selection)) throw fail('bundle_recovery_resume_required');
    if (current.selection.reconciliationRequired) throw fail('bundle_rollback_reconciliation_required');
    if (['pending', 'restoring'].includes((await readRebindIntent(controlRoot))?.state)) throw fail('bundle_rebind_recovery_required');
  };
  /** Artifact-only upgrade of the selected bundle for an unchanged OpenCode core:
   * the same data directory, with new launch artifacts and reviewed plugins. Any
   * other upgrade needs prepare's migration-safe copy. */
  const rebindArtifacts = async ({ bundleID, expectedRevision, launchArtifacts: artifacts }) => {
    const current = await readSelected();
    if (!current || current.descriptor.bundleID !== bundleID) throw fail('bundle_clone_source_not_selected');
    await assertRebindable(current);
    let activation;
    try { activation = await readBundleJSON(path.join(controlRoot, 'claude-activation.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Its cold restore compares the never-started candidate with its prepared files.
    if (activation?.state === 'pending' && activation.candidateBundleID === bundleID) throw fail('bundle_claude_activation_pending');
    const source = current.descriptor;
    if (!isRecord(artifacts) || !validHash(artifacts.artifactManifestSha256)
      || await fileHash(absolute(artifacts.artifactManifestPath)) !== artifacts.artifactManifestSha256) throw fail('bundle_artifact_manifest_changed');
    if (artifacts.artifactManifestSha256 === source.launch.artifactManifestSha256) throw fail('bundle_upgrade_not_available');
    if (artifacts.reviewedNativeConfigPath !== source.launch.reviewedNativeConfigPath) throw fail('bundle_rebind_configuration_changed');
    const contracts = (await verifyArtifacts({ generation: 2, launch: artifacts }))?.manifest?.compiledContracts;
    if (!Array.isArray(contracts) || !contracts.includes(BUNDLE_CREDENTIAL_OWNER_PROTOCOL)) throw fail('bundle_credential_owner_unsupported');
    if (!contracts.includes(NATIVE_BUNDLE_CREDENTIAL_CONTRACT)) throw fail('bundle_credential_contract_incompatible');
    const compatibility = { protocol: 'devryan-v2-clone/1', sourceBundleID: source.bundleID,
      sourceManifestSha256: source.launch.artifactManifestSha256, targetManifestSha256: artifacts.artifactManifestSha256 };
    const compatible = await options.verifyV2Compatibility?.({ source, artifacts });
    if (!isRecord(compatible) || compatible.status !== 'compatible' || canonicalJSON(compatible.binding) !== canonicalJSON(compatibility)) throw fail('bundle_v2_upgrade_compatibility_required');
    await reviewedDocuments(artifacts, source.projectMap, documentOptions);
    const plugins = await readOwnedBytes(absolute(artifacts.reviewedPluginManifestPath));
    return options.withQuiescedSource({ kind: 'bundle', bundleID }, async (proof, scope) => {
      checkpoint(source.launch, 2, proof);
      await scope?.assertHeld?.();
      // Held throughout: startup recovery never observes a live rebind.
      return lock(path.join(controlRoot, 'selection.lock'), async () => {
        const selected = await readSelected();
        if (canonicalJSON(selected?.selection) !== canonicalJSON(current.selection) || selected.selection.revision !== expectedRevision) throw fail('bundle_selection_revision_conflict');
        await assertRebindable(selected);
        const root = path.join(controlRoot, 'bundles', bundleID);
        const files = selected.descriptor.sourceBundleID ? [...rebindFiles, CLONE_PROOF] : rebindFiles;
        const previous = Object.fromEntries(await Promise.all(files.map(async file => [file, await readOwnedBytes(path.join(root, file))])));
        if (sha256(previous['prepared.json']) !== selected.selection.preparedManifestSha256) throw fail('bundle_selected_evidence_changed');
        const value = descriptor(controlRoot, bundleID, { ...selected.descriptor, launch: { ...selected.descriptor.launch,
          controllerBinary: artifacts.controllerBinary, writerBinary: artifacts.writerBinary,
          artifactManifestPath: artifacts.artifactManifestPath, artifactManifestSha256: artifacts.artifactManifestSha256 } });
        const descriptorBytes = Buffer.from(canonicalJSON(value) + '\n');
        const clone = previous[CLONE_PROOF] ? JSON.parse(previous[CLONE_PROOF].toString('utf8')) : null;
        const cloneBytes = clone ? Buffer.from(canonicalJSON({ ...clone, compatibility: { ...clone.compatibility,
          targetManifestSha256: artifacts.artifactManifestSha256 } }) + '\n') : null;
        const replaced = { 'descriptor.json': sha256(descriptorBytes), 'config/reviewed-plugins.json': sha256(plugins),
          ...(cloneBytes ? { [CLONE_PROOF]: sha256(cloneBytes) } : {}) };
        const rows = list => list.map(row => replaced[row.path] ? { ...row, sha256: replaced[row.path] } : row);
        const prepared = JSON.parse(previous['prepared.json'].toString('utf8'));
        const preparedBytes = Buffer.from(canonicalJSON({ ...prepared, descriptorSha256: replaced['descriptor.json'],
          artifactFiles: await Promise.all([artifacts.controllerBinary, artifacts.writerBinary, artifacts.artifactManifestPath]
            .map(async file => ({ path: absolute(file), sha256: await fileHashOwned(file) }))),
          immutableFiles: rows(prepared.immutableFiles), initialFiles: rows(prepared.initialFiles) }) + '\n');
        const next = { ...selected.selection, revision: selected.selection.revision + 1, transition: 'activate',
          reconciliationRequired: false, preparedManifestSha256: sha256(preparedBytes) };
        const rebound = { 'descriptor.json': descriptorBytes, 'config/reviewed-plugins.json': plugins, 'prepared.json': preparedBytes,
          ...(cloneBytes ? { [CLONE_PROOF]: cloneBytes } : {}) };
        const hashes = bytes => Object.fromEntries(files.map(file => [file, sha256(bytes[file])]));
        const intent = { schema: 1, protocol: REBIND_PROTOCOL, state: 'pending', bundleID,
          sourceSelection: selected.selection, selection: next, previous: hashes(previous), next: hashes(rebound) };
        await saveRebindIntent(controlRoot, intent);
        try {
          for (const file of files) await writeOwnedBytes(rebindCopy(controlRoot, file), previous[file]);
          await scope?.assertHeld?.();
          for (const file of files) await writeOwnedBytes(path.join(root, file), rebound[file]);
          await verify({ bundleID, phase: 'resume', allowOwnedContinuations: false });
          await scope?.assertHeld?.();
        } catch (error) {
          // Before the selector flips the previous documents still own the bundle.
          await restoreRebindFiles(controlRoot, intent);
          await saveRebindIntent(controlRoot, { ...intent, state: 'abandoned' });
          throw error;
        }
        await saveBundleJSON(path.join(controlRoot, 'selection.json'), next);
        await saveRebindIntent(controlRoot, { ...intent, state: 'committed' });
        return next;
      });
    });
  };
  /** Whether `value` is the committed selection of a rebind with a journaled previous launch. */
  const rebindRestorable = async value => {
    const intent = await readRebindIntent(controlRoot);
    return intent?.state === 'committed' && canonicalJSON(intent.selection) === canonicalJSON(value);
  };
  /** Rollback of an artifact rebind: the bundle returns to its previous launch documents. */
  const restoreRebind = async ({ expectedRevision }) => {
    const current = await readSelected();
    if (!current) throw fail('bundle_rollback_source_invalid');
    if (current.selection.revision !== expectedRevision) throw fail('bundle_selection_revision_conflict');
    await assertRebindable(current);
    if (!await rebindRestorable(current.selection)) throw fail('bundle_rollback_target_invalid');
    const previous = JSON.parse((await readOwnedBytes(rebindCopy(controlRoot, 'descriptor.json'))).toString('utf8'));
    const target = descriptor(controlRoot, current.descriptor.bundleID, previous);
    await verifyArtifacts({ generation: 2, launch: target.launch, purpose: 'bundle-rollback' });
    return options.withQuiescedSource({ kind: 'bundle', bundleID: current.descriptor.bundleID }, async (proof, scope) => {
      checkpoint(current.descriptor.launch, 2, proof);
      await scope?.assertHeld?.();
      return lock(path.join(controlRoot, 'selection.lock'), async () => {
        const selected = await readSelected(), intent = await readRebindIntent(controlRoot);
        if (canonicalJSON(selected?.selection) !== canonicalJSON(current.selection)) throw fail('bundle_selection_revision_conflict');
        if (intent?.state !== 'committed' || canonicalJSON(intent.selection) !== canonicalJSON(selected.selection)) throw fail('bundle_rollback_target_invalid');
        // The data is unchanged; only the journaled bytes must still be the previous launch.
        await verify({ bundleID: intent.bundleID, phase: 'resume', allowOwnedContinuations: false });
        for (const file of journaledFiles(intent)) if (sha256(await readOwnedBytes(rebindCopy(controlRoot, file))) !== intent.previous[file]) throw fail('bundle_rebind_recovery_changed');
        const restored = { ...selected.selection, revision: selected.selection.revision + 1, transition: 'rollback',
          reconciliationRequired: false, preparedManifestSha256: intent.previous['prepared.json'] };
        await scope?.assertHeld?.();
        // From here an interrupted restore is completed by startup recovery.
        await saveRebindIntent(controlRoot, { ...intent, state: 'restoring', restoreSelection: restored });
        await restoreRebindFiles(controlRoot, intent);
        await saveBundleJSON(path.join(controlRoot, 'selection.json'), restored);
        await saveRebindIntent(controlRoot, { ...intent, state: 'restored', restoreSelection: restored });
        return { selection: restored, admission: 'held', reason: null };
      });
    });
  };
  return {prepare,verify:({cloneSource:_cloneSource,...input})=>verify(input),readSelected,select,rollback,resume,restoreUnstartedClaude,rebindArtifacts,rebindRestorable,restoreRebind};
}
