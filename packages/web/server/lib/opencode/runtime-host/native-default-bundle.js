import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomBytes} from 'node:crypto';
import {executionArtifacts} from '../execution-artifacts.js';
import {resolveSqliteDriver} from '../db-maintenance-core.js';
import {DEVRYAN_MANAGED_PLUGINS} from '../managed-plugins.js';
import {verifyNativeRuntimeArtifacts} from './native-artifacts.js';
import {runNativeMigrationProcess} from './native-migration-process.js';
import {createRuntimeBundleStore} from './runtime-bundle.js';
import {createRuntimeBundleCheckpoint} from './bundle-checkpoint.js';
import {withCrossProcessFileLock} from '../../../../../harness-runtime/lib/atomic-file.js';
import {seedNativeSetup} from './native-setup-seed.js';
import {readRuntimeBundleBinding} from './runtime-bundle-binding.js';
import {retainNativeArtifacts} from './retained-native-artifacts.js';
import {protectNativeSetupSource,removeNativeSetupSource,resetAbandonedNativeSetupSource,sweepRemovedNativeSetupSources} from './native-setup-source.js';
import {canonicalJSON,isRecord,readBundleJSON,sha256} from './bundle-migration-inventory.js';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=code=>Object.assign(new Error(code),{code,status:503});
// A live holder may be provisioning the real artifacts (retention copy, several
// artifact verifications, a migration spawn); a dead holder is reclaimed at once.
const BOOTSTRAP_LOCK_TIMEOUT_MS=5*60_000;
const exists=async file=>{try{await fs.lstat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
const nativePluginIDs={
 '@rama_nigg/open-cursor':['devryan.provider-compat'], 'opencode-with-claude':['devryan.provider-compat'],
 'opencode-gpt-imagegen':['opencode-gpt-imagegen'], 'oh-my-opencode-slim':['devryan.slim','devryan.slim-commands','devryan.slim-lifecycle'],
 superpowers:['devryan.reviewed-skills'],'devryan-skill-context':['devryan.reviewed-skills'],'devryan-document-reader':['devryan.document-reader'],
};
const syncDirectory=async directory=>{const handle=await fs.open(directory,'r');try{await handle.sync();}catch{}finally{await handle.close();}};
const owned=async(directory,parent)=>{
 const stat=await fs.lstat(directory);
 if(path.dirname(directory)!==parent||!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(directory)!==directory
  ||typeof process.getuid==='function'&&stat.uid!==process.getuid())throw fail('bundle_path_invalid');
};
/** Call inside the bootstrap lock, only while no selection.json exists. Before any
 * selection nothing under bundles/ is user data: v1 sources are only read and v2
 * conversations exist only after selection. store.prepare resumes a default draft
 * only when its sources/preparation.json seals this exact input (whose hash covers
 * the artifact manifest, source paths and project map); any other draft, such as an
 * interrupted copy or one sealed by an earlier build or cwd, fails every launch.
 * So does a matching draft whose prepared.json no longer verifies (changed after
 * its seal); it is reset, never trusted. Remove it with the source files derived
 * from its manifest and cwd. */
const resetStaleDefaultDraft=async({controlRoot,sourceRoot,inputSha256,verifySealed})=>{
 const bundles=path.join(controlRoot,'bundles'),root=path.join(bundles,'default-native');
 if(await exists(root)){
  await owned(bundles,controlRoot);await owned(root,bundles);
  let draft;try{draft=await readBundleJSON(path.join(root,'sources','preparation.json'));}
  catch(error){if(!['ENOENT','ENOTDIR','bundle_document_invalid'].includes(error.code)&&!(error instanceof SyntaxError))throw error;}
  if(isRecord(draft)&&draft.schema===1&&draft.inputSha256===inputSha256){
   if(!await exists(path.join(root,'prepared.json')))return false;
   try{await verifySealed();return false;}catch{}
  }
 }
 for(const name of ['reviewed-native.json','reviewed-plugins.json']){
  const file=path.join(sourceRoot,name);if(!await exists(file))continue;
  await owned(sourceRoot,path.dirname(controlRoot));const stat=await fs.lstat(file);
  if(!stat.isFile()||typeof process.getuid==='function'&&stat.uid!==process.getuid())throw fail('bundle_path_invalid');
  await fs.rm(file);
 }
 if(!await exists(root))return false;
 // Never remove in place: an interrupted removal leaves only a sibling the next launch sweeps.
 const stale=path.join(bundles,`.stale-${randomBytes(8).toString('hex')}`);
 await fs.rename(root,stale);await syncDirectory(bundles);
 await fs.rm(stale,{recursive:true});return true;
};
/** Call inside the bootstrap lock, only while no selection.json exists, before any
 * draft or seed decision: the abandoned-seed reset refuses while any bundles/* entry exists. */
const sweepStaleDrafts=async controlRoot=>{
 const bundles=path.join(controlRoot,'bundles');let names;
 try{names=(await fs.readdir(bundles)).filter(name=>name.startsWith('.stale-'));}catch(error){if(error.code==='ENOENT')return;throw error;}
 if(names.length)await owned(bundles,controlRoot);
 for(const name of names){const entry=path.join(bundles,name);await owned(entry,bundles);await fs.rm(entry,{recursive:true});}
};
export function defaultNativeRegistrations(origins) {
 return origins.map(origin=>({...origin,legacySpecs:DEVRYAN_MANAGED_PLUGINS.filter(plugin=>nativePluginIDs[plugin.id]?.includes(origin.id))
  .flatMap(plugin=>[plugin.registrationPath,...plugin.legacySpecs,...plugin.legacyRegistrationPaths]),
 }));
}

/** Called by the application entrypoint before importing data owners.
 * Old conversations and journals are not imported. Existing native selections
 * retain their complete state; setup seeding applies only to the first bundle.
 * Constructor seams are for disposable fixtures, never environment metadata.
 */
export async function provisionDefaultNativeBundle({env=process.env,home=os.homedir(),cwd=process.cwd(),
 artifactDirectory=executionArtifacts().directory,verifyArtifacts=verifyNativeRuntimeArtifacts,runMigration,
 defaultConfigRoot=new URL('../../../default-config/',import.meta.url),captureLogicalSetup}={}) {
 if(env.OPENCODE_DB!==undefined&&!path.isAbsolute(env.OPENCODE_DB)||env.OPENCODE_HOST||env.OPENCODE_SKIP_START==='true'||env.OPENCHAMBER_SKIP_OPENCODE_START==='true'||env.OPENCODE_BINARY
  ||env.DEVRYAN_OPENCODE_GENERATION!==undefined&&env.DEVRYAN_OPENCODE_GENERATION!=='2')throw fail('native_runtime_configuration_unsupported');
 if(env.DEVRYAN_RUNTIME_BUNDLE_ROOT!==undefined)return env.DEVRYAN_RUNTIME_BUNDLE_ROOT;
 const dataRoot=path.resolve(env.OPENCHAMBER_DATA_DIR||path.join(home,'.config','openchamber'));
 const controlRoot=path.resolve(env.XDG_STATE_HOME||path.join(home,'.local','state'),'devryan','runtime-bundles');
 const sourceRoot=path.join(path.dirname(controlRoot),'fresh-native-source');
 await fs.mkdir(controlRoot,{recursive:true,mode:0o700});
 if(await fs.realpath(controlRoot)!==controlRoot)throw fail('bundle_path_invalid');
 await fs.chmod(controlRoot,0o700);
 return withCrossProcessFileLock(path.join(controlRoot,'bootstrap.lock'),async()=>{
  await sweepRemovedNativeSetupSources({controlRoot,sourceRoot});
  if(await exists(path.join(controlRoot,'selection.json'))){
   const selected=readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:controlRoot},{allowHeldInspection:true});
   if(selected.admission!=='held'&&!selected.selection.reconciliationRequired&&await exists(sourceRoot))await removeNativeSetupSource({controlRoot,sourceRoot,verifySelected:async()=>{
    const store=createRuntimeBundleStore({controlRoot,allowRecoveredInputStartup:true,runMigration:async()=>{throw fail('bundle_migration_generation_invalid');},
     withQuiescedSource:async()=>{throw fail('bundle_quiescence_unverified');},
     verifyArtifacts:async({launch:value})=>{const verified=await verifyArtifacts({manifestPath:value.artifactManifestPath,manifestSha256:value.artifactManifestSha256,launcher:executionArtifacts(path.dirname(value.artifactManifestPath)).launcher});
      if(verified.controller!==value.controllerBinary||verified.writer!==value.writerBinary)throw fail('bundle_artifact_generation_mismatch');}});
    await store.verify({bundleID:selected.descriptor.bundleID,phase:'resume'});
   }});
   return controlRoot;
  }
  await sweepStaleDrafts(controlRoot);
  const manifestPath=path.join(artifactDirectory,'native-bundle.json');
  const manifestStat=await fs.lstat(manifestPath).catch(()=>{throw fail('native_runtime_artifacts_unverified');});
  if(!manifestStat.isFile()||manifestStat.isSymbolicLink()||manifestStat.size>4*1024*1024)throw fail('native_runtime_artifacts_unverified');
  const manifestBytes=await fs.readFile(manifestPath);
  if(manifestBytes.length>4*1024*1024)throw fail('native_runtime_artifacts_unverified');
  const manifestSha256=hash(manifestBytes),launcher=executionArtifacts(artifactDirectory).launcher;
  await verifyArtifacts({manifestPath,manifestSha256,launcher});
  const artifacts=await retainNativeArtifacts({controlRoot,manifestPath,manifestSha256,verifyArtifacts});
  const retainedManifestPath=artifacts.manifestPath;
  const retainedLauncher=artifacts.launcher;
  const launch={opencodeDatabasePath:path.join(sourceRoot,'empty.db'),webDataDirectory:path.join(sourceRoot,'web-data'),
   webConfigDirectory:path.join(sourceRoot,'web-config'),opencodeConfigDirectory:path.join(sourceRoot,'opencode-config'),global:{home:path.join(sourceRoot,'home')}};
  const directory=await fs.realpath(cwd);
  const reviewedNativeConfigPath=path.join(sourceRoot,'reviewed-native.json'),reviewedPluginManifestPath=path.join(sourceRoot,'reviewed-plugins.json');
  const launchArtifacts={controllerBinary:artifacts.controller,writerBinary:artifacts.writer,artifactManifestPath:retainedManifestPath,
   artifactManifestSha256:manifestSha256,reviewedNativeConfigPath,reviewedPluginManifestPath};
  const input={bundleID:'default-native',generation:2,source:{kind:'legacy',launch},projectMap:[{sourceDirectory:directory,targetDirectory:directory,mode:'identity'}],auxiliary:{kind:'absent'},launchArtifacts};
  const checkpoint=createRuntimeBundleCheckpoint({ownerID:'fresh-source',generation:1,launch,neverStarted:true,
   closeAdmission:async()=>{},getController:()=>null,stopProducers:async()=>{},drainStores:async()=>{},executionHost:{drain:async()=>{}}});
  const importer=runMigration??(request=>runNativeMigrationProcess({binary:artifacts.controller,cwd:sourceRoot,request,
   environment:{PATH:env.PATH,LANG:env.LANG||'en_US.UTF-8',HOME:path.join(request.isolatedRoot,'home'),
    XDG_CONFIG_HOME:path.join(request.isolatedRoot,'config'),XDG_DATA_HOME:path.join(request.isolatedRoot,'data'),
    XDG_STATE_HOME:path.join(request.isolatedRoot,'state'),XDG_CACHE_HOME:path.join(request.isolatedRoot,'cache'),TMPDIR:path.join(request.isolatedRoot,'tmp')},
   beforeSpawn:()=>verifyArtifacts({manifestPath:retainedManifestPath,manifestSha256,launcher:retainedLauncher})}));
  let candidate;
  const store=createRuntimeBundleStore({controlRoot,runMigration:importer,
   verifyArtifacts:async({generation,launch:value})=>{
    if(generation!==2)throw fail('bundle_artifact_generation_mismatch');
    const verified=await verifyArtifacts({manifestPath:value.artifactManifestPath,manifestSha256:value.artifactManifestSha256,launcher:executionArtifacts(path.dirname(value.artifactManifestPath)).launcher});
    if(verified.controller!==value.controllerBinary||verified.writer!==value.writerBinary)throw fail('bundle_artifact_generation_mismatch');
   },withQuiescedSource:(source,action)=>{
   if(source.kind==='legacy')return checkpoint(source,action);
   if(source.bundleID!==candidate?.bundleID)throw fail('bundle_checkpoint_source_mismatch');
   return createRuntimeBundleCheckpoint({ownerID:candidate.bundleID,generation:2,launch:candidate.launch,neverStarted:true,
    closeAdmission:async()=>{},getController:()=>null,stopProducers:async()=>{},drainStores:async()=>{},executionHost:{drain:async()=>{}}})(source,action);
  }});
  // No selection exists here. A stale draft goes first: the abandoned-seed reset
  // below refuses while any bundles/* entry exists.
  await resetStaleDefaultDraft({controlRoot,sourceRoot,inputSha256:sha256(canonicalJSON(input)),verifySealed:()=>store.verify({bundleID:input.bundleID,phase:'prepared'})});
  // A stamped seed that never pinned its marker is reseeded.
  await resetAbandonedNativeSetupSource({controlRoot,sourceRoot});
  await protectNativeSetupSource({controlRoot,sourceRoot});
  for(const directory of [launch.webDataDirectory,launch.webConfigDirectory,launch.opencodeConfigDirectory,launch.global.home])await fs.mkdir(directory,{recursive:true,mode:0o700});
  // Only this privately created source is eligible for an automatic checkpoint.
  if(!await exists(launch.opencodeDatabasePath)){await fs.writeFile(launch.opencodeDatabasePath,'',{flag:'wx',mode:0o600});const db=resolveSqliteDriver().open(launch.opencodeDatabasePath);db.close();await fs.chmod(launch.opencodeDatabasePath,0o600);}
  await seedNativeSetup({source:{webDataDirectory:dataRoot,webConfigDirectory:path.join(home,'.config','openchamber'),
   opencodeConfigDirectory:path.resolve(env.OPENCODE_CONFIG_DIR||path.join(env.XDG_CONFIG_HOME||path.join(home,'.config'),'opencode')),
   opencodeConfigFile:env.OPENCODE_CONFIG?path.resolve(env.OPENCODE_CONFIG):undefined,
   opencodeDataDirectory:path.resolve(env.XDG_DATA_HOME||path.join(home,'.local','share'),'opencode'),home},target:launch,environment:env,captureLogicalSetup});
  if(!await exists(path.join(launch.opencodeConfigDirectory,'opencode.json')))await fs.copyFile(new URL('opencode.json',defaultConfigRoot),path.join(launch.opencodeConfigDirectory,'opencode.json'));
  if(!await exists(reviewedNativeConfigPath))await fs.writeFile(reviewedNativeConfigPath,JSON.stringify({schema:1,configuration:{},
   catalogRequirements:{agents:[],models:[],plugins:[],tools:[]},locations:[{directory,readRoots:[directory],protectedRoots:[controlRoot,dataRoot]}]})+'\n',{mode:0o600});
  if(!await exists(reviewedPluginManifestPath))await fs.writeFile(reviewedPluginManifestPath,JSON.stringify({schema:1,
   plugins:defaultNativeRegistrations(artifacts.manifest.inputs.reviewedPlugins)})+'\n',{mode:0o600});
  // This includes copied defaults created by copyFile, before any native spawn.
  await protectNativeSetupSource({controlRoot,sourceRoot});
  candidate=await store.prepare(input);
  await store.select({bundleID:candidate.bundleID,expectedRevision:0});
  await removeNativeSetupSource({controlRoot,sourceRoot,verifySelected:async()=>{
   const selected=await store.readSelected();if(selected?.descriptor.bundleID!==candidate.bundleID)throw fail('bundle_selection_revision_conflict');
   await store.verify({bundleID:candidate.bundleID,phase:'resume'});
  }});
  return controlRoot;
 },{timeoutMs:BOOTSTRAP_LOCK_TIMEOUT_MS});
}
