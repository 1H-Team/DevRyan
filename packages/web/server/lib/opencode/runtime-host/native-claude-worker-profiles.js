import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseClaudeLifecycle,sameClaudeEnrollment} from './native-claude-lifecycle.js';
import {isVerifiedNativeClaudeEnrollmentProfile} from './native-setup-profiles.js';

const fail=code=>Object.assign(new Error(code),{code,status:503,statusCode:503});
const inside=(directory,root)=>directory===root||directory.startsWith(root+path.sep);
const absolute=value=>typeof value==='string'&&path.isAbsolute(value)&&path.resolve(value)===value;
const privateDirectory=async directory=>{
 const stat=await fs.lstat(directory);
 if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(directory)!==directory||(stat.mode&0o777)!==0o700
  ||typeof process.getuid==='function'&&stat.uid!==process.getuid())throw fail('native_claude_worker_profile_invalid');
};

/** Only empty worker configuration directories cross into the existing worker
 * roots. The host retains the original enrollment and exact credential service. */
export async function projectNativeClaudeWorkerProfiles({profiles,globals,controlRoot,workerInstanceID,lifecycle},{recheck,signal}){
 const check=async()=>{await recheck();signal?.throwIfAborted();};await check();
 const roots=[globals?.home,globals?.config,globals?.data];
 if(roots.some(root=>!absolute(root))||!Array.isArray(profiles)||profiles.length>64
  ||profiles.some(profile=>!profile||typeof profile.id!=='string'||!profile.id)||new Set(profiles.map(profile=>profile.id)).size!==profiles.length
  ||typeof workerInstanceID!=='string'||!/^[-a-f0-9]{32,64}$/.test(workerInstanceID))throw fail('native_claude_worker_profile_invalid');
 const external=profiles.filter(profile=>{
  if(profile.claudeConfigDir===undefined)return false;
  if(!absolute(profile.claudeConfigDir))throw fail('native_claude_worker_profile_invalid');
  return !roots.some(root=>inside(profile.claudeConfigDir,root));
 });
 if(!external.length)return profiles;
 if(!lifecycle||typeof lifecycle.read!=='function')throw fail('native_claude_lifecycle_owner_required');
 const state=parseClaudeLifecycle(await lifecycle.read());await check();
 const bindings=new Map();
 for(const profile of external){
  if(!await isVerifiedNativeClaudeEnrollmentProfile(profile,{controlRoot,home:globals.home,claudeLifecycle:state}))throw fail('native_claude_enrollment_required');
  bindings.set(profile.id,state.accounts.find(row=>row.profileID===profile.id));await check();
 }
 await privateDirectory(globals.home);await check();
 const parent=path.join(globals.home,'.devryan-claude-workers'),worker=path.join(parent,workerInstanceID),created=[];
 try{await fs.mkdir(parent,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
 await privateDirectory(parent);await check();
 try{await fs.mkdir(worker,{mode:0o700});}catch(error){if(error.code==='EEXIST')throw fail('native_claude_worker_profile_invalid');throw error;}
 try{
  await privateDirectory(worker);await check();const projected=new Map();
  for(const profile of external){
   const directory=path.join(worker,createHash('sha256').update(profile.id).digest('hex'));
   await fs.mkdir(directory,{mode:0o700});created.push(directory);await privateDirectory(directory);await check();
   if((await fs.readdir(directory)).length)throw fail('native_claude_worker_profile_invalid');
   projected.set(profile.id,{...profile,claudeConfigDir:directory});
  }
  const current=parseClaudeLifecycle(await lifecycle.read());await check();
  for(const profile of external){
   const selected=current.accounts.find(row=>row.profileID===profile.id);
   if(!selected||!sameClaudeEnrollment(selected,bindings.get(profile.id))
    ||!await isVerifiedNativeClaudeEnrollmentProfile(profile,{controlRoot,home:globals.home,claudeLifecycle:current}))throw fail('native_claude_enrollment_required');
   const directory=projected.get(profile.id).claudeConfigDir;
   await privateDirectory(directory);if((await fs.readdir(directory)).length)throw fail('native_claude_worker_profile_invalid');
  }
  await privateDirectory(parent);await privateDirectory(worker);await check();
  return profiles.map(profile=>projected.get(profile.id)??profile);
 }catch(error){
  // These leaves were exclusively created here. Never recursively remove an
  // unexpected file or replacement directory during a failed projection.
  try{
   await privateDirectory(parent);await privateDirectory(worker);
   for(const directory of created.reverse())await fs.rmdir(directory).catch(()=>{});
   await fs.rmdir(worker).catch(()=>{});
  }catch{ /* A replaced ancestor is not ours to clean up. */ }
  throw error;
 }
}
