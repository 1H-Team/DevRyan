import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {executionArtifacts} from '../execution-artifacts.js';
import {verifyNativeRuntimeArtifacts} from './native-artifacts.js';
import {startParentDeathWatchdog} from '../parent-death-watchdog.js';

import {NATIVE_BUNDLE_CREDENTIAL_CONTRACT,NATIVE_BUNDLE_CREDENTIAL_BYTES,parseNativeBundleCredentialBoot,nativeBundleCredentialFingerprint} from './native-bundle-credential-contract.js';
export {NATIVE_BUNDLE_CREDENTIAL_CONTRACT,parseNativeBundleCredentialBoot} from './native-bundle-credential-contract.js';
const bound=NATIVE_BUNDLE_CREDENTIAL_BYTES;
const fail=code=>Object.assign(new Error(code),{code,status:503});
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const hash=nativeBundleCredentialFingerprint;

/** Offline recovery only: no ordinary HTTP and no provider/session owner.
 * Secrets stay in private pipe buffers; only finite failure codes leave it. */
export async function runNativeBundleCredentialProcess({descriptor,action,assertHeld,captureArtifacts,timeoutMs=120000,verifyArtifacts=verifyNativeRuntimeArtifacts}){
 if(typeof assertHeld!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>300000)throw fail('bundle_credential_launch_invalid');
 await assertHeld();
 const launch=descriptor.launch;
 const original=await verifyArtifacts({manifestPath:launch.artifactManifestPath,manifestSha256:launch.artifactManifestSha256,launcher:executionArtifacts(path.dirname(launch.artifactManifestPath)).launcher});
 if(original.controller!==launch.controllerBinary)throw fail('bundle_credential_contract_incompatible');
 let artifacts=original;
 if(captureArtifacts!==undefined){
  // Only a constructor-owned compatible capture can use the new controller
  // to inspect old A. Projection always uses A's own declared contract.
  const controlRoot=path.dirname(path.dirname(path.dirname(launch.webDataDirectory)));
  if(action.action!=='capture'||!record(captureArtifacts)||Object.keys(captureArtifacts).some(key=>!['manifestPath','manifestSha256'].includes(key))
   ||!digest(captureArtifacts.manifestSha256)||captureArtifacts.manifestPath!==path.join(controlRoot,'artifacts',captureArtifacts.manifestSha256,'native-bundle.json'))throw fail('bundle_credential_contract_incompatible');
  artifacts=await verifyArtifacts({manifestPath:captureArtifacts.manifestPath,manifestSha256:captureArtifacts.manifestSha256,launcher:executionArtifacts(path.dirname(captureArtifacts.manifestPath)).launcher});
  if(original.manifest.opencodeVersion!==artifacts.manifest.opencodeVersion||!digest(original.manifest.inputs?.coreDigest)
   ||original.manifest.inputs.coreDigest!==artifacts.manifest.inputs?.coreDigest||!Array.isArray(artifacts.manifest.compiledContracts)
   ||!artifacts.manifest.compiledContracts.includes('devryan-v2-clone/1'))throw fail('bundle_credential_contract_incompatible');
 }
 if(!Array.isArray(artifacts.manifest.compiledContracts)||!artifacts.manifest.compiledContracts.includes(NATIVE_BUNDLE_CREDENTIAL_CONTRACT))throw fail('bundle_credential_contract_incompatible');
 const request=parseNativeBundleCredentialBoot({protocol:NATIVE_BUNDLE_CREDENTIAL_CONTRACT,requestID:randomUUID(),instanceID:randomUUID(),buildID:artifacts.manifest.buildId,
  bundleID:descriptor.bundleID,databasePath:launch.opencodeDatabasePath,webDataDirectory:launch.webDataDirectory,globals:launch.global,action});
 for(const file of [request.databasePath,...Object.values(request.globals),request.webDataDirectory])if(await fs.realpath(file)!==file)throw fail('bundle_credential_binding_invalid');
 await assertHeld();
 const child=spawn(artifacts.controller,['--bundle-credentials','--native-instance',request.instanceID],{cwd:request.globals.home,
  env:{PATH:process.env.PATH,LANG:process.env.LANG||'en_US.UTF-8',HOME:request.globals.home,XDG_CONFIG_HOME:request.globals.config,XDG_DATA_HOME:request.globals.data,
   XDG_STATE_HOME:request.globals.state,XDG_CACHE_HOME:request.globals.cache,TMPDIR:request.globals.tmp},stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32',windowsHide:true});
 let cause,output=Buffer.alloc(0),stderrBytes=0,killTimer,exitTimer;
 const signal=name=>{if(!child.pid)return;try{if(process.platform!=='win32')process.kill(-child.pid,name);else child.kill(name);}catch(error){if(error.code!=='ESRCH')cause??=fail('bundle_credential_termination_failed');}};
 const watchdog=startParentDeathWatchdog({childPid:child.pid,migrationInstanceID:request.instanceID});
 const outcome=await new Promise((resolve,reject)=>{
  const terminate=code=>{cause??=fail(code);signal('SIGTERM');killTimer??=setTimeout(()=>signal('SIGKILL'),1000);exitTimer??=setTimeout(()=>reject(fail('bundle_credential_exit_unconfirmed')),5000);};
  const timer=setTimeout(()=>terminate('bundle_credential_timeout'),timeoutMs);
  child.on('error',()=>terminate('bundle_credential_launch_failed'));child.stdin.on('error',()=>terminate('bundle_credential_input_failed'));
  child.stdout.on('data',bytes=>{if(output.length+bytes.length>bound)terminate('bundle_credential_output_bound');else output=Buffer.concat([output,bytes]);});
  child.stderr.on('data',bytes=>{stderrBytes+=bytes.length;if(stderrBytes>bound)terminate('bundle_credential_stderr_bound');});
  child.once('close',(code,signalName)=>{clearTimeout(timer);clearTimeout(killTimer);clearTimeout(exitTimer);watchdog.dispose();signal('SIGKILL');if(cause)reject(cause);else resolve({code,signal:signalName});});
  if(watchdog.error)terminate('bundle_credential_watchdog_failed');else child.stdin.end(JSON.stringify(request)+'\n');
 });
 await assertHeld();
 let reply;try{reply=JSON.parse(output.toString('utf8'));}catch{throw fail('bundle_credential_reply_invalid');}finally{output.fill(0);}
 if(!record(reply)||reply.protocol!==request.protocol||reply.requestID!==request.requestID||reply.instanceID!==request.instanceID||reply.buildID!==request.buildID
  ||Object.keys(reply).some(key=>!['protocol','requestID','instanceID','buildID','ok','result','error'].includes(key)))throw fail('bundle_credential_reply_invalid');
 if(reply.ok===false){
  if(outcome.code===0||outcome.signal||!record(reply.error)||Object.keys(reply.error).some(key=>!['code','status'].includes(key))
   ||!/^bundle_credential_[a-z0-9_]{1,80}$/.test(reply.error.code)||reply.error.status!==503)throw fail('bundle_credential_reply_invalid');
  throw fail(reply.error.code);
 }
 if(outcome.code!==0||outcome.signal||reply.ok!==true||!record(reply.result)||reply.result.protocol!==request.protocol)throw fail('bundle_credential_exit_unconfirmed');
 const result=reply.result;
 if(action.action==='capture'){
  if(result.status!=='captured'||!record(result.snapshot)||!digest(result.sha256)||hash(result.snapshot)!==result.sha256
   ||Object.keys(result).some(key=>!['protocol','status','snapshot','sha256'].includes(key)))throw fail('bundle_credential_reply_invalid');
 }else if(result.status!=='projected'||result.appliedSha256!==action.binding.sourceSha256
  ||Object.entries(action.binding).some(([key,value])=>result[key]!==value)
  ||Object.keys(result).some(key=>!['protocol','status','appliedSha256',...Object.keys(action.binding)].includes(key)))throw fail('bundle_credential_reply_invalid');
 return result;
}
