import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {loadQaPackagedArtifact} from './packaged-artifact.mjs';
import {captureQaArtifactIdentity} from './artifact-evidence.mjs';
import {createQaHostLaunchEnvironment} from './launch-environment.mjs';
import {reservePort,startOwnedProcess} from './process.mjs';
import {CdpConnection,discoverPageTarget,evaluate} from './cdp.mjs';
import {createQaUiDriver} from './ui-driver.mjs';
import {readRuntimeBundleBinding} from '../../packages/web/server/lib/opencode/runtime-host/runtime-bundle-binding.js';
import {assertRollbackPhysicalExit,captureRollbackFiles,readRollbackIntentSync} from '../../packages/web/server/lib/opencode/runtime-host/bundle-rollback-intent.js';

const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const execute=promisify(execFile);
const fail=code=>Object.assign(new Error(code),{code});
const inside=(parent,child)=>child.startsWith(parent+path.sep);

export function assertQaColdRecoveryState(value,revision){
 assert.equal(value?.state,'held');
 assert.equal(value.revision,revision);
 assert.equal(value.reconciliationRequired,true);
 assert.equal(value.resumeAvailable,true);
 assert.equal(value.recoveryRequiresOriginalCheckpoint,true);
}

// Actual trusted preload invocation, not a substitute HTTP mutation route.
export async function probeQaColdRecoveryIpc(read,revision){
 const outcomes=[];
 for(const [kind,args] of [['stale',{expectedRevision:revision+1}],['foreign',{expectedRevision:revision,extra:true}],['invalid',{expectedRevision:0}]]){
  const value=await read(`(async()=>{try{await window.__TAURI__.core.invoke('desktop_runtime_bundle_resume',${JSON.stringify(args)});return {accepted:true};}catch(error){const match=String(error?.message??error).match(/\\bbundle_[a-z0-9_]+\\b/);return {accepted:false,code:match?.[0]??'unclassified'};}})()`);
  assert.deepEqual(value,{accepted:false,code:'bundle_selection_revision_conflict'});
  outcomes.push({kind,...value});
 }
 return outcomes;
}

/** Real packaged main/preload cold inspection. The caller owns the original
 * crash transition; this helper never accepts a native resume dialog. */
export async function runQaPackagedBundleRecovery({controlRoot,environment,directory,crashProof,status,
 packageEvidencePath,root=repository,cancelNativeDialog}){
 root=await fs.realpath(root);
 if(root!==repository||!inside(path.join(root,'.cache'),directory)||await fs.realpath(directory)!==directory
  ||!inside(path.join(root,'.cache'),controlRoot)||await fs.realpath(controlRoot)!==controlRoot
  ||environment?.DEVRYAN_RUNTIME_BUNDLE_ROOT!==controlRoot)throw fail('qa_cold_recovery_scope_invalid');
 if(status?.status!=='passed'||status.state!=='held'||status.controllerStarts!==0||status.featureOwners!==false
  ||status.httpMutationsRefused!==true)throw fail('qa_cold_recovery_prerequisite_missing');
 const binding=readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:controlRoot},{allowHeldInspection:true});
 assert.equal(binding.admission,'held');assert.equal(binding.selection.revision,crashProof.revision);
 assert.equal(binding.descriptor.bundleID,crashProof.candidateBundleID);
 const candidateRoot=path.dirname(binding.descriptor.preparedManifestPath);
 const intentFile=path.join(controlRoot,'rollback','intent.json'),selectionFile=path.join(controlRoot,'selection.json');
 const intentBytes=await fs.readFile(intentFile),selectionBytes=await fs.readFile(selectionFile);
 assert.equal(hash(intentBytes),crashProof.intentSha256);
 const intent=readRollbackIntentSync(controlRoot);
 await assertRollbackPhysicalExit(intent,binding.descriptor);
 const beforeFiles=await captureRollbackFiles(candidateRoot);
 // Includes transient paths omitted by the original durable inventory: a new
 // controller receipt, runtime log or feature lock also fails this inspection.
 const beforeWhole=await captureQaArtifactIdentity(candidateRoot);
 const settingsPath=path.join(binding.descriptor.launch.webDataDirectory,'settings.json');
 const settingsBytes=await fs.readFile(settingsPath).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
 const packaged=await loadQaPackagedArtifact({root,evidencePath:packageEvidencePath});
 const output=await fs.mkdtemp(path.join(directory,'packaged-cold-recovery-'));
 await fs.chmod(output,0o700);
 const home=path.join(output,'home'),data=path.join(output,'data'),profile=path.join(output,'browser');
 await fs.mkdir(home,{mode:0o700});await fs.mkdir(data,{mode:0o700});
 await fs.writeFile(path.join(home,'.devryan-qa-home'),'owned packaged cold recovery\n',{mode:0o600});
 await fs.writeFile(path.join(data,'settings.json'),'{}\n',{mode:0o600});
 await fs.writeFile(path.join(output,'credentials.env.json'),'{}\n',{mode:0o600});
 const result={status:'failed',scope:'packaged-cold-recovery-inspection',output,revision:crashProof.revision,
  bundleID:crashProof.candidateBundleID,package:{evidencePath:packaged.evidencePath,archiveSha256:packaged.evidence.archiveSha256},
  screenshots:[],cleanupErrors:[],nativeDialogCancellation:{status:'unavailable',reason:'trusted-native-dialog-cancellation-not-supplied'},
  limits:['No successful resume or new checkpoint is claimed.','Owned OS ancestry is sampled by the existing QA process owner; file/registry identity supplements sampling.']};
 let child,cdp,primaryError;
 const unchanged=async()=>{
  assert.deepEqual(await fs.readFile(selectionFile),selectionBytes,'Packaged recovery changed selection');
  assert.deepEqual(await fs.readFile(intentFile),intentBytes,'Packaged recovery changed original proof');
  assert.deepEqual(await captureRollbackFiles(candidateRoot),beforeFiles,'Packaged recovery changed retained B');
  assert.equal((await captureQaArtifactIdentity(candidateRoot)).sha256,beforeWhole.sha256,'Packaged recovery started or changed a B owner');
  assert.deepEqual(await fs.readFile(settingsPath).catch(error=>{if(error.code==='ENOENT')return null;throw error;}),settingsBytes,'Packaged recovery changed B desktop settings');
  await assertRollbackPhysicalExit(intent,binding.descriptor);
 };
 const screenshot=async label=>{
  const file=path.join(output,label+'.png');
  const {data:png}=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  const bytes=Buffer.from(png,'base64');await fs.writeFile(file,bytes,{mode:0o600});
  result.screenshots.push({path:file,sha256:hash(bytes)});return file;
 };
 try{
  const debugPort=await reservePort(),port=await reservePort();
  const env=createQaHostLaunchEnvironment(environment,{DEVRYAN_QA_RUNTIME:'electron',DEVRYAN_QA_RUNTIME_ROOT:output,
   DEVRYAN_QA_HOME:home,OPENCHAMBER_DATA_DIR:data,OPENCHAMBER_ELECTRON_USER_DATA_DIR:profile,OPENCHAMBER_PORT:String(port),
   HOME:home,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_DATA_HOME:path.join(home,'.local','share'),
   XDG_STATE_HOME:path.join(home,'.local','state'),XDG_CACHE_HOME:path.join(home,'.cache'),
   TMPDIR:output,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'});
  delete env.ELECTRON_RUN_AS_NODE;delete env.OPENCHAMBER_SERVER_URL;delete env.NODE_OPTIONS;
  delete env.NODE_PATH;delete env.MERIDIAN_PROFILES;delete env.MERIDIAN_DEFAULT_PROFILE;delete env.CLAUDE_CODE_OAUTH_TOKEN;
  child=startOwnedProcess(packaged.binary,[`--remote-debugging-port=${debugPort}`,`--user-data-dir=${profile}`],{cwd:root,env});
  const target=await discoverPageTarget(debugPort);
  cdp=await CdpConnection.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');await cdp.send('Runtime.enable');
  const ui=createQaUiDriver(cdp,{checkAlive:()=>child.check()});
  await ui.waitExpression('actual packaged cold recovery page',`location.protocol==='http:'&&location.hostname==='127.0.0.1'&&location.pathname==='/'&&document.querySelector('h1')?.textContent==='Runtime recovery is required'&&typeof window.__TAURI__?.core?.invoke==='function'`,90000);
  const host=JSON.parse(await fs.readFile(path.join(output,'packaged-host.json'),'utf8'));
  assert.equal(host.isPackaged,true);assert.equal(host.packagedMain,'dist-bundle/main.mjs');
  const inspected=await evaluate(cdp,`fetch('/api/runtime/bundle').then(r=>r.json())`);
  assertQaColdRecoveryState(inspected,crashProof.revision);result.inspection=inspected;
  const health=await evaluate(cdp,`fetch('/api/health').then(async r=>({status:r.status,value:await r.json()}))`);
  assert.equal(health.status,503);assert.equal(health.value.isOpenCodeReady,false);
  assert.equal(health.value.executionRuntime?.state,'held');
  result.features=await evaluate(cdp,`Promise.all(['/api/provider','/api/session','/api/config'].map(async path=>{const response=await fetch(path);const body=await response.json();return {path,status:response.status,code:body.code};}))`);
  for(const row of result.features)assert.deepEqual(row,{path:row.path,status:503,code:'bundle_rollback_reconciliation_required'});
  result.ipcRefusals=await probeQaColdRecoveryIpc(expression=>evaluate(cdp,expression),crashProof.revision);
  await unchanged();await screenshot('held-recovery');
  if(cancelNativeDialog){
   // The supplied callback must perform actual trusted user input against this
   // owned app. Returning true cannot substitute for the real IPC result.
   const reply=evaluate(cdp,`window.__TAURI__.core.invoke('desktop_runtime_bundle_resume',{expectedRevision:${crashProof.revision}})`);
   reply.catch(()=>{});
   await cancelNativeDialog({pid:child.child.pid,output,title:'Resume retained runtime',cancelLabel:'Cancel'});
   assert.deepEqual(await reply,{state:'cancelled'});
   result.nativeDialogCancellation={status:'passed',result:{state:'cancelled'}};
   await unchanged();await screenshot('cancelled-recovery');
  }
  const observed=child.getCleanupEvidence().observedProcesses;
  const nativeNames=new Set([path.basename(binding.descriptor.launch.controllerBinary),path.basename(binding.descriptor.launch.writerBinary)]);
  let inspectedProcesses=0;
  for(const row of observed){
   const command=await execute('/bin/ps',['-p',String(row.pid),'-o','comm='],{timeout:5000,maxBuffer:8192}).catch(error=>{if(error.code===1)return {stdout:''};throw error;});
   if(!command.stdout.trim())continue;
   assert.equal(nativeNames.has(path.basename(command.stdout.trim())),false,'Cold recovery launched a native controller/writer');inspectedProcesses++;
  }
  result.nativeControllers={observedStarts:0,inspectedOwnedProcesses:inspectedProcesses,unchangedControllerAndRegistryFiles:true};
 }catch(error){primaryError=error;result.error=/^[a-z][a-z0-9_]+$/.test(error.code??'')?error.code:'qa_packaged_cold_recovery_failed';}
 finally{
  cdp?.close();
  if(child){
   try{await child.stop();await child.auditStopped();}catch{result.cleanupErrors.push('owned Electron cleanup failed');}
   result.ownedProcessCleanup=child.getCleanupEvidence();
   result.originalExit={code:child.child.exitCode,signal:child.child.signalCode};
   result.processLogSha256=hash(child.getLog());
  }
  try{await unchanged();result.retainedStateUnchanged=true;}catch(error){result.cleanupErrors.push('retained recovery state changed');primaryError??=error;}
  try{await loadQaPackagedArtifact({root,evidencePath:packaged.evidencePath});result.packageUnchanged=true;}catch(error){result.cleanupErrors.push('packaged artifact changed');primaryError??=error;}
  if(!primaryError&&!result.cleanupErrors.length){
   if(result.originalExit?.code===0&&result.originalExit.signal===null)result.status='passed';
   else{result.cleanupErrors.push('owned Electron did not exit naturally with code zero');primaryError=fail('qa_packaged_cold_recovery_exit_failed');}
  }
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});
 }
 if(primaryError||result.cleanupErrors.length)throw Object.assign(fail('qa_packaged_cold_recovery_failed'),{evidence:result});
 return result;
}
