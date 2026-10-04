import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {executionArtifacts} from '../execution-artifacts.js';
import {verifyNativeRuntimeArtifacts} from './native-artifacts.js';
import {withCrossProcessFileLock} from '../../../../../harness-runtime/lib/atomic-file.js';

const fail=()=>Object.assign(new Error('bundle_artifact_retention_invalid'),{code:'bundle_artifact_retention_invalid',status:503});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

/** Preserve the complete verified inventory before an application update replaces Resources. */
export async function retainNativeArtifacts({controlRoot,manifestPath,manifestSha256,verifyArtifacts=verifyNativeRuntimeArtifacts}){
 if(!path.isAbsolute(controlRoot)||!/^[a-f0-9]{64}$/.test(manifestSha256))throw fail();
 const source=path.dirname(manifestPath),verified=await verifyArtifacts({manifestPath,manifestSha256,launcher:executionArtifacts(source).launcher});
 const bytes=await fs.readFile(manifestPath);if(hash(bytes)!==manifestSha256)throw fail();
 // Read the verified bytes, rather than an optional verifier's returned metadata.
 let manifest;try{manifest=JSON.parse(bytes);}catch{throw fail();}
 if(!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>256)throw fail();
 const seen=new Set();
 for(const row of manifest.files){
  if(!row||typeof row.path!=='string'||path.isAbsolute(row.path)||row.path.split(/[\\/]/).some(part=>!part||part==='.'||part==='..')
   ||seen.has(row.path)||!/^[a-f0-9]{64}$/.test(row.sha256)||!Number.isSafeInteger(row.size)||row.size<0
   ||!Number.isInteger(row.mode)||row.mode<0||row.mode>0o777)throw fail();seen.add(row.path);
 }
 const parent=path.join(controlRoot,'artifacts');await fs.mkdir(parent,{recursive:true,mode:0o700});
 if(await fs.realpath(parent)!==parent)throw fail();await fs.chmod(parent,0o700);
 const target=path.join(parent,manifestSha256);
 return withCrossProcessFileLock(path.join(parent,'retention.lock'),async()=>{
  const validate=async directory=>{
   if(await fs.realpath(directory)!==directory)throw fail();
   for(const row of manifest.files){const file=path.join(directory,row.path),stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||await fs.realpath(file)!==file||stat.size!==row.size||(stat.mode&0o777)!==row.mode||hash(await fs.readFile(file))!==row.sha256)throw fail();}
   const file=path.join(directory,'native-bundle.json'),stat=await fs.lstat(file);
   if(!stat.isFile()||stat.isSymbolicLink()||await fs.realpath(file)!==file||(stat.mode&0o777)!==0o600||hash(await fs.readFile(file))!==manifestSha256)throw fail();
   return verifyArtifacts({manifestPath:file,manifestSha256,launcher:executionArtifacts(directory).launcher});
  };
  try{return await validate(target);}catch(error){if(error.code!=='ENOENT')throw error;}
  const temporary=path.join(parent,`.retaining-${randomUUID()}`);await fs.mkdir(temporary,{mode:0o700});
  try{
   for(const row of manifest.files){const file=path.join(source,row.path),stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||await fs.realpath(file)!==file||stat.size!==row.size||hash(await fs.readFile(file))!==row.sha256)throw fail();
    const destination=path.join(temporary,row.path);await fs.mkdir(path.dirname(destination),{recursive:true,mode:0o700});
    await fs.copyFile(file,destination,fs.constants.COPYFILE_EXCL);await fs.chmod(destination,row.mode);
   }
   await fs.writeFile(path.join(temporary,'native-bundle.json'),bytes,{flag:'wx',mode:0o600});
   await validate(temporary);await fs.rename(temporary,target);
  }finally{await fs.rm(temporary,{recursive:true,force:true});}
  const retained=await validate(target);
  if(path.basename(retained.controller??verified.controller)!==path.basename(verified.controller)||path.basename(retained.writer??verified.writer)!==path.basename(verified.writer))throw fail();
  return retained;
 });
}
