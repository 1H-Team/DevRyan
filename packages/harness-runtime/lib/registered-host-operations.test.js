import {afterEach,expect,test} from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {loadRegisteredHostOperations,assertRegisteredHostOperationGrant,assertRegisteredHostOperationPrerequisites} from './registered-host-operations.js';
import {sessionExecutionProfile} from './session-execution.js';
const roots=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});
const digest=value=>createHash('sha256').update(value).digest('hex');
const fixture=async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'devryan-host-operation-')));roots.push(root);
 const directory=path.join(root,'project'),file=path.join(root,'host-operations.json'),command=path.join(root,'approved-runtime');
 await fs.mkdir(directory);await fs.writeFile(command,'reviewed executable');await fs.writeFile(path.join(directory,'check.js'),'reviewed operation');
 const operation={id:'host_verify',description:'Check the isolated fixture',purpose:'verification',directory,cwd:directory,command,args:['check.js'],
  timeoutMs:1000,executableSha256:digest('reviewed executable'),contentFiles:[{path:'check.js',sha256:digest('reviewed operation')}],
  requiredCapabilities:{unixSockets:[],machServices:[]},environment:['HOME','PATH']};
 const save=async()=>{await fs.writeFile(file,JSON.stringify({version:1,operations:[operation]}),{mode:0o600});};await save();
 return {root,file,directory,command,operation,save,load:()=>loadRegisteredHostOperations({file,directories:[directory],environment:{HOME:'/host/home',PATH:'/host/bin',SECRET:'never returned'}})};
};
test('administrator registration mints a pinned operation with no caller arguments or secret environment',async()=>{
 const f=await fixture(),owner=await f.load(),operation=await owner.resolve('host_verify',f.directory);
 expect(owner.catalog()).toEqual([{id:'host_verify',directory:f.directory,description:f.operation.description,purpose:'verification'}]);
 expect(operation.args).toEqual(['check.js']);expect(operation.grant.environment).toEqual({HOME:'/host/home',PATH:'/host/bin'});
 expect(assertRegisteredHostOperationGrant(operation.grant)).toBe(operation.grant);
 expect(()=>assertRegisteredHostOperationGrant({...operation.grant})).toThrow('host_operation_grant_required');
 await expect(owner.resolve('host_missing',f.directory)).rejects.toMatchObject({code:'host_operation_unregistered'});
 await expect(owner.resolve('host_verify',f.root)).rejects.toMatchObject({code:'host_operation_unregistered'});
});
test('missing registry is empty; writable, workspace-owned, symlink and secret registrations fail closed',async()=>{
 const f=await fixture();await fs.rm(f.file);expect((await f.load()).catalog()).toEqual([]);await f.save();
 await fs.chmod(f.file,0o644);await expect(f.load()).rejects.toMatchObject({code:'host_operation_registry_untrusted'});await fs.chmod(f.file,0o600);
 await expect(loadRegisteredHostOperations({file:f.file,directories:[f.root]})).rejects.toMatchObject({code:'host_operation_registry_untrusted'});
 f.operation.environment.push('SECRET');await f.save();await expect(f.load()).rejects.toMatchObject({code:'host_operation_registration_invalid'});
});
test('configuration, executable, logical content and execution-view content are rechecked',async()=>{
 const f=await fixture(),owner=await f.load(),operation=await owner.resolve('host_verify',f.directory),view=path.join(f.root,'view');await fs.mkdir(view);
 await fs.writeFile(path.join(view,'check.js'),'changed');await expect(operation.recheck(view)).rejects.toMatchObject({code:'host_operation_content_changed'});
 await fs.writeFile(path.join(view,'check.js'),'reviewed operation');await operation.recheck(view);
 await fs.writeFile(path.join(f.directory,'check.js'),'changed');await expect(operation.recheck(view)).rejects.toMatchObject({code:'host_operation_content_changed'});
 await fs.writeFile(path.join(f.directory,'check.js'),'reviewed operation');await fs.writeFile(f.command,'replaced');await expect(operation.recheck(view)).rejects.toMatchObject({code:'host_operation_content_changed'});
 await fs.writeFile(f.command,'reviewed executable');f.operation.args=['changed'];await f.save();await expect(operation.recheck(view)).rejects.toMatchObject({code:'host_operation_configuration_changed'});
});
test('missing executables and selected host context have finite diagnostics without host paths',async()=>{
 const f=await fixture(),owner=await f.load();await fs.rm(f.command);
 await expect(owner.resolve('host_verify',f.directory)).rejects.toMatchObject({code:'host_operation_executable_unavailable',message:'host_operation_executable_unavailable'});
 await expect(loadRegisteredHostOperations({file:f.file,directories:[f.directory],environment:{PATH:'/bin'}})).rejects.toMatchObject({code:'host_operation_context_unavailable'});
});
test('only minted capability grants enter the profile and Plan mode always refuses them',async()=>{
 const f=await fixture(),operation=await(await f.load()).resolve('host_verify',f.directory),options={viewDirectory:f.directory,scratchDirectory:f.root};
 expect(()=>sessionExecutionProfile({...options,hostOperationGrant:{unixSockets:[],machServices:[]}})).toThrow('host_operation_grant_required');
 expect(()=>sessionExecutionProfile({...options,readOnly:true,hostOperationGrant:operation.grant})).toThrow('native_plan_write_denied');
});
test('deployment requires each named current-objective check, without unrelated-task or empty evidence shortcuts',async()=>{
 const f=await fixture();f.operation.purpose='deployment';await f.save();await expect(f.load()).rejects.toMatchObject({code:'host_operation_prerequisites_required'});
 f.operation.prerequisites=['database rehearsal'];await f.save();const operation=await(await f.load()).resolve('host_verify',f.directory);
 for(const checks of [[],[{name:'unrelated',status:'passed'}],[{name:'database rehearsal',status:'pending'}],[{name:'database rehearsal',status:'passed'},{name:'database rehearsal',status:'passed'}]]){
  expect(()=>assertRegisteredHostOperationPrerequisites(operation,checks)).toThrow('host_operation_prerequisites_pending');
 }
 expect(()=>assertRegisteredHostOperationPrerequisites(operation,[{name:'database rehearsal',status:'passed'},{name:'unrelated',status:'pending'}])).not.toThrow();
});
const darwinTest=process.platform==='darwin'?test:test.skip;
darwinTest('a registered host capability reaches its exact daemon while an ordinary shell remains denied',async()=>{
 const f=await fixture(),socket=path.join(f.root,'daemon.sock'),server=net.createServer(stream=>{stream.on('error',()=>{});stream.destroy();});server.listen(socket);await new Promise(resolve=>server.once('listening',resolve));
 try{
  f.operation.requiredCapabilities.unixSockets=[socket];await f.save();const operation=await(await f.load()).resolve('host_verify',f.directory);
  const script=`const s=require('node:net').connect(${JSON.stringify(socket)});s.on('connect',()=>{console.log('connected');s.destroy()});s.on('error',()=>process.exit(7));`;
  const options={viewDirectory:f.directory,scratchDirectory:f.root};
  const ordinary=spawnSync('/usr/bin/sandbox-exec',['-p',sessionExecutionProfile(options),process.execPath,'-e',script],{encoding:'utf8',timeout:2000});
  expect(ordinary.status).not.toBe(0);
  const registered=spawnSync('/usr/bin/sandbox-exec',['-p',sessionExecutionProfile({...options,hostOperationGrant:operation.grant}),process.execPath,'-e',script],{encoding:'utf8',timeout:2000});
  expect({status:registered.status,stdout:registered.stdout,stderr:registered.stderr}).toEqual({status:0,stdout:'connected\n',stderr:''});
 }finally{await new Promise(resolve=>server.close(resolve));}
});
