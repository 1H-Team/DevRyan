import fs from 'node:fs/promises';
import path from 'node:path';
import {userInfo} from 'node:os';
import {claudeKeychainService} from '../claude-credential-projection.js';

const fail=()=>Object.assign(new Error('native_claude_owned_store_invalid'),{code:'native_claude_owned_store_invalid',status:403});
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const absolute=value=>typeof value==='string'&&value.length<=4096&&path.isAbsolute(value)&&path.resolve(value)===value&&!/[\u0000-\u001f\u007f]/.test(value);

/** Constructor-only backend for an exact private enrollment. Neither a service
 * spelling nor a public profile is authority to select the OS credential HOME. */
export function createNativeClaudeSecurityHome({controlRoot,home,securityHome,execute,account=userInfo().username}){
 if(![controlRoot,home,securityHome].every(absolute)||typeof execute!=='function')throw fail();
 const root=path.join(controlRoot,'claude-enrollments');
 const inspect=async binding=>{
  if(!binding||Array.isArray(binding)||Object.keys(binding).some(key=>!['enrollmentID','generation','profileID','configDirectory','service'].includes(key))
   ||!uuid(binding.enrollmentID)||!uuid(binding.generation)||binding.profileID!==`devryan-${binding.enrollmentID}`
   ||binding.configDirectory!==path.join(root,binding.enrollmentID)||binding.service!==claudeKeychainService(binding.configDirectory,home)
   ||binding.service==='Claude Code-credentials')throw fail();
  const identities=[];
  for(const directory of [controlRoot,root,binding.configDirectory]){
   const stat=await fs.lstat(directory);
   if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o700||stat.uid!==process.getuid?.()||await fs.realpath(directory)!==directory)throw fail();
   identities.push([stat.dev,stat.ino]);
  }
  return identities;
 };
 return async(binding,recheck)=>{
  if(typeof recheck!=='function')throw fail();
  const selected=Object.freeze({...binding});await recheck();const identities=await inspect(selected);await recheck();
  return async(file,args,options,check=recheck)=>{
   if(file!=='/usr/bin/security'||!Array.isArray(args)||typeof check!=='function')throw fail();
   const operation=args[0],prefix=operation==='add-generic-password'&&args[1]==='-U'?[operation,'-U']:[operation];
   const base=[...prefix,'-s',selected.service,'-a',account];
   const tail=operation==='add-generic-password'
    ?args.length===base.length+2&&args[base.length]==='-w'&&typeof args[base.length+1]==='string'
    :args.length===base.length||operation==='find-generic-password'&&args.length===base.length+1&&args[base.length]==='-w';
   if(!['find-generic-password','add-generic-password','delete-generic-password'].includes(operation)
    ||base.some((value,index)=>args[index]!==value)||!tail)throw fail();
   const commandArgs=[...args];
   await check();const current=await inspect(selected);await check();
   if(current.some((value,index)=>value[0]!==identities[index][0]||value[1]!==identities[index][1]))throw fail();
   const result=await execute(file,commandArgs,{...options,env:{...process.env,...options?.env,HOME:securityHome}});
   await check();const after=await inspect(selected);await check();
   if(after.some((value,index)=>value[0]!==identities[index][0]||value[1]!==identities[index][1]))throw fail();
   return result;
  };
 };
}
