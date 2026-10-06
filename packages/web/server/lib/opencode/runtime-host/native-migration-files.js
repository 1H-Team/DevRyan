import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {canonicalJSON,sha256,bundleFailure} from './bundle-migration-inventory.js';
import {BUNDLE_DOCUMENT_MAX_BYTES} from './bundle-document-limits.js';

export function parseNativeImportChildProof(value,{nonce,pid}){
 if(!value||Object.keys(value).sort().join(',')!=='admission,inJob,jobOwned,nonce,pid,protocol,startIdentity'
  ||value.protocol!=='devryan.windows-native-import-child/1'||value.nonce!==nonce||value.pid!==pid
  ||typeof value.startIdentity!=='string'||!/^win32:[a-f0-9]{16}$/.test(value.startIdentity)
  ||value.inJob!==true||value.jobOwned!==true||value.admission!==false)throw bundleFailure('native_migration_owner_unverified');
 return value;
}

/** This compiled mode borrows no general SDK authority. The fixed sibling probe
 * must prove this process belongs to the nonce-bound offline importer job before
 * it can write the three migration documents in the protected sources directory.
 * The outer native owner settles descendants and seals all output ACLs afterward. */
const requireNativeImportProcess=nonce=>{
 if(process.platform!=='win32'||!/^[a-f0-9]{32}$/.test(nonce??''))throw bundleFailure('native_migration_owner_unverified');
};
export async function verifyNativeImportChild(nonce,{operation,root,rootExclusions,mutating}){
 requireNativeImportProcess(nonce);
 const verifier=path.join(path.dirname(process.execPath),`DevRyan-execution-win32-${process.arch}.exe`);
 const {stdout}=await promisify(execFile)(verifier,['--inspect-native-import-child',nonce],{encoding:'utf8',timeout:5000,maxBuffer:65536,windowsHide:true});
 let proof;try{proof=JSON.parse(stdout);}catch{throw bundleFailure('native_migration_owner_unverified');}
 parseNativeImportChildProof(proof,{nonce,pid:process.pid});
 if(process.env.DEVRYAN_NATIVE_IMPORT_OPERATION!==operation||process.env.DEVRYAN_NATIVE_IMPORT_ROOT!==root
   ||process.env.DEVRYAN_NATIVE_IMPORT_ROOT_EXCLUSIONS!==rootExclusions||process.env.DEVRYAN_NATIVE_IMPORT_MUTATING!==(mutating?'1':'0'))throw bundleFailure('native_migration_owner_unverified');
 return proof;
}
export async function createNativeMigrationFiles(request,nonce){
 requireNativeImportProcess(nonce);
 const root=path.dirname(request.isolatedRoot),sources=path.join(root,'sources');
 if(request.receiptPath!==path.join(sources,'migration.json')||request.candidateDatabasePath!==path.join(root,'opencode','opencode.db'))throw bundleFailure('migration_path_invalid');
 await verifyNativeImportChild(nonce,{operation:'migrate',root,rootExclusions:'none',mutating:true});
 const allowed=new Set(['','.source.json','.verification.json'].map(suffix=>request.receiptPath+suffix));
 const check=file=>{if(!allowed.has(file))throw bundleFailure('migration_path_invalid');};
 const read=async file=>{
  check(file);const handle=await fs.open(file,'r');
  try{const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>BUNDLE_DOCUMENT_MAX_BYTES)throw bundleFailure('bundle_document_invalid');
   const bytes=await handle.readFile();if(bytes.length!==stat.size)throw bundleFailure('bundle_document_invalid');return JSON.parse(bytes.toString('utf8'));
  }finally{await handle.close();}
 };
 const save=async(file,value)=>{
  check(file);const bytes=Buffer.from(canonicalJSON(value)+'\n');if(bytes.length>BUNDLE_DOCUMENT_MAX_BYTES)throw bundleFailure('bundle_document_too_large');
  // No directory creation or arbitrary target: the keeper already owns sources.
  const temporary=path.join(sources,'.'+path.basename(file)+'.tmp-'+randomBytes(16).toString('hex'));
  const handle=await fs.open(temporary,'wx');
  try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  await fs.rename(temporary,file);return sha256(bytes);
 };
 return {read,save};
}
