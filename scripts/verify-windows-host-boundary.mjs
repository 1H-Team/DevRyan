import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createExecutionHostOwner, executionHostOwnerLost} from '../packages/harness-runtime/lib/execution-host-owner.js';
import {ensureWindowsPrivateDirectory} from '../packages/harness-runtime/lib/windows-private-files.js';
import {startSessionExecution,readSessionExecutionReceipt} from '../packages/harness-runtime/lib/session-execution.js';

export function validateWindowsJobBoundary(jobBoundary,inJob) {
assert.deepEqual(Object.keys(jobBoundary).sort(),['breakawayAllowed','hostLimitFlags','inJob','osBuild','protocol','requestedUIFlags','sdkUIFlags','silentBreakawayAllowed','uiError','uiReadBack','uiSet']);
assert.equal(jobBoundary.protocol,'devryan.windows-job-probe/2');assert.equal(jobBoundary.inJob,inJob);
for(const field of ['hostLimitFlags','osBuild','requestedUIFlags','sdkUIFlags','uiError','uiReadBack'])assert.ok(Number.isSafeInteger(jobBoundary[field])&&jobBoundary[field]>=0&&jobBoundary[field]<=0xffffffff);
assert.ok(jobBoundary.osBuild>=10240);assert.equal(jobBoundary.sdkUIFlags,0x3ff);
assert.equal(jobBoundary.breakawayAllowed,Boolean(jobBoundary.hostLimitFlags&0x800));
assert.equal(jobBoundary.silentBreakawayAllowed,Boolean(jobBoundary.hostLimitFlags&0x1000));
assert.equal(jobBoundary.requestedUIFlags,0xff|(jobBoundary.osBuild>=22621?0x100:0)|(jobBoundary.osBuild>=26100?0x200:0));assert.equal(typeof jobBoundary.uiSet,'boolean');
assert.equal(jobBoundary.uiError===0,jobBoundary.uiSet);
assert.equal(jobBoundary.uiReadBack,jobBoundary.uiSet?jobBoundary.requestedUIFlags:0);
return jobBoundary;
}

async function main() {
if (process.platform !== 'win32' || !['x64','arm64'].includes(process.arch)) throw Error('Native Windows host required');
if (process.argv.length !== 3) throw Error('Expected owned supervisor output directory');
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=await fs.realpath(path.resolve(process.argv[2]));
assert.ok(root.startsWith(repo+path.sep));
const binary=path.join(root,`DevRyan-execution-win32-${process.arch}.exe`),manifestFile=binary+'.json';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const manifestBytes=await fs.readFile(manifestFile),manifest=JSON.parse(manifestBytes);
assert.equal(manifest.platform,'win32');assert.equal(manifest.arch,process.arch);
assert.equal(manifest.sourceSha256,hash(await fs.readFile(path.join(repo,'packages/harness-runtime/native/session-execution-windows.c'))));
const pin=async()=>{
 assert.equal(await fs.realpath(binary),binary);assert.ok((await fs.lstat(binary)).isFile());
 assert.equal(hash(await fs.readFile(binary)),manifest.sha256);
 assert.deepEqual(await fs.readFile(manifestFile),manifestBytes);
};
const probe=pid=>{
 const value=JSON.parse(execFileSync(binary,['--inspect-process',String(pid)],{encoding:'utf8',timeout:5000,maxBuffer:4096}));
 assert.deepEqual(Object.keys(value).sort(),['active','inJob','pid','protocol','startIdentity']);
 assert.equal(value.protocol,'devryan.windows-process-identity/1');assert.equal(value.pid,pid);
 assert.match(value.startIdentity,/^win32:[a-f0-9]{16}$/);
 assert.equal(typeof value.active,'boolean');assert.equal(typeof value.inJob,'boolean');
 return value;
};
await pin();
const host=probe(process.pid);assert.equal(host.active,true);
assert.deepEqual(probe(process.pid),host,'Stable host PID changed its creation identity');
const parentProof=JSON.parse(execFileSync(binary,['--inspect-parent'],{encoding:'utf8',timeout:5000,maxBuffer:4096}));
assert.deepEqual(parentProof,host,'Native retained parent handle did not bind the actual caller');
const jobBoundary=JSON.parse(execFileSync(binary,['--inspect-job-boundary'],{encoding:'utf8',timeout:5000,maxBuffer:4096}));
await fs.writeFile(path.join(root,'job-boundary-probe.json'),JSON.stringify({schema:1,
 scope:'Unqualified empty-job diagnostic only; no confinement or admission authority',
 supervisorSha256:manifest.sha256,manifestSha256:hash(manifestBytes),jobBoundary},null,2)+'\n',{flag:'wx'});
validateWindowsJobBoundary(jobBoundary,host.inJob);
for(const argument of ['0','-1','1x','4294967296',' 1']){
 const result=spawnSync(binary,['--inspect-process',argument],{encoding:'utf8',timeout:5000,maxBuffer:4096});
 assert.equal(result.status,125);assert.equal(result.stdout,'');
}
let child,closed,identity;
try {
 child=spawn(process.execPath,['-e','process.stdout.write("ready\\n");setInterval(()=>{},1000)'],{stdio:['ignore','pipe','pipe']});
 closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
 await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('Owned identity child did not start')),10000);
  child.once('error',error=>{clearTimeout(timer);reject(error)});
  child.stdout.once('data',()=>{clearTimeout(timer);resolve()});
 });
 identity=probe(child.pid);assert.equal(identity.active,true);assert.notEqual(identity.startIdentity,host.startIdentity);
 assert.deepEqual(probe(child.pid),identity);
} finally {
 if(child && child.exitCode===null && child.signalCode===null)child.kill('SIGTERM');
 if(closed){let timer;try {await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Owned identity child did not exit')),10000)})]);}finally{clearTimeout(timer)}}
}
await pin();
const lockFixture=await fs.mkdtemp(path.join(repo,'.cache/test-fixtures/windows-owner-'));
let owner,keeper;
const ownerLock={live:false,lost:false,abruptLoss:false};
try {
 const directory=path.join(lockFixture,'private-owners');
 owner=await createExecutionHostOwner({directory,launcher:binary});
 assert.equal(await executionHostOwnerLost({directory,launcher:binary,id:owner.id}),false);
 ownerLock.live=true;owner.assert();
 await owner.close();
 assert.equal(await executionHostOwnerLost({directory,launcher:binary,id:owner.id}),true);
 ownerLock.lost=true;
 owner=await createExecutionHostOwner({directory,launcher:binary,spawnImpl:(...args)=>{keeper=spawn(...args);return keeper}});
 const reaped=new Promise(resolve=>keeper.once('close',resolve));
 assert.equal(await executionHostOwnerLost({directory,launcher:binary,id:owner.id}),false);
 keeper.kill('SIGKILL');
 let timer;
 try {await Promise.race([reaped,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Keeper death unconfirmed')),5000)})]);}
 finally {clearTimeout(timer)}
 assert.equal(owner.signal.aborted,true);
 assert.equal(await executionHostOwnerLost({directory,launcher:binary,id:owner.id}),true);
 ownerLock.abruptLoss=true;
} finally {await owner?.close();await fs.rm(lockFixture,{recursive:true,force:true})}
await pin();
const cancellation=[];
for(const early of [false,true]){
 const fixture=path.join(repo,'.cache/test-fixtures',`windows-cancel-${randomUUID()}`);
 await ensureWindowsPrivateDirectory(binary,fixture);
 const viewDirectory=path.join(fixture,'worktree');await ensureWindowsPrivateDirectory(binary,viewDirectory);
 const lease={viewDirectory};let handle,timer;
 try{
  let ready;const started=new Promise(resolve=>{ready=resolve});
  const writer="const fs=require('node:fs');fs.appendFileSync('heartbeat','started');console.log('ready');setInterval(()=>fs.appendFileSync('heartbeat','x'),5)";
  handle=await startSessionExecution({launcher:binary,lease,command:process.execPath,
   args:['-e',`const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(writer)}],{stdio:['ignore','pipe','pipe']});child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);setInterval(()=>{},1000)`],
   env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot??process.env.SYSTEMROOT},
   onOutput:({stream,data})=>{if(stream==='stdout'&&data.toString().includes('ready'))ready()}});
  if(!early){
   await Promise.race([started,handle.result.then(()=>{throw Error('Cancellation command exited before readiness')}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Cancellation readiness timeout')),10000)})]);
   clearTimeout(timer);
   const observed=probe(handle.pid);
   for(const identity of ['win32:0000000000000000',observed.startIdentity]){
    const refusal=spawnSync(binary,['--cancel',`Local\\DevRyan-${randomUUID()}`,String(handle.pid),identity],{encoding:'utf8',timeout:5000,maxBuffer:4096});
    assert.equal(refusal.status,125);assert.equal(probe(handle.pid).active,true);
   }
  }
  handle.cancel();
  const receipt=await Promise.race([handle.result,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Cancellation receipt timeout')),10000)})]);
  clearTimeout(timer);assert.equal(receipt.cancelled,true);assert.equal(receipt.confined,true);assert.equal(receipt.exitCode,130);
  assert.deepEqual(await readSessionExecutionReceipt(lease,{launcher:binary}),receipt);
  const heartbeat=path.join(viewDirectory,'heartbeat'),before=await fs.readFile(heartbeat).catch(()=>Buffer.alloc(0));
  if(!early)assert.ok(before.length>=7);
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.deepEqual(await fs.readFile(heartbeat).catch(()=>Buffer.alloc(0)),before);
  cancellation.push({mode:early?'before-event-creation':'running-descendant',status:'passed',receipt,
   receiptSha256:hash(await fs.readFile(path.join(fixture,'termination.json')))});
 }finally{
  clearTimeout(timer);
  if(handle?.child.exitCode===null&&handle.child.signalCode===null)handle.child.kill('SIGKILL');
  await handle?.result.catch(()=>{});await fs.rm(fixture,{recursive:true,force:true});
 }
}
await pin();
const evidence={schema:1,status:'passed',scope:'Windows SDK process identity, host lifetime and owned cancellation prerequisites; no admission or complete acceptance authority',
 sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),platform:process.platform,arch:process.arch,
 supervisorSha256:manifest.sha256,manifestSha256:hash(manifestBytes),host,parentProof,jobBoundary,ownerLock,cancellation,child:identity,childExit:await closed};
await fs.writeFile(path.join(root,'host-boundary-evidence.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(evidence));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
