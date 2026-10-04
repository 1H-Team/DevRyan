import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {withCrossProcessFileLock,writeFileAtomic} from '../../../../../harness-runtime/lib/atomic-file.js';
import {claudeKeychainService} from '../claude-credential-projection.js';
import {isNativeClaudeEnrollmentDirectory} from './native-claude-enrollment-directory.js';

const fail=code=>Object.assign(new Error(code),{code,status:409,statusCode:409});
const digest=bytes=>bytes===null?null:createHash('sha256').update(bytes).digest('hex');
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** Publish only an explicitly selected enrollment into the existing Meridian
 * files. Raw source bytes stay private and unrelated saved fields survive. */
export function createNativeClaudeProfilePublication({home,controlRoot,writeAtomic=writeFileAtomic}){
 const directory=path.join(home,'.config','meridian');
 const files={profiles:path.join(directory,'profiles.json'),settings:path.join(directory,'settings.json')};
 const guard=async(file,create=false)=>{
  if(!path.isAbsolute(home)||path.resolve(home)!==home||await fs.realpath(home)!==home)throw fail('native_claude_enrollment_configuration_invalid');
  let current=home;
  for(const part of path.relative(home,file).split(path.sep)){
   current=path.join(current,part);let stat;
   try{stat=await fs.lstat(current);}catch(error){
    if(error.code!=='ENOENT')throw error;
    if(!create||current===file)return;
    await fs.mkdir(current,{mode:0o700});stat=await fs.lstat(current);
   }
   if(stat.isSymbolicLink()||await fs.realpath(current)!==current||typeof process.getuid==='function'&&stat.uid!==process.getuid()
    ||(current===file?!stat.isFile():!stat.isDirectory()))throw fail('native_claude_enrollment_configuration_invalid');
  }
 };
 const read=async file=>{
  await guard(file);let handle;
  try{
   handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);const stat=await handle.stat();
   if(!stat.isFile()||stat.size>1024*1024)throw fail('native_claude_enrollment_configuration_invalid');
   const bytes=await handle.readFile(),after=await handle.stat(),linked=await fs.lstat(file);
   await guard(file);
   if(stat.dev!==linked.dev||stat.ino!==linked.ino||stat.size!==after.size||stat.mtimeMs!==after.mtimeMs||stat.ctimeMs!==after.ctimeMs)throw fail('native_claude_enrollment_configuration_changed');
   return bytes;
  }catch(error){if(error.code==='ENOENT')return null;throw error;}finally{await handle?.close();}
 };
 const load=async()=>{
  const profiles=await read(files.profiles),settings=await read(files.settings);let rows,value;
  try{rows=profiles===null?[]:JSON.parse(profiles.toString('utf8'));value=settings===null?{}:JSON.parse(settings.toString('utf8'));}catch{throw fail('native_claude_enrollment_configuration_invalid');}
  if(!Array.isArray(rows)||rows.length>64||rows.some(row=>!record(row)||typeof row.id!=='string'||!row.id)
   ||new Set(rows.map(row=>row.id)).size!==rows.length||!record(value))throw fail('native_claude_enrollment_configuration_invalid');
  return {profiles,settings,rows,value};
 };
 const baseline=value=>({profilesSha256:digest(value.profiles),settingsSha256:digest(value.settings),selectedProfileID:typeof value.value.activeProfile==='string'?value.value.activeProfile:null});
 const matches=(value,expected)=>JSON.stringify(baseline(value))===JSON.stringify(expected);
 return {
  snapshot:async()=>baseline(await load()),
  publish:async(profile,expected,{recheck})=>{
   const enrollmentID=profile?.id?.slice('devryan-'.length);
   if(profile?.id!==`devryan-${enrollmentID}`||!uuid.test(enrollmentID)||profile.type!=='claude-max'
    ||profile.claudeConfigDir!==path.join(controlRoot,'claude-enrollments',enrollmentID)
    ||profile.keychainService!==claudeKeychainService(profile.claudeConfigDir,home)
    ||Object.keys(profile).some(key=>!['id','type','claudeConfigDir','keychainService'].includes(key)))throw fail('native_claude_enrollment_receipt_invalid');
   if(!await isNativeClaudeEnrollmentDirectory(profile,{controlRoot,home}))throw fail('native_claude_enrollment_receipt_invalid');
   await recheck();await guard(files.profiles,true);await guard(files.settings,true);
   return withCrossProcessFileLock(path.join(directory,'profiles.lock'),async()=>{
    await recheck();const before=await load();
    if(!matches(before,expected))throw fail('native_claude_enrollment_configuration_changed');
    const prior=before.rows.find(row=>row.id===profile.id);
    if(prior&&JSON.stringify(prior)!==JSON.stringify(profile))throw fail('native_claude_enrollment_collision');
    if(!prior&&before.rows.length>=64)throw fail('native_claude_enrollment_capacity');
    const profiles=Buffer.from(JSON.stringify(prior?before.rows:[...before.rows,profile],null,2)+'\n');
    const settings=Buffer.from(JSON.stringify({...before.value,activeProfile:profile.id},null,2)+'\n');
    await recheck();if(!matches(await load(),expected))throw fail('native_claude_enrollment_configuration_changed');
    await writeAtomic(files.profiles,profiles);
    try{
     await recheck();
     const current=await load();
     if(digest(current.profiles)!==digest(profiles)||digest(current.settings)!==digest(before.settings))throw fail('native_claude_enrollment_configuration_changed');
     await writeAtomic(files.settings,settings);
     const after=await load();
     if(digest(after.profiles)!==digest(profiles)||digest(after.settings)!==digest(settings))throw fail('native_claude_enrollment_selection_uncertain');
     await recheck();
    }catch(cause){
     // Restore only the first write we still own. A concurrent edit or a
     // committed settings write remains visible for explicit recovery.
     const current=await load();
     if(digest(current.profiles)===digest(profiles)&&digest(current.settings)===digest(before.settings)){
      if(before.profiles===null)await fs.unlink(files.profiles);else await writeAtomic(files.profiles,before.profiles);
      throw cause;
     }
     throw fail('native_claude_enrollment_selection_uncertain');
    }
   });
  },
 };
}
