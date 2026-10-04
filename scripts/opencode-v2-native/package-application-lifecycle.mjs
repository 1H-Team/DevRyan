import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { prepareRuntimeUiProfile } from '../qa/native-backend-ui-diagnostic.mjs';
import { createQaNativeLaunchEnvironment } from '../qa/native-profile-preparation.mjs';
import { createQaHostLaunchEnvironment } from '../qa/launch-environment.mjs';
import { readRuntimeBundleBinding } from '../../packages/web/server/lib/opencode/runtime-host/runtime-bundle-binding.js';
import { verifyNativeRuntimeArtifacts } from '../../packages/web/server/lib/opencode/runtime-host/native-artifacts.js';
import { reapOrphanedManagedOpenCodeProcesses, readManagedOpenCodeRegistry } from '../../packages/web/server/lib/opencode/managed-process-registry.js';
import { readBundleConversationRows } from './package-bundle-upgrade-lane.mjs';
import { snapshotOwnedTree } from './package-rollback-lane.mjs';
import { waitFor } from './process-lanes.mjs';
import { finishApplicationLifecycleEvidence } from './package-application-evidence.mjs';
import { NATIVE_BUNDLE_CREDENTIAL_CONTRACT } from '../../packages/web/server/lib/opencode/runtime-host/native-bundle-credential-contract.js';
import { CLAUDE_LIFECYCLE_PROTOCOL } from '../../packages/web/server/lib/opencode/runtime-host/native-claude-lifecycle.js';
import {armCompiledRollbackCrash,runCompiledColdBundleRecovery} from './package-cold-recovery.mjs';

const exec = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const alive = pid => { try { process.kill(pid,0); return true; } catch(error) { if(error.code==='ESRCH')return false; throw error; } };
const driver = fileURLToPath(new URL('./package-application-lifecycle-driver.mjs',import.meta.url));

/** Run after current default artifacts are staged. Final qualification supplies
 * an independently built predecessor with the same credential contract. */
export async function runCompiledApplicationLifecycle({ artifactRoot, previousArtifactRoot, root, onColdRecovery }) {
  const directory = path.join(root,'application-composition'); await fs.mkdir(directory,{mode:0o700});
  const manifestPath = path.join(artifactRoot,'native-bundle.json'), bytes = await fs.readFile(manifestPath), manifestSha256 = hash(bytes);
  const current = await verifyNativeRuntimeArtifacts({manifestPath,manifestSha256,launcher:path.join(artifactRoot,`DevRyan-execution-${process.platform}-${process.arch}`)});
  const defaultRoot = path.resolve(fileURLToPath(new URL('../../packages/web/runtime/',import.meta.url)),`${process.platform}-${process.arch}`);
  assert.equal(hash(await fs.readFile(path.join(defaultRoot,'native-bundle.json'))),manifestSha256,'Production lifecycle requires the qualified default artifact staged first');
  const oldPublication = path.join(directory,'publication-A');
  await fs.cp(previousArtifactRoot ?? artifactRoot,oldPublication,{recursive:true,errorOnExist:true,force:false});
  if(!previousArtifactRoot)await fs.writeFile(path.join(oldPublication,'native-bundle.json'),Buffer.concat([bytes,Buffer.from('\n')]));
  const oldSHA = hash(await fs.readFile(path.join(oldPublication,'native-bundle.json'))); assert.notEqual(oldSHA,manifestSha256);
  const old = await verifyNativeRuntimeArtifacts({manifestPath:path.join(oldPublication,'native-bundle.json'),manifestSha256:oldSHA,
    launcher:path.join(oldPublication,path.basename(current.launcher))});
  if(previousArtifactRoot){
    assert.equal(old.manifest.inputs.coreDigest,current.manifest.inputs.coreDigest);
    assert.equal(old.manifest.opencodeVersion,current.manifest.opencodeVersion);
    for(const contract of ['devryan-v2-clone/1',NATIVE_BUNDLE_CREDENTIAL_CONTRACT,CLAUDE_LIFECYCLE_PROTOCOL])assert.ok(old.manifest.compiledContracts.includes(contract)&&current.manifest.compiledContracts.includes(contract));
    assert.notEqual(old.manifest.buildId,current.manifest.buildId);
  }else{assert.equal(old.manifest.buildId,current.manifest.buildId);assert.deepEqual(old.manifest.files,current.manifest.files);}
  const workspace=path.join(directory,'workspace'),runtimeRoot=path.join(directory,'profile'),template=path.join(directory,'git-template');
  await fs.mkdir(workspace);await fs.mkdir(runtimeRoot);await fs.mkdir(template);
  await exec('/usr/bin/git',['init','--quiet','--initial-branch=main',`--template=${template}`],{cwd:workspace,
    env:createQaHostLaunchEnvironment({HOME:workspace,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GIT_CEILING_DIRECTORIES:directory}),timeout:10000});
  const profile=await prepareRuntimeUiProfile({cell:{transport:'runtime-fixture'},runtimeRoot,workspace,targetGeneration:2,artifactRoot:oldPublication});
  const results=[], exits=[], processEvidence=[];let ownerSession=null;
  const evidenceIssues=[];let primaryFailure,currentMode=null,completed=false;
  try{
  const controlRoot=profile.env.DEVRYAN_RUNTIME_BUNDLE_ROOT;
  const initialBinding=readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:controlRoot});
  // Both constructor-owned roots stop upward repository discovery; no grant widens.
  await exec('/usr/bin/git',['init','--quiet','--initial-branch=main',`--template=${template}`],{cwd:initialBinding.descriptor.launch.global.home,
    env:createQaHostLaunchEnvironment({HOME:initialBinding.descriptor.launch.global.home,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GIT_CEILING_DIRECTORIES:directory}),timeout:10000});
  const run=async(input,parentDeath=false)=>{
    currentMode=input.mode;
    const binding=readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:controlRoot});
    const env=createQaNativeLaunchEnvironment({binding,runtimeRoot,baseEnvironment:profile.env});
    env.GIT_CONFIG_GLOBAL='/dev/null';env.GIT_CONFIG_NOSYSTEM='1';env.GIT_TERMINAL_PROMPT='0';env.GIT_CEILING_DIRECTORIES=directory;
    const child=fork(driver,[],{cwd:directory,env,execArgv:[],stdio:['pipe','pipe','pipe','ipc']});
    child.on('message',message=>{if(message?.type==='application-owner-session-ready'){child.send({type:'application-owner-session',owner:ownerSession});return;}if(message?.type==='application-owner-session'){assert.equal(ownerSession===null,true,'Duplicate private owner-session handoff');assert.equal(typeof message.owner?.name,'string');assert.equal(typeof message.owner?.value,'string');assert.ok(message.owner.name.length<=256&&message.owner.value.length<=8192);ownerSession={name:message.owner.name,value:message.owner.value};}});
    const output=[],errors=[];let outputBytes=0,stderrBytes=0,failedResult,failedExitTimer;
    // A failed result is emitted only after the driver's original server.stop finally.
    // Record it and close this exact lingering child without waiting the 180s success bound.
    child.stdout.on('data',chunk=>{
      outputBytes+=chunk.length;if(outputBytes>65536){child.kill('SIGTERM');return;}output.push(chunk);
      if(!failedResult&&Buffer.concat(output).includes(10)){
        let reported;try{reported=JSON.parse(Buffer.concat(output).toString('utf8'));}catch{return;}
        if(reported?.status==='failed'&&reported.mode===input.mode){failedResult=reported;child.kill('SIGTERM');
          failedExitTimer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},5000);}
      }
    });
    child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes<=8*1024*1024)errors.push(chunk);});
    let actualExit;
    const closed=new Promise(resolve=>child.once('close',(code,signal)=>{
      actualExit={mode:input.mode,pid:child.pid,code,signal};exits.push(actualExit);resolve({code,signal});
    }));
    const exit=Promise.race([closed,new Promise((_,reject)=>child.once('error',reject))]);void exit.catch(()=>{});
    const evidencePath=path.join(directory,'parent-death-ready.json');
    let dead=false,timedOut=false,modeFailure,crashProbe;
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');},180000);
    try {
      const start=(await exec('/bin/ps',['-p',String(child.pid),'-o','lstart='],{timeout:5000})).stdout.trim();
      processEvidence.push({pid:child.pid,start,mode:input.mode});
      if(input.mode==='rollback-crash')crashProbe=armCompiledRollbackCrash({child,controlRoot,candidate:binding.descriptor,revision:binding.selection.revision,hostStartIdentity:start.replace(/\s+/g,' ')});
      const ready=new Promise((resolve,reject)=>{
        child.on('message',message=>{if(message?.type==='application-parent-death-ready')resolve(message.evidence);});
        void exit.then(value=>reject(Object.assign(new Error('Production application exited before parent-death barrier'),{exit:value})),reject);
      });void ready.catch(()=>{});
      child.stdin.end(JSON.stringify({...input,directory:workspace,evidencePath}));
      if(crashProbe){
        const observed=await crashProbe.ready;dead=true;assert.deepEqual(await exit,{code:null,signal:'SIGKILL'});
        assert.equal(observed.driverEvidence.ownerSessionReused,true);
        assert.equal(alive(observed.crashProof.controller.pid),false,'Original rollback checkpoint did not actually stop its compiled controller');
        results.push({...observed.driverEvidence,crashProof:observed.crashProof});
      }else if(parentDeath){
        const evidence=await ready;assert.equal(evidence.ownerPID,child.pid);assert.equal(evidence.bundleID,binding.descriptor.bundleID);
        assert.equal(evidence.receiptPath,path.join(binding.bundleRoot,'.native-controller',evidence.instanceID,'termination.json'));
        assert.ok(alive(evidence.controllerPID));
        const descendants=[];
        const collect=async pid=>{let values;try{values=(await exec('/usr/bin/pgrep',['-P',String(pid)],{timeout:5000})).stdout.trim().split('\n').filter(Boolean);}catch(error){if(error.code===1)return;throw error;}
          for(const value of values){const pid=Number(value);assert.ok(Number.isSafeInteger(pid)&&pid>0);descendants.push(pid);await collect(pid);}};
        await collect(child.pid);assert.ok(descendants.includes(evidence.controllerPID));
        for(const pid of descendants)processEvidence.push({pid,start:(await exec('/bin/ps',['-p',String(pid),'-o','lstart='],{timeout:5000})).stdout.trim(),mode:'parent-death-descendant'});
        child.kill('SIGKILL');dead=true;assert.deepEqual(await exit,{code:null,signal:'SIGKILL'});
        const receipt=await waitFor(async()=>{try{return JSON.parse(await fs.readFile(evidence.receiptPath,'utf8'));}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return null;throw error;}},
          value=>value?.terminated===true,'Actual application parent death did not confirm native termination',15000);
        assert.equal(receipt.confined,true);assert.equal(receipt.cancelled,true);assert.equal(receipt.exitCode,137);
        await waitFor(()=>descendants.every(pid=>!alive(pid)),Boolean,'Actual application parent death retained an owned descendant',15000);
        const reaped=await reapOrphanedManagedOpenCodeProcesses({registryPath:evidence.registryPath});assert.deepEqual(reaped.kept,[]);
        assert.deepEqual(readManagedOpenCodeRegistry({registryPath:evidence.registryPath}),[]);
        results.push({status:'passed',mode:input.mode,evidence,receipt,terminatedPIDs:descendants});
      }else{
        const actual=await exit;
        await fs.writeFile(path.join(directory,`application-${input.mode}-stdout.json`),Buffer.concat(output),{mode:0o600});
        const result=JSON.parse(Buffer.concat(output).toString('utf8'));
        if(result.status==='failed')throw Object.assign(new Error(result.error?.code??'application_driver_failed'),{code:result.error?.code??'application_driver_failed',actualExit:actual,driverResult:result});
        assert.equal(result.status,'passed');assert.equal(result.ownerSessionReused,input.mode!=='upgrade');assert.equal(actual.code,0);assert.equal(actual.signal,null);assert.equal(timedOut,false);assert.ok(outputBytes<=65536);results.push(result);
      }
      assert.equal(alive(child.pid),false);
    }catch(error){modeFailure=error;throw error;}finally{
      clearTimeout(timer);clearTimeout(failedExitTimer);crashProbe?.close();
      let cleanupFailure;
      try{
        if(!dead&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');const force=setTimeout(()=>child.kill('SIGKILL'),5000);try{await closed;}finally{clearTimeout(force);}}
        else await closed;
      }catch(error){cleanupFailure=error;evidenceIssues.push('child-close-failed');}
      try{if(actualExit)await fs.writeFile(path.join(directory,`application-${input.mode}-exit.json`),JSON.stringify(actualExit)+'\n',{mode:0o600});}
      catch(error){cleanupFailure??=error;evidenceIssues.push('child-exit-evidence-write-failed');}
      try{await fs.writeFile(path.join(directory,`application-${input.mode}.log`),Buffer.concat(errors));}
      catch(error){cleanupFailure??=error;evidenceIssues.push('child-log-write-failed');}
      if(cleanupFailure&&!modeFailure)throw cleanupFailure;
    }
    return results.at(-1);
  };
    const qualifyStopProvider=(proof,descriptor,expectedCount,scope)=>{
      const requests=profile.evidence.providerRequests;assert.equal(requests.length,expectedCount,'Production Stop fixture must isolate exactly its expected provider attempts');
      assert.equal(proof.scope,scope);assert.equal(proof.bundleID,descriptor.bundleID);assert.equal(proof.manifestSha256,descriptor.launch.artifactManifestSha256);
      const stopProvider=requests[expectedCount-1];assert.equal(stopProvider.model,'smoke-write');assert.equal(stopProvider.requestID,`http_${expectedCount}`);
      assert.equal(new Set(requests.map(row=>row.requestID)).size,expectedCount);assert.match(stopProvider.requestSha256,/^[a-f0-9]{64}$/);
      assert.ok(stopProvider.startedAt>=proof.submittedAt && stopProvider.startedAt<=proof.stopRequestedAt,'Stop must occur after its exact original provider request actually started');
      assert.ok(stopProvider.startedAt<=proof.streamObservedAt && proof.streamObservedAt<=proof.stopRequestedAt && proof.streamedTextBytes>0,'Stop must follow actual native streamed text from its exact provider attempt');
      const stream=proof.streamEvent;assert.equal(stream?.source,'production-global-event-text-delta');
      assert.equal(stream.sessionID,proof.sessionID);assert.equal(stream.messageID,proof.assistantID);assert.match(stream.partID,/^[A-Za-z0-9_:-]{1,160}$/);
      assert.ok(stream.readyAt<=proof.submittedAt && stream.observedAt===proof.streamObservedAt);
      assert.ok(stream.deltaCount>0 && stream.deltaBytes===proof.streamedTextBytes);
      proof.providerRequest={requestID:stopProvider.requestID,startedAt:stopProvider.startedAt,requestSha256:stopProvider.requestSha256};
    };
    const a=readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:controlRoot}).descriptor;
    assert.equal(a.launch.artifactManifestSha256,oldSHA);
    const upgraded=await run({mode:'upgrade'});assert.equal(upgraded.transition.selectedManifestSha256,manifestSha256);
    qualifyStopProvider(upgraded.stopProof,a,2,'old-A-streaming-Stop');
    const b=readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:controlRoot}).descriptor;assert.equal(b.sourceBundleID,a.bundleID);
    assert.equal(b.launch.artifactManifestSha256,manifestSha256);
    assert.ok(b.launch.artifactManifestPath.startsWith(path.join(controlRoot,'artifacts',manifestSha256)+path.sep));
    const crashed=await run({mode:'rollback-crash',sessionIDs:upgraded.sessionIDs,history:upgraded.history});
    qualifyStopProvider(crashed.stopProof,b,4,'candidate-B-streaming-Stop');
    const recoveryBinding=readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:controlRoot},{allowHeldInspection:true});
    const recoveryEnvironment=createQaNativeLaunchEnvironment({binding:recoveryBinding,runtimeRoot,baseEnvironment:profile.env});
    recoveryEnvironment.GIT_CONFIG_GLOBAL='/dev/null';recoveryEnvironment.GIT_CONFIG_NOSYSTEM='1';recoveryEnvironment.GIT_TERMINAL_PROMPT='0';recoveryEnvironment.GIT_CEILING_DIRECTORIES=directory;
    currentMode='cold-recovery';
    results.push(await runCompiledColdBundleRecovery({controlRoot,environment:recoveryEnvironment,directory,crashProof:crashed.crashProof,beforeResume:onColdRecovery}));
    const retainedHistory={...upgraded.history,[crashed.candidateSessionID]:crashed.candidateStopHistory};
    await run({mode:'resumed-inspection',sessionIDs:Object.keys(retainedHistory),history:retainedHistory});
    assert.equal(profile.evidence.providerRequests.length,4,'Cold recovery/resume/inspection must not create provider attempts');
    const rolledBack=await run({mode:'rollback',sessionIDs:upgraded.sessionIDs,history:upgraded.history});assert.equal(rolledBack.transition.bundleID,a.bundleID);
    qualifyStopProvider(rolledBack.stopProof,b,6,'candidate-B-streaming-Stop');
    assert.notEqual(rolledBack.stopProof.providerRequest.requestID,upgraded.stopProof.providerRequest.requestID);
    assert.equal(rolledBack.stopProof.sessionID,rolledBack.candidateSessionID);
    assert.ok(rolledBack.candidateStopHistory.includes(rolledBack.stopProof.userID) && rolledBack.candidateStopHistory.includes(rolledBack.stopProof.assistantID));
    const retainedB=await snapshotOwnedTree(path.dirname(b.preparedManifestPath));
    await run({mode:'inspection',sessionIDs:upgraded.sessionIDs,history:upgraded.history});
    assert.equal(profile.evidence.providerRequests.length,6,'Inspection must not create additional provider attempts');
    assert.deepEqual(await snapshotOwnedTree(path.dirname(b.preparedManifestPath)),retainedB);
    assert.equal(readBundleConversationRows(a).sessions.some(row=>row.id===rolledBack.candidateSessionID),false);
    assert.equal(readBundleConversationRows(a).sessions.some(row=>row.id===crashed.candidateSessionID),false);
    await run({mode:'parent-death',sessionIDs:upgraded.sessionIDs,history:upgraded.history},true);
    assert.equal(profile.evidence.providerRequests.length,6,'Parent-death startup must not create additional provider attempts');
    await profile.verifyInputs();
    completed=true;
    return {id:'compiled-production-application-bundle-lifecycle',status:'passed',root:directory,results,exits,processEvidence,
      publication:{oldManifestSha256:oldSHA,currentManifestSha256:manifestSha256,oldBuildId:old.manifest.buildId,buildId:current.manifest.buildId,
        scope:previousArtifactRoot?'Actual prior verified compiled artifact A to current verified compiled artifact B; same core/schema and contracts; oldA linked inputs historical only':'same signed binary and contracts; byte-distinct manifest publication detection, not cross-version qualification'},
      source:'actual server/index application Stop/restart/authenticated-upgrade/pending-rollback-crash/cold-held-CLI-resume/final-rollback/new-process-recomposition-and-parent-death'};
  }catch(error){primaryFailure=error;throw error;}finally{
    await finishApplicationLifecycleEvidence({directory,profile,mode:currentMode,completed,results,exits,
      processEvidence,issues:evidenceIssues,primaryFailure});
  }
}
