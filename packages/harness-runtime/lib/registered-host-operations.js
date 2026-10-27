import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

const grants=new WeakSet();
const fail=code=>Object.assign(new Error(code),{code,status:403});
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const inside=(root,file)=>file===root||file.startsWith(root+path.sep);
const digest=value=>createHash('sha256').update(value).digest('hex');
const boundedString=value=>typeof value==='string'&&value.length>0&&value.length<=8192&&!/[\u0000-\u001f]/.test(value);
const fields=(value,allowed)=>{if(!record(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw fail('host_operation_registration_invalid');};
const environmentNames=new Set(['HOME','PATH','USER','LOGNAME','LANG','LC_ALL','DOCKER_HOST','DOCKER_CONTEXT','DOCKER_CONFIG','SSH_AUTH_SOCK']);
const canonicalSocket=async(target,depth=0)=>{
 if(depth>16)throw fail('host_operation_socket_unavailable');
 const stat=await fs.lstat(target);
 if(stat.isSymbolicLink())return canonicalSocket(path.resolve(path.dirname(target),await fs.readlink(target)),depth+1);
 return path.join(await fs.realpath(path.dirname(target)),path.basename(target));
};
const hashFile=async(file,code='host_operation_content_changed')=>{
 try{
  const stat=await fs.lstat(file);
  if(!stat.isFile()||stat.size>256*1024*1024||await fs.realpath(file)!==file)throw fail(code);
  return digest(await fs.readFile(file));
 }catch{throw fail(code);}
};

/** Only the private administrator registry can mint grants; tool payloads cannot. */
export function assertRegisteredHostOperationGrant(grant){
 if(!grant||!grants.has(grant))throw fail('host_operation_grant_required');
 return grant;
}

export function assertRegisteredHostOperationPrerequisites(operation,checks){
 if(operation.purpose!=='deployment')return;
 if(!Array.isArray(checks)||!operation.prerequisites.length||operation.prerequisites.some(name=>{
  const matches=checks.filter(check=>check.name===name);return matches.length!==1||!['passed','waived'].includes(matches[0].status);
 }))throw fail('host_operation_prerequisites_pending');
}

export async function loadRegisteredHostOperations({file,directories,environment=process.env}){
 const read=async()=>{
  let stat;try{stat=await fs.lstat(file);}catch(error){if(error.code==='ENOENT')return null;throw fail('host_operation_registry_unavailable');}
  if(!stat.isFile()||stat.size>65536||stat.nlink!==1||stat.mode&0o077||typeof process.getuid==='function'&&stat.uid!==process.getuid()
   ||directories.some(directory=>inside(directory,file)))throw fail('host_operation_registry_untrusted');
  try{if(await fs.realpath(file)!==file)throw fail('host_operation_registry_untrusted');return await fs.readFile(file);}
  catch(error){throw fail(error.code==='host_operation_registry_untrusted'?error.code:'host_operation_registry_unavailable');}
 };
 const source=await read(),configurationDigest=source?digest(source):null;
 let config;try{config=source?JSON.parse(source.toString('utf8')):{version:1,operations:[]};}catch{throw fail('host_operation_registration_invalid');}
 fields(config,['version','operations']);
 if(config.version!==1||!Array.isArray(config.operations)||config.operations.length>32)throw fail('host_operation_registration_invalid');
 const operations=new Map();
 for(const row of config.operations){
  fields(row,['id','description','purpose','directory','cwd','command','args','executableSha256','contentFiles','requiredCapabilities','environment','timeoutMs','prerequisites']);
  const prerequisites=row.prerequisites??[];
  if(!Array.isArray(prerequisites)||prerequisites.length>8||new Set(prerequisites).size!==prerequisites.length||prerequisites.some(name=>!boundedString(name)||!name.trim()||name.length>128)
   ||row.purpose==='deployment'&&!prerequisites.length)throw fail('host_operation_prerequisites_required');
  if(typeof row.id!=='string'||!/^host_[a-z0-9_]{1,64}$/.test(row.id)||operations.has(row.id)||!boundedString(row.description)||row.description.length>256
   ||!['verification','deployment'].includes(row.purpose)||!directories.includes(row.directory)||row.cwd!==row.directory
   ||!boundedString(row.command)||!path.isAbsolute(row.command)||directories.some(directory=>inside(directory,row.command))
   ||!/^[a-f0-9]{64}$/.test(row.executableSha256??'')||!Array.isArray(row.args)||row.args.length>64||row.args.some(arg=>typeof arg!=='string'||arg.length>8192||arg.includes('\0'))
   ||!Number.isSafeInteger(row.timeoutMs)||row.timeoutMs<1000||row.timeoutMs>3600000||!Array.isArray(row.contentFiles)||!row.contentFiles.length||row.contentFiles.length>128
   ||!Array.isArray(row.environment)||new Set(row.environment).size!==row.environment.length||row.environment.some(name=>!environmentNames.has(name)))throw fail('host_operation_registration_invalid');
  fields(row.requiredCapabilities,['unixSockets','machServices']);
  const {unixSockets,machServices}=row.requiredCapabilities;
  if(!Array.isArray(unixSockets)||unixSockets.length>4||unixSockets.some(socket=>!boundedString(socket)||!path.isAbsolute(socket))
   ||!Array.isArray(machServices)||machServices.length>2||machServices.some(service=>!['com.apple.system.opendirectoryd.libinfo','com.apple.system.opendirectoryd.membership'].includes(service)))throw fail('host_operation_registration_invalid');
  const files=row.contentFiles.map(item=>{
   fields(item,['path','sha256']);
   if(!boundedString(item.path)||path.isAbsolute(item.path)||item.path.split(/[\\/]/).some(part=>['..','.git'].includes(part))||!/^[a-f0-9]{64}$/.test(item.sha256??''))throw fail('host_operation_registration_invalid');
   return Object.freeze({...item});
  });
  if(row.environment.some(name=>['HOME','PATH','SSH_AUTH_SOCK'].includes(name)&&!boundedString(environment[name])))throw fail('host_operation_context_unavailable');
  const env=Object.freeze(Object.fromEntries(row.environment.filter(name=>typeof environment[name]==='string').map(name=>[name,environment[name]])));
  operations.set(row.id,Object.freeze({...row,prerequisites:Object.freeze([...prerequisites]),args:Object.freeze([...row.args]),contentFiles:Object.freeze(files),environment:env,
   requiredCapabilities:Object.freeze({unixSockets:Object.freeze([...unixSockets]),machServices:Object.freeze([...machServices])})}));
 }
 const recheck=async operation=>{
  const current=await read();
  if((current?digest(current):null)!==configurationDigest)throw fail('host_operation_configuration_changed');
  if(await hashFile(operation.command,'host_operation_executable_unavailable')!==operation.executableSha256)throw fail('host_operation_content_changed');
 };
 return {
  catalog:()=>[...operations.values()].map(row=>({id:row.id,directory:row.directory,description:row.description,purpose:row.purpose})),
  async resolve(operationID,directory){
   const operation=operations.get(operationID);
   if(!operation||operation.directory!==directory)throw fail('host_operation_unregistered');
   await recheck(operation);
   let socketIdentities;
   const check=async executionDirectory=>{
    await recheck(operation);
    for(const item of operation.contentFiles){
     if(await hashFile(path.join(directory,item.path))!==item.sha256
      ||executionDirectory&&await hashFile(path.join(executionDirectory,item.path))!==item.sha256)throw fail('host_operation_content_changed');
    }
    for(const [index,socket] of operation.requiredCapabilities.unixSockets.entries()){
     let stat;try{stat=await fs.stat(socket);}catch(error){throw fail(error.code==='ENOENT'?'host_operation_socket_missing':'host_operation_socket_unavailable');}
     if(!stat.isSocket())throw fail('host_operation_socket_unavailable');
     if(socketIdentities&&await canonicalSocket(socket)!==socketIdentities[index])throw fail('host_operation_socket_changed');
    }
   };
   await check();
   socketIdentities=await Promise.all(operation.requiredCapabilities.unixSockets.map(socket=>canonicalSocket(socket)));
   const grant=Object.freeze({unixSockets:Object.freeze(socketIdentities),machServices:operation.requiredCapabilities.machServices,environment:operation.environment});grants.add(grant);
   return {operationID:operation.id,purpose:operation.purpose,prerequisites:operation.prerequisites,command:operation.command,args:operation.args,cwd:operation.cwd,timeoutMs:operation.timeoutMs,grant,recheck:check};
  },
 };
}
