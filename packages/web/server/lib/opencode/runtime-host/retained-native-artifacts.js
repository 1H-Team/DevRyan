import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {executionArtifacts} from '../execution-artifacts.js';
import {verifyNativeRuntimeArtifacts} from './native-artifacts.js';
import {withCrossProcessFileLock} from '../../../../../harness-runtime/lib/atomic-file.js';
import {isRecord,readBundleJSON} from './bundle-migration-inventory.js';
import {rollbackIntentPath} from './bundle-rollback-intent.js';
import {nativeArtifactInventoryLimit,validWindowsArtifactPath} from './reviewed-windows-git.js';

const fail=()=>Object.assign(new Error('bundle_artifact_retention_invalid'),{code:'bundle_artifact_retention_invalid',status:503});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const RETAINED_SET=/^[a-f0-9]{64}$/,ABANDONED=/^\.(?:retaining|pruning)-[a-f0-9-]{36}$/;
/** A set or abandoned copy younger than this is never removed: a retention that reused
 * or just created a set may not yet have written the bundle descriptor that references it. */
export const RETAINED_ARTIFACT_MINIMUM_AGE_MS=60*60_000;
const syncDirectory=async directory=>{const handle=await fs.open(directory,'r');try{await handle.sync();}catch{}finally{await handle.close();}};
// An owned, canonical, unlinked directory directly in parent, or null. Never follows a symlink.
const ownedDirectory=async(entry,parent)=>{
 let stat;try{stat=await fs.lstat(entry);}catch(error){if(error.code==='ENOENT')return null;throw error;}
 if(path.dirname(entry)!==parent||!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(entry)!==entry
  ||typeof process.getuid==='function'&&stat.uid!==process.getuid())return null;
 return stat;
};
/** Call under retention.lock: a live retention removes its own copy before releasing it. */
const sweepAbandoned=async(parent,now,minimumAgeMs,windowsOwner,windows=process.platform==='win32')=>{
 const swept=[];
 for(const name of await fs.readdir(parent)){
  if(!ABANDONED.test(name))continue;const entry=path.join(parent,name),stat=await ownedDirectory(entry,parent);
  if(!stat||now()-stat.mtimeMs<minimumAgeMs)continue;
  if(windows)await windowsOwner.removeTree(entry,await windowsOwner.tree(entry));
  else await fs.rm(entry,{recursive:true});swept.push(name);
 }
 return swept;
};
// Every reference must be readable; any doubt removes nothing.
const referencedSets=async (controlRoot,options={})=>{
 const readJSON=async file=>options.platform==='win32'?JSON.parse((await options.windowsOwner.read(file)).bytes.toString('utf8')):readBundleJSON(file,options);
 const keep=new Set(),artifacts=path.join(controlRoot,'artifacts');
 const reference=(value,{required=true}={})=>{if(typeof value==='string'&&RETAINED_SET.test(value))keep.add(value);else if(required)throw fail();};
 const launch=value=>{reference(value.artifactManifestSha256,{required:false});
  if(typeof value.artifactManifestPath==='string'&&path.dirname(path.dirname(value.artifactManifestPath))===artifacts)reference(path.basename(path.dirname(value.artifactManifestPath)));};
 const selection=await readJSON(path.join(controlRoot,'selection.json'));
 if(!isRecord(selection)||typeof selection.selectedBundleID!=='string'||!(selection.previousBundleID===null||typeof selection.previousBundleID==='string'))throw fail();
 const descriptors=new Map(),bundles=path.join(controlRoot,'bundles');
 for(const name of await fs.readdir(bundles)){
  if(name.startsWith('.'))continue;
  const value=await readJSON(path.join(bundles,name,'descriptor.json'));
  if(!isRecord(value)||value.bundleID!==name||!Number.isFinite(value.createdAt)||!isRecord(value.launch))throw fail();
  descriptors.set(name,value);
 }
 const selected=descriptors.get(selection.selectedBundleID);
 if(!selected||selection.previousBundleID!==null&&!descriptors.has(selection.previousBundleID))throw fail();
 // Selected, rollback target and every bundle prepared after the selected one (a pending upgrade).
 for(const [bundleID,value] of descriptors)if(bundleID===selection.selectedBundleID||bundleID===selection.previousBundleID||value.createdAt>=selected.createdAt)launch(value.launch);
 const optional=async file=>{try{return await readJSON(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
 const intent=await optional(rollbackIntentPath(controlRoot));
 if(intent!==null){if(!isRecord(intent))throw fail();reference(intent.candidateManifestSha256);reference(intent.targetManifestSha256);}
 for(const bundleID of [selection.selectedBundleID,selection.previousBundleID]){
  if(bundleID===null||!/^[a-zA-Z0-9_-]{1,128}$/.test(bundleID))continue;
  const baseline=await optional(path.join(controlRoot,'rollback',bundleID+'.json'));
  if(baseline!==null){if(!isRecord(baseline))throw fail();reference(baseline.targetManifestSha256);}
 }
 return keep;
};

/** Preserve the complete verified inventory before an application update replaces Resources. */
export async function retainNativeArtifacts({controlRoot,manifestPath,manifestSha256,verifyArtifacts=verifyNativeRuntimeArtifacts,windowsOwner,windowsLauncher,platform=process.platform}){
 const windows=platform==='win32';
 if(!path.isAbsolute(controlRoot)||!/^[a-f0-9]{64}$/.test(manifestSha256))throw fail();
 const source=path.dirname(manifestPath),verified=await verifyArtifacts({manifestPath,manifestSha256,launcher:executionArtifacts(source).launcher});
 const bytes=await fs.readFile(manifestPath);if(hash(bytes)!==manifestSha256)throw fail();
 // Read the verified bytes, rather than an optional verifier's returned metadata.
 let manifest;try{manifest=JSON.parse(bytes);}catch{throw fail();}
 if(!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>nativeArtifactInventoryLimit(manifest,platform,process.arch))throw fail();
 const seen=new Set(),foldedPaths=new Set();
 for(const row of manifest.files){
  if(!row||typeof row.path!=='string'||path.isAbsolute(row.path)||row.path.split(/[\\/]/).some(part=>!part||part==='.'||part==='..')
   ||seen.has(row.path)||!/^[a-f0-9]{64}$/.test(row.sha256)||!Number.isSafeInteger(row.size)||row.size<0
   ||!Number.isInteger(row.mode)||row.mode<0||row.mode>0o777)throw fail();seen.add(row.path);
  if(windows){const folded=row.path.toLowerCase();if(!validWindowsArtifactPath(row.path)||foldedPaths.has(folded))throw fail();foldedPaths.add(folded);}
 }
 const parent=path.join(controlRoot,'artifacts');
 if(windows){
  if(!windowsLauncher||typeof windowsOwner?.streamFile!=='function'||typeof windowsOwner?.tree!=='function'||typeof windowsOwner?.renameTree!=='function'||typeof windowsOwner?.removeTree!=='function')throw fail();
  await windowsOwner.ensureDirectory(parent);
 }else{await fs.mkdir(parent,{recursive:true,mode:0o700});if(await fs.realpath(parent)!==parent)throw fail();await fs.chmod(parent,0o700);}
 const target=path.join(parent,manifestSha256);
 return withCrossProcessFileLock(path.join(parent,'retention.lock'),async()=>{
  const validate=async directory=>{
   if(await fs.realpath(directory)!==directory)throw fail();
   for(const row of manifest.files){const file=path.join(directory,row.path);
    if(windows){const proof=await windowsOwner.largeFile(file);if(proof.size!==row.size||proof.token.split(':')[2]!==row.sha256)throw fail();continue;}
    const stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||await fs.realpath(file)!==file||stat.size!==row.size||(stat.mode&0o777)!==row.mode||hash(await fs.readFile(file))!==row.sha256)throw fail();}
   const file=path.join(directory,'native-bundle.json');
   if(windows){const proof=await windowsOwner.read(file);if(hash(proof.bytes)!==manifestSha256)throw fail();}
   else{const stat=await fs.lstat(file);
   if(!stat.isFile()||stat.isSymbolicLink()||await fs.realpath(file)!==file||(stat.mode&0o777)!==0o600||hash(await fs.readFile(file))!==manifestSha256)throw fail();}
   return verifyArtifacts({manifestPath:file,manifestSha256,launcher:executionArtifacts(directory).launcher});
  };
  await sweepAbandoned(parent,Date.now,RETAINED_ARTIFACT_MINIMUM_AGE_MS,windowsOwner,windows);
  // A reused set is about to be referenced again; restart its pruning age.
  try{const retained=await validate(target);
   if(windows)await windowsOwner.write(path.join(target,'.DevRyan-retained-reference.json'),Buffer.from(JSON.stringify({referencedAt:Date.now()})+'\n'));
   else{const now=new Date();await fs.utimes(target,now,now);}return retained;}catch(error){if(error.code!=='ENOENT')throw error;}
  const temporary=path.join(parent,`.retaining-${randomUUID()}`);
  if(windows)await windowsOwner.ensureDirectory(temporary);else await fs.mkdir(temporary,{mode:0o700});
  try{
   for(const row of manifest.files){const file=path.join(source,row.path);
    if(windows){const destination=path.join(temporary,row.path);await windowsOwner.ensureDirectory(path.dirname(destination));
     await windowsOwner.streamFile(file,destination,{expectedSha256:row.sha256,expectedSize:row.size});continue;}
    const stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||await fs.realpath(file)!==file||stat.size!==row.size||hash(await fs.readFile(file))!==row.sha256)throw fail();
    const destination=path.join(temporary,row.path);await fs.mkdir(path.dirname(destination),{recursive:true,mode:0o700});
    await fs.copyFile(file,destination,fs.constants.COPYFILE_EXCL);await fs.chmod(destination,row.mode);
   }
   if(windows)await windowsOwner.write(path.join(temporary,'native-bundle.json'),bytes,{expected:null});
   else await fs.writeFile(path.join(temporary,'native-bundle.json'),bytes,{flag:'wx',mode:0o600});
   await validate(temporary);
   if(windows)await windowsOwner.renameTree(temporary,target,await windowsOwner.tree(temporary));else await fs.rename(temporary,target);
  }finally{
   if(windows){let present;try{present=await fs.lstat(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(present)await windowsOwner.removeTree(temporary,await windowsOwner.tree(temporary));}
   else await fs.rm(temporary,{recursive:true,force:true});
  }
  const retained=await validate(target);
  if(path.basename(retained.controller??verified.controller)!==path.basename(verified.controller)||path.basename(retained.writer??verified.writer)!==path.basename(verified.writer))throw fail();
  return retained;
 },{windowsLauncher});
}

/** Call only at a safe point of a selected, unheld install, outside any lifecycle
 * operation. Removes retained sets no selected, rollback-target, newer draft, rollback
 * intent or rollback baseline references, plus abandoned `.retaining-*`/`.pruning-*` copies. */
export async function pruneRetainedNativeArtifacts({controlRoot,now=Date.now,minimumAgeMs=RETAINED_ARTIFACT_MINIMUM_AGE_MS,windowsOwner,windowsLauncher,platform=process.platform}){
 const windows=platform==='win32';
 if(!path.isAbsolute(controlRoot)||path.normalize(controlRoot)!==controlRoot)throw fail();
 const parent=path.join(controlRoot,'artifacts');
 if(!await ownedDirectory(parent,controlRoot)){try{await fs.lstat(parent);}catch(error){if(error.code==='ENOENT')return {pruned:[],swept:[]};throw error;}throw fail();}
 return withCrossProcessFileLock(path.join(parent,'retention.lock'),async()=>{
  const swept=await sweepAbandoned(parent,now,minimumAgeMs,windowsOwner,windows);
  const keep=await referencedSets(controlRoot,{windowsOwner,platform}).catch(error=>{throw error.code==='ENOENT'||error.code==='bundle_document_invalid'||error instanceof SyntaxError?fail():error;});
  const pruned=[];
  for(const name of (await fs.readdir(parent)).sort()){
   if(!RETAINED_SET.test(name)||keep.has(name))continue;
   const entry=path.join(parent,name),stat=await ownedDirectory(entry,parent);
   if(!stat||now()-stat.mtimeMs<minimumAgeMs)continue;
   // Never remove in place: an interrupted removal leaves only a `.pruning-*` copy a later pass sweeps.
   const aside=path.join(parent,`.pruning-${randomUUID()}`);
   if(windows){if(!windowsLauncher||typeof windowsOwner?.renameTree!=='function'||typeof windowsOwner?.removeTree!=='function')throw fail();
    const token=await windowsOwner.renameTree(entry,aside,await windowsOwner.tree(entry));await windowsOwner.removeTree(aside,token);}
   else{await fs.rename(entry,aside);await syncDirectory(parent);await fs.rm(aside,{recursive:true});}pruned.push(name);
  }
  return {pruned,swept};
 },{windowsLauncher});
}
