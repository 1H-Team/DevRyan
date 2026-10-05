import path from 'node:path';
import {createHash} from 'node:crypto';
import {isNativeClaudeEnrollmentDirectory} from './native-claude-enrollment-directory.js';
import {parseClaudeLifecycle} from './native-claude-lifecycle.js';
import {claudeKeychainService} from '../claude-credential-projection.js';
const fail=()=>Object.assign(new Error('native_setup_profiles_invalid'),{code:'native_setup_profiles_invalid',status:503,statusCode:503});
export const isNativeKeychainService=value=>typeof value==='string'&&/^Claude Code-credentials(?:-[a-f0-9]{8})?$/.test(value);
/** Preserve account identity while relocating only exact account setup files.
 * With `onSkip` (first seed), inputs the Meridian loader tolerates are dropped
 * and reported by profile id only: non-array input, rows without an id and
 * accounts outside HOME. Without it (bundle clones) they fail closed. */
export async function relocateNativeSetupProfiles({profiles,sourceHome,targetHome,copyAccount,controlRoot,claudeLifecycle,onSkip}){
 const drop=(reason,id)=>{if(!onSkip)throw fail();onSkip({reason,...typeof id==='string'?{profile:id.replace(/[\u0000-\u001f\u007f-\u009f]/g,'').slice(0,256)}:{}});};
 if(!Array.isArray(profiles)){drop('profiles_invalid');return [];}
 if(profiles.length>64)throw fail();
 const seen=new Set(),result=[];
 for(const input of profiles){
  if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.id!=='string'||!input.id||input.id.length>256){drop('profile_id_invalid');continue;}
  if(seen.has(input.id))throw fail();
  seen.add(input.id);const profile={...input};
  if(profile.type==='claude-max'||profile.claudeConfigDir!==undefined){
   if(profile.claudeConfigDir!==undefined&&(typeof profile.claudeConfigDir!=='string'||!path.isAbsolute(profile.claudeConfigDir)))throw fail();
   const account=profile.claudeConfigDir===undefined?path.join(sourceHome,'.claude'):path.resolve(profile.claudeConfigDir);
   if(await isVerifiedNativeClaudeEnrollmentProfile(profile,{controlRoot,home:sourceHome,claudeLifecycle})){result.push(profile);continue;}
   if(!(account===sourceHome||account.startsWith(sourceHome+path.sep))){drop('profile_account_outside_home',profile.id);continue;}
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
