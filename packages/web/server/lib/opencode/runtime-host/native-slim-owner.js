import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createNativeReadGuard} from './native-read-paths.js';
import {toV1ToolName} from '../v2/projection/tools.js';
import {createNativePonytailOwner} from './native-ponytail.js';
import {lookupReviewedSkillResourcePath,readReviewedSkillResource} from './reviewed-skills.js';

const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=code=>Object.assign(new Error(code),{code,status:403});

/** Read-only original hook IO and exact Ponytail command state. Mutating Slim
 * tools and continuations retain their separate execution owners. */
export function createNativeSlimOwner({admissionOwner,openCodeClient,configurationSnapshot,configDirectory,ponytailInstructions,locations}) {
 const location=directory=>{
  const found=configurationSnapshot.locations.find(value=>value.directory===directory);
  if(!found)throw fail('native_slim_location_unreviewed');return found;
 };
 const ponytail=(directory,assertCommand)=>{
  const configured=location(directory);
  if(!configured.activeRegistrationIDs?.includes('devryan.ponytail')||!record(configured.compatibility.ponytail))throw fail('native_ponytail_inactive');
  return createNativePonytailOwner({configDirectory,directories:[directory],defaultMode:configured.compatibility.ponytail.defaultMode,
   instructions:ponytailInstructions,assertCommand});
 };
 return {
  async hook(input,context={}) {
   if(!record(input)||!['assert','message','ponytail'].includes(input.action)
    ||Object.keys(input).some(key=>!['action','permit','directory','sessionID','phase','messageID','requestedMessageID'].includes(key)))throw fail('native_slim_hook_invalid');
   location(input.directory);
   const captured=await admissionOwner.captureSessionHookAuthorization(input);
   const recheck=async()=>{context.signal?.throwIfAborted();await captured();context.signal?.throwIfAborted();};
   await recheck();
   let result;
   if(input.action==='assert')result=null;
   else if(input.action==='ponytail')result=await ponytail(input.directory,async()=>{throw fail('native_command_derivation_required');}).contextInstructions(input.directory);
   else {
    if(typeof input.requestedMessageID!=='string'||!/^msg[A-Za-z0-9_-]{1,128}$/.test(input.requestedMessageID))throw fail('native_slim_message_invalid');
    const message=await openCodeClient.sessions.message(input.sessionID,input.requestedMessageID,{directory:input.directory});
    if(message?.info?.id!==input.requestedMessageID||message.info.sessionID!==input.sessionID||!Array.isArray(message.parts))throw fail('native_slim_message_scope_invalid');
    result={parts:message.parts};
   }
   await recheck();return result;
  },
  async acceptedCommand(input,context={}) {
   if(!record(input)||input.name!=='interview'||Object.keys(input).some(key=>!['name','arguments','permit','directory','sessionID','messageID'].includes(key)))throw fail('native_accepted_command_required');
   location(input.directory);context.signal?.throwIfAborted();
   const recheck=await admissionOwner.captureAcceptedCommandAuthorization(input);
   await recheck();context.signal?.throwIfAborted();return null;
  },
  async path(input,context={}) {
   if(!record(input)||!['assert','stat','realpath','readText'].includes(input.action)||input.phase!=='execute.before'
    ||Object.keys(input).some(key=>!['action','target','permit','directory','sessionID','messageID','callID','toolID','phase'].includes(key)))throw fail('native_slim_path_invalid');
   location(input.directory);
   const roots=locations?.find(value=>value.directory===input.directory);
   if(!roots)throw fail('native_slim_path_location_unreviewed');
   if(input.action!=='assert'&&(typeof input.target!=='string'||!path.isAbsolute(input.target)||input.target.includes('\0')))throw fail('native_slim_path_invalid');
   const captured=await admissionOwner.captureToolHookAuthorization(input);
   const recheck=async()=>{context.signal?.throwIfAborted();await captured();context.signal?.throwIfAborted();};
   await recheck();
   const message=await openCodeClient.sessions.message(input.sessionID,input.messageID,{directory:input.directory});
   if(message?.info?.id!==input.messageID||message.info.sessionID!==input.sessionID||message.info.role!=='assistant'||message.info.time?.completed
    ||message.turnOwnership?.source!=='native-sequence'||message.turnOwnership.userMessageID!==message.info.parentID
    ||!message.parts?.some(part=>part.type==='tool'&&part.callID===input.callID&&part.tool===toV1ToolName(input.toolID)&&part.state?.status==='running'))throw fail('native_tool_hook_scope_invalid');
   await recheck();if(input.action==='assert')return null;
   const resource=input.toolID==='read'&&['stat','realpath'].includes(input.action)
    ?lookupReviewedSkillResourcePath(configurationSnapshot,{snapshotDigest:configurationSnapshot.digest,directory:input.directory,targetPath:input.target}):null;
   if(resource){
    await readReviewedSkillResource(configurationSnapshot,resource);
    await recheck();
    return input.action==='stat'?{kind:'file'}:path.resolve(input.target);
   }
   const guard=createNativeReadGuard(roots);await guard(input.target);await recheck();
   const canonical=await fs.realpath(input.target).catch(cause=>{if(input.action==='stat'&&cause.code==='ENOENT')return null;throw cause;});
   if(canonical===null){await recheck();await guard(input.target);return {kind:'missing'};}
   await guard(canonical);
   if(input.action==='realpath'){await recheck();await guard(input.target);return canonical;}
   const before=await fs.lstat(canonical);
   if(input.action==='stat'){await recheck();await guard(input.target);return {kind:before.isFile()?'file':before.isDirectory()?'directory':'other'};}
   if(!before.isFile()||before.size>4*1024*1024)throw fail('native_slim_path_read_limit');
   const file=await fs.open(canonical,constants.O_RDONLY|constants.O_NOFOLLOW);
   try{
    const opened=await file.stat();
    if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size)throw fail('native_slim_path_changed');
    await recheck();await guard(input.target);await guard(canonical);
    const bytes=Buffer.alloc(opened.size+1),{bytesRead}=await file.read(bytes,0,bytes.length,0),after=await file.stat();
    if(bytesRead!==opened.size||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs)throw fail('native_slim_path_changed');
    await recheck();await guard(input.target);await guard(canonical);
    return bytes.subarray(0,bytesRead).toString('utf8');
   }finally{await file.close();}
  },
  async ponytailCommand(input,context={}) {
   if(!record(input)||input.name!=='ponytail'||Object.keys(input).some(key=>!['directory','name','invocation','permit','derivation'].includes(key)))throw fail('native_ponytail_command_invalid');
   const captured=await admissionOwner.captureCommandAuthorization(input);
   const recheck=async()=>{context.signal?.throwIfAborted();await captured();context.signal?.throwIfAborted();};
   await recheck();
   const result=await ponytail(input.directory,recheck).applyCommand({directory:input.directory,sessionID:input.invocation.sessionID,
    permit:input.permit,command:'ponytail',arguments:input.invocation.prompt.text??''});
   await recheck();return result;
  },
 };
}
