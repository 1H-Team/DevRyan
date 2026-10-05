import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {saveBundleJSON,readBundleJSON} from './bundle-migration-inventory.js';
import {BUNDLE_DOCUMENT_MAX_BYTES} from './bundle-document-limits.js';
// One budget for writing (native-setup-seed.js) and re-verifying the pinned seed.
export const NATIVE_SETUP_SEED_MAX_FILES=4096,NATIVE_SETUP_SEED_MAX_FILE_BYTES=1024*1024,NATIVE_SETUP_SEED_MAX_TOTAL_BYTES=16*1024*1024,NATIVE_SETUP_SEED_MAX_MARKER_BYTES=BUNDLE_DOCUMENT_MAX_BYTES;
// Finder/AppleDouble metadata is never setup and never ownership evidence.
export const isNativeSetupOSMetadata=name=>name==='.DS_Store'||name==='Icon\r'||name.startsWith('._');
const fail=()=>Object.assign(new Error('native_setup_source_ownership_invalid'),{code:'native_setup_source_ownership_invalid',status:503});
const ownerFile='.devryan-fresh-source.json';
const verifySeed=async sourceRoot=>{
 const saved=await readBundleJSON(path.join(sourceRoot,'web-data','native-setup-seed.json'));
 if(saved?.schema!==1||!Array.isArray(saved.files)||saved.files.length>NATIVE_SETUP_SEED_MAX_FILES)throw fail();
 const seen=new Set();let total=0;
 for(const row of saved.files){
  if(!row||typeof row.path!=='string'||!row.path.startsWith(sourceRoot+path.sep)||seen.has(row.path)||!/^[a-f0-9]{64}$/.test(row.sha256))throw fail();
  const stat=await fs.lstat(row.path);
  if(!stat.isFile()||stat.isSymbolicLink()||await fs.realpath(row.path)!==row.path||stat.size>NATIVE_SETUP_SEED_MAX_FILE_BYTES||(total+=stat.size)>NATIVE_SETUP_SEED_MAX_TOTAL_BYTES
    ||createHash('sha256').update(await fs.readFile(row.path)).digest('hex')!==row.sha256)throw fail();
  seen.add(row.path);
 }
};
/** A 2.0.0 removal deleted the verified seed in place, so an interruption left a
 * canonical tree whose marker or pinned files are partly gone while no remaining
 * pinned byte changed. A complete, changed or unreadable seed is not partial. */
const partiallyRemoved=async sourceRoot=>{
 let saved;try{saved=await readBundleJSON(path.join(sourceRoot,'web-data','native-setup-seed.json'));}
 catch(error){if(error.code==='ENOENT')return true;if(error.code==='bundle_document_invalid'||error instanceof SyntaxError)return false;throw error;}
 if(saved?.schema!==1||!Array.isArray(saved.files)||saved.files.length>NATIVE_SETUP_SEED_MAX_FILES)return false;
 let gone=false;
 for(const row of saved.files){
  if(!row||typeof row.path!=='string'||!row.path.startsWith(sourceRoot+path.sep)||!/^[a-f0-9]{64}$/.test(row.sha256))return false;
  let stat;try{stat=await fs.lstat(row.path);}catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR'){gone=true;continue;}throw error;}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>NATIVE_SETUP_SEED_MAX_FILE_BYTES
   ||createHash('sha256').update(await fs.readFile(row.path)).digest('hex')!==row.sha256)return false;
 }
 return gone;
};

/** The sibling seed contains credentials. Verify ownership before repairing old modes. */
export async function protectNativeSetupSource({controlRoot,sourceRoot}){
 if(sourceRoot!==path.join(path.dirname(controlRoot),'fresh-native-source')||!path.isAbsolute(sourceRoot))throw fail();
 if(await fs.realpath(path.dirname(sourceRoot))!==path.dirname(sourceRoot))throw fail();
 await fs.mkdir(sourceRoot,{recursive:true,mode:0o700});
 const allowed=new Set([ownerFile,'empty.db','empty.db-wal','empty.db-shm','web-data','web-config','opencode-config','home','reviewed-native.json','reviewed-plugins.json']);
 if((await fs.readdir(sourceRoot)).some(name=>!allowed.has(name)&&!isNativeSetupOSMetadata(name)))throw fail();
 const walk=async directory=>{
  const stat=await fs.lstat(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(directory)!==directory||typeof process.getuid==='function'&&stat.uid!==process.getuid())throw fail();
  await fs.chmod(directory,0o700);
  for(const name of await fs.readdir(directory)){
   const file=path.join(directory,name),item=await fs.lstat(file);
   if(item.isSymbolicLink()||typeof process.getuid==='function'&&item.uid!==process.getuid())throw fail();
   if(item.isDirectory())await walk(file);
   else if(item.isFile())await fs.chmod(file,0o600);
   else throw fail();
  }
 };
 await walk(sourceRoot);
 const file=path.join(sourceRoot,ownerFile);let saved;
 try{saved=await readBundleJSON(file);}catch(error){if(error.code!=='ENOENT')throw error;}
 if(saved&&(saved.schema!==1||saved.controlRoot!==controlRoot||saved.sourceRoot!==sourceRoot))throw fail();
 if(!saved)await saveBundleJSON(file,{schema:1,controlRoot,sourceRoot});
}

const missing=async file=>{try{await fs.lstat(file);return false;}catch(error){if(error.code==='ENOENT')return true;throw error;}};
/** Call inside the bootstrap lock before protecting/seeding a first bundle. A
 * stamped seed without its pinned marker, with no selection and no prepared
 * draft, is an abandoned first attempt: no candidate or selection can reference
 * it. Remove only its seeded trees so the retry reseeds current owner setup.
 * Every other partial state keeps the identical-retry rule. */
export async function resetAbandonedNativeSetupSource({controlRoot,sourceRoot}){
 if(sourceRoot!==path.join(path.dirname(controlRoot),'fresh-native-source')||!path.isAbsolute(sourceRoot))throw fail();
 if(await missing(sourceRoot))return false;
 let saved;try{saved=await readBundleJSON(path.join(sourceRoot,ownerFile));}catch(error){if(error.code!=='ENOENT')throw error;}
 if(saved&&(saved.schema!==1||saved.controlRoot!==controlRoot||saved.sourceRoot!==sourceRoot))return false;
 // An unpinned stamped seed is an abandoned first attempt. An unstamped unpinned one, or a
 // pinned one with files gone but none changed, is a half-deleted 2.0.0 seed: rebuild it.
 const marker=!await missing(path.join(sourceRoot,'web-data','native-setup-seed.json'));
 if(marker?!await partiallyRemoved(sourceRoot):false)return false;
 if(!await missing(path.join(controlRoot,'selection.json')))return false;
 let drafts=[];try{drafts=await fs.readdir(path.join(controlRoot,'bundles'));}catch(error){if(error.code!=='ENOENT')throw error;}
 if(drafts.length)return false;
 // Ownership, canonical location, uid and no-symlink checks for the whole tree.
 await protectNativeSetupSource({controlRoot,sourceRoot});
 for(const name of ['web-data','web-config','opencode-config','home']){
  const directory=path.join(sourceRoot,name);let stat;try{stat=await fs.lstat(directory);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  if(!stat.isDirectory()||stat.isSymbolicLink()||path.dirname(directory)!==sourceRoot||await fs.realpath(directory)!==directory||typeof process.getuid==='function'&&stat.uid!==process.getuid())throw fail();
  await fs.rm(directory,{recursive:true});
 }
 return true;
}

const removing=/^\.fresh-native-source\.removing-[a-f0-9]{16}$/;
const syncDirectory=async directory=>{const handle=await fs.open(directory,'r');try{await handle.sync();}catch{}finally{await handle.close();}};
/** Call inside the bootstrap lock on every launch, selected or not. A removal
 * renames the verified seed to a sibling first, so its canonical path is either
 * complete or absent; only a validated renamed sibling is swept, never re-verified. */
export async function sweepRemovedNativeSetupSources({controlRoot,sourceRoot}){
 if(sourceRoot!==path.join(path.dirname(controlRoot),'fresh-native-source')||!path.isAbsolute(sourceRoot))throw fail();
 const parent=path.dirname(sourceRoot);let names;
 try{names=(await fs.readdir(parent)).filter(name=>removing.test(name));}catch(error){if(error.code==='ENOENT')return;throw error;}
 for(const name of names){
  const entry=path.join(parent,name),stat=await fs.lstat(entry);
  if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(entry)!==entry||typeof process.getuid==='function'&&stat.uid!==process.getuid())throw fail();
  await fs.rm(entry,{recursive:true});
 }
}

/** Call only after full candidate verification and committed selection. */
export async function removeNativeSetupSource({controlRoot,sourceRoot,verifySelected}){
 if(typeof verifySelected!=='function')throw fail();
 try{await fs.lstat(sourceRoot);}catch(error){if(error.code==='ENOENT')return;throw error;}
 await verifySelected();
 let saved;try{saved=await readBundleJSON(path.join(sourceRoot,ownerFile));}catch(error){if(error.code!=='ENOENT')throw error;}
 // A half-deleted 2.0.0 seed no selected bundle needs: finish its removal once the
 // whole canonical tree is proved owned, unlinked and private, instead of refusing every launch.
 if(await partiallyRemoved(sourceRoot)){
  if(saved&&(saved.schema!==1||saved.controlRoot!==controlRoot||saved.sourceRoot!==sourceRoot))throw fail();
  await protectNativeSetupSource({controlRoot,sourceRoot});
  return removeAside(sourceRoot);
 }
 // Earlier valid seed roots did not have the owner stamp. Adopt only the
 // canonical private tree with a complete pinned seed and selected candidate.
 if(!saved){await verifySeed(sourceRoot);await protectNativeSetupSource({controlRoot,sourceRoot});saved=await readBundleJSON(path.join(sourceRoot,ownerFile));}
 if(saved.schema!==1||saved.controlRoot!==controlRoot||saved.sourceRoot!==sourceRoot
  ||sourceRoot!==path.join(path.dirname(controlRoot),'fresh-native-source'))throw fail();
 await protectNativeSetupSource({controlRoot,sourceRoot});
 await verifySeed(sourceRoot);
 await removeAside(sourceRoot);
}
// Never remove in place: an interrupted removal leaves only a sibling the next launch sweeps.
const removeAside=async sourceRoot=>{
 const parent=path.dirname(sourceRoot),renamed=path.join(parent,`.fresh-native-source.removing-${randomBytes(8).toString('hex')}`);
 await fs.rename(sourceRoot,renamed);await syncDirectory(parent);
 await fs.rm(renamed,{recursive:true});
};
