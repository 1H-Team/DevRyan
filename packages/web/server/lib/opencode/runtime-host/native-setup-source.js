import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {saveBundleJSON,readBundleJSON} from './bundle-migration-inventory.js';
const fail=()=>Object.assign(new Error('native_setup_source_ownership_invalid'),{code:'native_setup_source_ownership_invalid',status:503});
const ownerFile='.devryan-fresh-source.json';
const verifySeed=async sourceRoot=>{
 const saved=await readBundleJSON(path.join(sourceRoot,'web-data','native-setup-seed.json'));
 if(saved?.schema!==1||!Array.isArray(saved.files)||saved.files.length>4096)throw fail();
 const seen=new Set();let total=0;
 for(const row of saved.files){
  if(!row||typeof row.path!=='string'||!row.path.startsWith(sourceRoot+path.sep)||seen.has(row.path)||!/^[a-f0-9]{64}$/.test(row.sha256))throw fail();
  const stat=await fs.lstat(row.path);
  if(!stat.isFile()||stat.isSymbolicLink()||await fs.realpath(row.path)!==row.path||stat.size>1024*1024||(total+=stat.size)>16*1024*1024
    ||createHash('sha256').update(await fs.readFile(row.path)).digest('hex')!==row.sha256)throw fail();
  seen.add(row.path);
 }
};

/** The sibling seed contains credentials. Verify ownership before repairing old modes. */
export async function protectNativeSetupSource({controlRoot,sourceRoot}){
 if(sourceRoot!==path.join(path.dirname(controlRoot),'fresh-native-source')||!path.isAbsolute(sourceRoot))throw fail();
 if(await fs.realpath(path.dirname(sourceRoot))!==path.dirname(sourceRoot))throw fail();
 await fs.mkdir(sourceRoot,{recursive:true,mode:0o700});
 const allowed=new Set([ownerFile,'empty.db','empty.db-wal','empty.db-shm','web-data','web-config','opencode-config','home','reviewed-native.json','reviewed-plugins.json']);
 if((await fs.readdir(sourceRoot)).some(name=>!allowed.has(name)))throw fail();
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
 let saved;try{saved=await readBundleJSON(path.join(sourceRoot,ownerFile));}catch(error){if(error.code==='ENOENT')return false;throw error;}
 if(saved?.schema!==1||saved.controlRoot!==controlRoot||saved.sourceRoot!==sourceRoot)return false;
 if(!await missing(path.join(sourceRoot,'web-data','native-setup-seed.json'))||!await missing(path.join(controlRoot,'selection.json')))return false;
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

/** Call only after full candidate verification and committed selection. */
export async function removeNativeSetupSource({controlRoot,sourceRoot,verifySelected}){
 if(typeof verifySelected!=='function')throw fail();
 try{await fs.lstat(sourceRoot);}catch(error){if(error.code==='ENOENT')return;throw error;}
 await verifySelected();
 let saved;try{saved=await readBundleJSON(path.join(sourceRoot,ownerFile));}catch(error){if(error.code!=='ENOENT')throw error;}
 // Earlier valid seed roots did not have the owner stamp. Adopt only the
 // canonical private tree with a complete pinned seed and selected candidate.
 if(!saved){await verifySeed(sourceRoot);await protectNativeSetupSource({controlRoot,sourceRoot});saved=await readBundleJSON(path.join(sourceRoot,ownerFile));}
 if(saved.schema!==1||saved.controlRoot!==controlRoot||saved.sourceRoot!==sourceRoot
  ||sourceRoot!==path.join(path.dirname(controlRoot),'fresh-native-source'))throw fail();
 await protectNativeSetupSource({controlRoot,sourceRoot});
 await verifySeed(sourceRoot);
 await fs.rm(sourceRoot,{recursive:true});
}
