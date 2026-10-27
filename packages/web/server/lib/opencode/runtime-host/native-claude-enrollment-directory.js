import fs from 'node:fs/promises';
import path from 'node:path';
import {claudeKeychainService} from '../claude-credential-projection.js';

const enrollmentID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
/** Path confinement only. Renewal and clone authority also require the exact
 * enrollment receipt from the original native lifecycle KV. */
export async function isNativeClaudeEnrollmentDirectory(profile,{controlRoot,home}){
 if(typeof controlRoot!=='string'||!path.isAbsolute(controlRoot)||path.resolve(controlRoot)!==controlRoot)return false;
 const root=path.join(controlRoot,'claude-enrollments'),directory=profile?.claudeConfigDir;
 if(typeof directory!=='string'||profile.type!=='claude-max'||profile.oauthToken||profile.apiKey||path.dirname(directory)!==root
   ||!enrollmentID.test(path.basename(directory))||profile.keychainService!==claudeKeychainService(directory,home))return false;
 try{
  for(const value of [controlRoot,root,directory]){
   const stat=await fs.lstat(value);
   if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0
     ||typeof process.getuid==='function'&&stat.uid!==process.getuid()||await fs.realpath(value)!==value)return false;
  }
  return true;
 }catch{return false;}
}
