import path from 'node:path';
import {createHash} from 'node:crypto';
import {isNativeClaudeEnrollmentDirectory} from './native-claude-enrollment-directory.js';
import {parseClaudeLifecycle} from './native-claude-lifecycle.js';
import {claudeKeychainService} from '../claude-credential-projection.js';
const fail=()=>Object.assign(new Error('native_setup_profiles_invalid'),{code:'native_setup_profiles_invalid',status:503,statusCode:503});
export const isNativeKeychainService=value=>typeof value==='string'&&/^Claude Code-credentials(?:-[a-f0-9]{8})?$/.test(value);
/** Preserve account identity while relocating only exact account setup files. */
export async function relocateNativeSetupProfiles({profiles,sourceHome,targetHome,copyAccount,controlRoot,claudeLifecycle}){
 if(!Array.isArray(profiles)||profiles.length>64)throw fail();
 const seen=new Set(),result=[];
 for(const input of profiles){
  if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.id!=='string'||!input.id||input.id.length>256||seen.has(input.id))throw fail();
  seen.add(input.id);const profile={...input};
  if(profile.type==='claude-max'||profile.claudeConfigDir!==undefined){
   const account=profile.claudeConfigDir??path.join(sourceHome,'.claude');
   if(typeof account!=='string'||!path.isAbsolute(account)||path.resolve(account)!==account)throw fail();
   if(await isVerifiedNativeClaudeEnrollmentProfile(profile,{controlRoot,home:sourceHome,claudeLifecycle})){result.push(profile);continue;}
   if(!(account===sourceHome||account.startsWith(sourceHome+path.sep)))throw fail();
   const privateAccount=path.join(targetHome,'.config','meridian','accounts',createHash('sha256').update(profile.id).digest('hex'));
   const service=profile.keychainService??claudeKeychainService(account,sourceHome);
   if(!isNativeKeychainService(service))throw fail();
   await copyAccount(account,privateAccount);
   profile.claudeConfigDir=privateAccount;profile.keychainService=service;
  }
  result.push(profile);
 }
 return result;
}

/** The filesystem validator confines the path; only original captured native
 * KV enrollment authority permits preserving it across a clone. */
export async function isVerifiedNativeClaudeEnrollmentProfile(profile,{controlRoot,home,claudeLifecycle}){
 if(!claudeLifecycle||!await isNativeClaudeEnrollmentDirectory(profile,{controlRoot,home}))return false;
 let state;try{state=parseClaudeLifecycle(claudeLifecycle);}catch{return false;}
 return state.accounts.some(row=>row.profileID===profile.id&&row.configDirectory===profile.claudeConfigDir
  &&row.service===profile.keychainService&&row.enrollmentID===path.basename(profile.claudeConfigDir));
}
