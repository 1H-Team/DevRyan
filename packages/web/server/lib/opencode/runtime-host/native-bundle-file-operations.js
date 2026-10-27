import fs from 'node:fs/promises';
import path from 'node:path';

const unavailable=()=>Object.assign(new Error('private_windows_storage_authority_unavailable'),{code:'private_windows_storage_authority_unavailable',status:503});

/** Constructor-owned private creation. This Node adapter is never lent to a
 * compiled importer or selected through environment/request metadata. */
export function nativeBundleFileOperations({windowsOwner}={}){
 const windows=process.platform==='win32'||windowsOwner!==undefined;
 const requireMethod=name=>{
  if(typeof windowsOwner?.[name]!=='function')throw unavailable();
  return windowsOwner[name].bind(windowsOwner);
 };
 const ensureDirectory=directory=>windows?requireMethod('ensureDirectory')(directory):fs.mkdir(directory,{recursive:true,mode:0o700});
 const writeFresh=async(file,bytes)=>{
  await ensureDirectory(path.dirname(file));
  if(windows)return requireMethod('write')(file,Buffer.from(bytes),{expected:null});
  await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});
 };
 const withSqliteOutput=async(file,action)=>{
  await ensureDirectory(path.dirname(file));
  if(!windows)return action(file);
  const lease=await requireMethod('beginSqliteOutput')(path.dirname(file),path.basename(file));
  try{
   await lease.ready;await lease.assertHeld();
   const result=await action(file);
   await lease.assertHeld();await lease.commit();return result;
  }catch(error){
   try{await lease.cancel();}catch(cleanup){throw new AggregateError([error,cleanup],'Private SQLite output settlement failed');}
   throw error;
  }
 };
 return {windows,windowsOwner,ensureDirectory,writeFresh,withSqliteOutput};
}
