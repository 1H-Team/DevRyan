import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

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
const evidence={schema:1,status:'passed',scope:'read-only Windows SDK process creation/liveness and containing-job probes; no confinement/admission authority',
 sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),platform:process.platform,arch:process.arch,
 supervisorSha256:manifest.sha256,manifestSha256:hash(manifestBytes),host,parentProof,jobBoundary,child:identity,childExit:await closed};
await fs.writeFile(path.join(root,'host-boundary-evidence.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(evidence));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
