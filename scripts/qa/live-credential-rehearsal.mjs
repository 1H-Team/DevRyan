// Real compiled/source owners with synthetic grants. Never paid inference,
// installed profiles, the user's Keychain or a CLI runtime override.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {PassThrough} from 'node:stream';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {qaRepository,qaCache,qaHash,readQaPinnedFile,prepareLiveSetupMirror} from './live-setup-mirror.mjs';
import {prepareLiveCredentialSession,runLiveCredentialOwner} from './live-credential-owner.mjs';
import {createQaNativePreparationFactory} from './native-profile-factory.mjs';
import {prepareQaNativeBundle,prepareQaNativeProfile,createQaNativeLaunchEnvironment,readQaNativeSelectionView} from './native-profile-preparation.mjs';
import {createQaHostLaunchEnvironment} from './launch-environment.mjs';
import {prepareAccessOnlyAnthropicSource} from './access-only-anthropic.mjs';
import {createQaProjectFixture} from './project-fixture.mjs';
import {loadQaMatrixConfig,expandQaMatrix} from './matrix-config.mjs';
import {startOwnedProcess} from './process.mjs';
import {verifyNativeRuntimeArtifacts} from '../../packages/web/server/lib/opencode/runtime-host/native-artifacts.js';
import {translateNativeConfiguration} from '../../packages/web/server/lib/opencode/runtime-host/native-configuration-data.js';
import {defaultNativeRegistrations} from '../../packages/web/server/lib/opencode/runtime-host/native-default-bundle.js';

const fail=code=>Object.assign(new Error(code),{code});
const metadataGraph=view=>Object.fromEntries(['agentSelections','nativeBackupSelections','nativeCompactionSettings','councilMembers'].map(key=>[key,view[key]]));
const timeout=async(action,ms,code)=>{let timer;try{return await Promise.race([action,new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail(code)),ms);})]);}finally{clearTimeout(timer);}};

async function prepareRehearsal(artifactRoot){
  const root=await fs.mkdtemp(path.join(qaCache,'v2-validation/live-owner-rehearsal-')),sourceHome=path.join(root,'setup'),workspace=path.join(root,'preflight-workspace'),runtimeRoot=path.join(root,'preflight-runtime');
  for(const directory of [sourceHome,workspace,runtimeRoot,path.join(sourceHome,'opencode'),path.join(sourceHome,'web-config')])await fs.mkdir(directory,{mode:0o700});
  const manifestPath=path.join(artifactRoot,'native-bundle.json'),manifestSha256=qaHash(await readQaPinnedFile(manifestPath,undefined,4*1024*1024));
  const artifacts=await verifyNativeRuntimeArtifacts({manifestPath,manifestSha256,launcher:path.join(artifactRoot,`DevRyan-execution-${process.platform}-${process.arch}`)});
  const model='openai/gpt-5.6-sol',variant='high';
  const agents={builder:{model,variant},orchestrator:{model,variant},fixer:{model:'xai/grok-4.6',variant:'high'},oracle:{model:'anthropic/claude-opus-5-5',variant:'high'},
    explorer:{model:'opencode-go/deepseek-v4.1-flash',variant:'high'},librarian:{model:'opencode/deepseek-v4.1-flash',variant:'high'},
    council:{model,variant,councillors:[{model:'cursor-acp/composer-2.5',variant:'high'}]}};
  const legacy={model,default_agent:'builder',agent:agents,plugin:[],provider:{'cursor-acp':{}}};
  const bytes={'opencode/opencode.json':JSON.stringify(legacy)+'\n','opencode/.openchamber/config.json':JSON.stringify({agentOverrides:agents})+'\n','web-config/settings.json':'{}\n',
    'reviewed-native.json':JSON.stringify({schema:1,configuration:translateNativeConfiguration({legacy:{},agents:{}}),locations:[],catalogRequirements:{agents:[],models:[],plugins:[],tools:[]}})+'\n',
    'reviewed-plugins.json':JSON.stringify({schema:1,plugins:defaultNativeRegistrations(artifacts.manifest.inputs.reviewedPlugins)})+'\n'};
  for(const [file,value] of Object.entries(bytes)){await fs.mkdir(path.dirname(path.join(sourceHome,file)),{recursive:true,mode:0o700});await fs.writeFile(path.join(sourceHome,file),value,{mode:0o600});}
  await fs.mkdir(path.join(sourceHome,'home'),{mode:0o700});
  const preparedInput={sourceHome,artifactRoot,files:Object.entries(bytes).map(([path,bytes])=>({path,sha256:qaHash(bytes)}))};
  const factory=await createQaNativePreparationFactory({preparedInput,mirror:{reviewedNativeFile:'reviewed-native.json',reviewedPluginFile:'reviewed-plugins.json',opencodeConfigDirectory:'opencode',webConfigDirectory:'web-config',homeDirectory:'home'},bootstrapCredentials:async()=>{throw fail('qa_rehearsal_source_unverified');}});
  const source=await prepareAccessOnlyAnthropicSource(await factory.prepareSource({runtimeRoot,workspace,sourceHome,artifactRoot}));
  const {binding}=await prepareQaNativeBundle({runtimeRoot,source,bundleID:'qa-preflight'});
  await fs.writeFile(path.join(binding.descriptor.launch.global.home,'.devryan-qa-home'),'DevRyan synthetic rehearsal\n',{mode:0o600});
  const view=await readQaNativeSelectionView(binding,createQaNativeLaunchEnvironment({binding,runtimeRoot}),workspace);
  const graphFile=path.join(root,'graph.json'),inputFile=path.join(root,'input.json');
  const graphBytes=JSON.stringify(metadataGraph(view))+'\n',inputBytes=JSON.stringify({preparedInput})+'\n';
  await fs.writeFile(graphFile,graphBytes,{mode:0o600});await fs.writeFile(inputFile,inputBytes,{mode:0o600});
  const mirror=await prepareLiveSetupMirror({inputFile,inputSha256:qaHash(inputBytes),graphFile,graphSha256:qaHash(graphBytes),artifactRoot,outputRoot:path.join(root,'approved')});
  const matrixFile=path.join(root,'matrix.json'),evidenceRoot=path.join(root,'evidence');
  const matrixBytes=JSON.stringify({schemaVersion:1,evidenceRoot,cells:[{id:'synthetic-owner',runtime:'web',transport:'live',providerId:'openai',modelId:'gpt-5.6-sol',agent:'builder',planMode:false,variant,
    scenarioIds:['core-journey'],repetitions:1,timeoutMs:120000,preserveOrchestration:true}]})+'\n';await fs.writeFile(matrixFile,matrixBytes,{mode:0o600});
  const session=await prepareLiveCredentialSession({artifactRoot,mirrorFile:mirror.preparationFile,mirrorSha256:mirror.sha256,matrixFile,matrixSha256:qaHash(matrixBytes),evidenceRoot});
  return {root,...session};
}

async function runOwnerRehearsal(sessionFile){
  const session=JSON.parse(await readQaPinnedFile(sessionFile,undefined,4*1024*1024)),prefix='synthetic-'+randomBytes(24).toString('hex'),canaries=[...['A','B'].flatMap(account=>[`${prefix}-image-access-${account}`,`${prefix}-image-refresh-${account}`]),
    ...['xai','opencode','opencode-go','cursor-acp','claude-access','claude-refresh'].map(provider=>`${prefix}-${provider}`)];
  const input=new PassThrough(),events=[],waiters=[],cases=[],transcripts=[],now={value:Date.now()};let sourceProof,ownerResult,ownerPromise,driverFailure;
  const checkNoCanaries=text=>{for(const value of canaries)for(const form of [value,Buffer.from(value).toString('base64'),encodeURIComponent(value)])assert.equal(text.includes(form),false,'Synthetic credential escaped private runtime');};
  const emit=value=>{events.push(value);transcripts.push(JSON.stringify({...value,...value.link?{link:'<ONE_USE_LINK>'}:{},...value.claudeLoginCommand?{claudeLoginCommand:'<ISOLATED_LOGIN_COMMAND>'}:{}}));
    for(const waiter of [...waiters])if(waiter.from<events.length){waiters.splice(waiters.indexOf(waiter),1);waiter.resolve(value);}};
  const next=from=>events.length>from?Promise.resolve(events[from]):new Promise(resolve=>waiters.push({from,resolve}));
  const step=async command=>{const from=events.length;input.write(JSON.stringify({command})+'\n');return timeout(next(from),120000,'qa_rehearsal_command_timeout');};
  const api=async(origin,cookie,route,{method='GET',body,directory=session.workspace}={})=>{
    const response=await fetch(origin+route,{method,redirect:'manual',signal:AbortSignal.timeout(15000),headers:{cookie,origin,'x-opencode-directory':directory,'X-DevRyan-CSRF':'1',...body===undefined?{}:{'content-type':'application/json'}},...body===undefined?{}:{body:JSON.stringify(body)}});
    return {status:response.status,body:await response.json().catch(()=>null)};
  };
  const syntheticRecord={claudeAiOauth:{accessToken:`${prefix}-claude-access`,refreshToken:`${prefix}-claude-refresh`,expiresAt:Date.now()+3600000}};
  const syntheticModule={createPlatformCredentialStore:()=>({read:async()=>structuredClone(syntheticRecord),write:()=>{throw fail('qa_rehearsal_unexpected_write');}})};
  const beforeStart=async()=>{
    const profileRoot=path.join(session.root,'synthetic-oauth'),module=fileURLToPath(new URL('../opencode-v2-native/package-image-source-oauth.mjs',import.meta.url));
    const request={databasePath:session.binding.descriptor.launch.opencodeDatabasePath,directory:session.workspace,profileRoot,canaryPrefix:prefix};
    const code=`const {prepareSourceOpenAiFixture}=await import(${JSON.stringify(module)});process.stdout.write(JSON.stringify(await prepareSourceOpenAiFixture(${JSON.stringify(request)})));`;
    const {stdout,stderr}=await promisify(execFile)('bun',['--eval',code],{cwd:qaRepository,timeout:60000,maxBuffer:1024*1024,
      env:createQaHostLaunchEnvironment({HOME:session.binding.descriptor.launch.global.home,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'})});
    checkNoCanaries(stdout+stderr);sourceProof=JSON.parse(stdout);assert.equal(sourceProof.settledMutations,2);assert.equal(sourceProof.compiledOAuthCreation,false);
    cases.push({id:'original-source-sdk-oauth-grants',status:'passed',compiledOAuthCreation:false});
  };
  const runMatrix=async(configPath,options)=>{
    let stage='fixture';try{
    const cells=expandQaMatrix(loadQaMatrixConfig(configPath));assert.equal(cells.length,1);const cell=cells[0];
    const fixture=createQaProjectFixture({outputRoot:cell.evidenceDirectory,runId:cell.runId,agent:cell.agent,planMode:cell.planMode});
    stage='private-profile-projection';
    const {nativePreparation}=await options.prepareCellInputs(cell),runtimeRoot=path.join(cell.evidenceDirectory,'runtime');
    const profile=await prepareQaNativeProfile({runtimeRoot,workspace:fixture.fixtureRoot,cell,nativePreparation});
    assert.equal(profile.evidence.credentials.openai.expectedFingerprint,sourceProof.reopened.expectedFingerprint);
    assert.deepEqual(Object.keys(profile.evidence.credentials).sort(),['anthropic','cursor-acp','openai','opencode','opencode-go','xai']);
    stage='candidate-start';
    const candidate=startOwnedProcess(process.execPath,[profile.bootstrapPath],{cwd:qaRepository,env:{...profile.env,DEVRYAN_QA_RUNTIME:'web',OPENCHAMBER_PORT:'0',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}});
    try{
      const deadline=Date.now()+120000;let ready;
      while(Date.now()<deadline){candidate.check();try{ready=JSON.parse(await readQaPinnedFile(path.join(runtimeRoot,'ready.json')));break;}catch(error){if(error.code!=='ENOENT')throw error;}await new Promise(resolve=>setTimeout(resolve,100));}
      stage='candidate-health';
      assert.ok(ready,'Candidate did not reach actual readiness');const health=await api(ready.origin,'','/api/health',{directory:fixture.fixtureRoot});assert.equal(health.status,200);assert.equal(health.body.isOpenCodeReady,true);assert.equal(health.body.openCodeGeneration,2);
      stage='candidate-provider-catalog';
      const catalog=await api(ready.origin,'','/api/provider',{directory:fixture.fixtureRoot});assert.equal(catalog.status,200);
      for(const provider of ['openai','xai','opencode','opencode-go'])assert.ok(catalog.body.connected.includes(provider),`Projected native provider ${provider} was not available after boot`);
      // Cursor is an external SDK transport, absent from native /api/provider.
      // Its actual key/CAS is covered above; selected-account model discovery
      // needs the later live lane and must not contact a provider in rehearsal.
      cases.push({id:'compiled-cas-projection-and-seeded-candidate-boot',status:'passed',credentials:6,nativeCatalogProviders:4,cursorCatalog:'not-run',inference:'not-run'});
    }finally{await candidate.stop();await candidate.auditStopped();checkNoCanaries(candidate.getLog());await profile.verifyInputs();}
    await options.afterCell(cell,{outcome:'passed',output:cell.evidenceDirectory});
    return {planned:1,completed:1,outcome:'passed',inference:'not-run'};
    }catch(error){cases.push({id:'candidate-'+stage,status:'failed',code:/^(qa_|bundle_|native_)[a-z0-9_]{1,100}$/.test(error.code??'')?error.code:'qa_rehearsal_candidate_failed'});
      if(error.code==='ERR_ASSERTION'){checkNoCanaries(String(error.message));driverFailure={code:'qa_rehearsal_assertion_failed',message:String(error.message).split('\n')[0].slice(0,200)};}throw error;}
  };
  ownerPromise=runLiveCredentialOwner({sessionFile,input,emit,rehearsal:true,beforeStart,runMatrix,now:()=>now.value,
    anthropicOptions:{loadReviewedModule:async()=>syntheticModule},inspectLoopback:()=>({busy:false,holders:[]})});
  try{
    const ready=await timeout(next(0),120000,'qa_rehearsal_owner_start_timeout');assert.equal(ready.status,'awaiting-owner',`Owner refused before readiness: ${ready.code??'unavailable'}`);
    const foreign=await new Promise((resolve,reject)=>import('node:http').then(({default:http})=>http.get(ready.link,{headers:{host:'foreign.example'}},response=>{response.resume();resolve(response.statusCode);}).once('error',reject)));assert.equal(foreign,403);
    const response=await fetch(ready.link,{redirect:'manual'});assert.equal(response.status,302);const cookie=response.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(ready.link,{redirect:'manual'})).status,403);
    const stale=await step('enroll-link'),fresh=await step('enroll-link');assert.equal((await fetch(stale.link,{redirect:'manual'})).status,403);
    now.value=fresh.expiresAt;assert.equal((await fetch(fresh.link,{redirect:'manual'})).status,403);now.value=Date.now();
    cases.push({id:'real-owner-cookie-single-use-host-and-expiry',status:'passed'});
    for(const provider of ['xai','opencode','opencode-go','cursor-acp']){
      const result=await api(ready.hostOrigin,cookie,'/api/auth/'+provider,{method:'PUT',body:{type:'api',key:`${prefix}-${provider}`}});assert.equal(result.status,200,`Original Providers UI key mutation failed: ${provider} (${result.status})`);
      cases.push({id:`compiled-key-${provider}`,status:'passed'});
    }
    assert.equal((await api(ready.hostOrigin,cookie,`/api/credential/${sourceProof.reopened.credentialID}/activate`,{method:'POST',body:{}})).status,200);
    cases.push({id:'compiled-provider-key-and-metadata-cas-owners',status:'passed',keyProviders:4});
    const verified=await step('hold-and-verify');assert.equal(verified.status,'verified',`Source hold refused: ${verified.code??'unavailable'}`);assert.equal(verified.rows.openai.valueType,'oauth');checkNoCanaries(JSON.stringify(verified));
    // Public evidence sanitizes fingerprints. Compare the original SDK record
    // with the private projected admission in runMatrix, before sanitization.
    const ordinary=await api(ready.hostOrigin,cookie,'/api/provider');assert.equal(ordinary.status,503);assert.equal(ordinary.body.code,'bundle_runtime_admission_held');
    const inspection=await api(ready.hostOrigin,cookie,'/api/runtime/bundle');assert.equal(inspection.body.state,'held');
    const upgrade=await api(ready.hostOrigin,cookie,'/api/runtime/bundle/upgrade',{method:'POST',body:{expectedRevision:session.binding.selection.revision}});assert.equal(upgrade.status,503);assert.equal(upgrade.body.code,'bundle_runtime_admission_held');
    assert.equal((await step('enroll-link')).code,'qa_live_source_held');assert.equal((await fetch(fresh.link,{redirect:'manual'})).status,403);
    cases.push({id:'genuine-application-grant-permanent-hold-and-access-only-read',status:'passed'});
    const run=await step('run');assert.equal(run.status,'matrix-finished',`Candidate rehearsal refused: ${run.code??'unavailable'}`);assert.equal(run.outcome,'passed');assert.equal(run.leakScan.hits,0);
    assert.equal((await step('run')).code,'qa_live_matrix_already_run');
    const closed=await step('close');assert.equal(closed.status,'closed');ownerResult=await ownerPromise;assert.equal(ownerResult.exitCode,0);assert.equal(ownerResult.grantCount,1);assert.equal(ownerResult.teardown,'passed');
    // Retained candidate state is private and blocks publishing the evidence.
    assert.equal(ownerResult.retained.length,1);assert.equal(ownerResult.evidencePublishable,false);
    for(const cell of expandQaMatrix(loadQaMatrixConfig(session.options.matrixFile)))await assert.rejects(fs.lstat(path.join(cell.evidenceDirectory,'runtime')),error=>error.code==='ENOENT');
    checkNoCanaries(transcripts.join('\n'));
    const linkValues=events.filter(row=>row.link).map(row=>row.link.split('/').at(-1)),cookieValue=cookie.split('=')[1];
    for(const value of [...linkValues,cookieValue])assert.equal(transcripts.join('\n').includes(value),false);
    cases.push({id:'run-once-owned-teardown-private-retention-and-zero-evidence-leaks',status:'passed'});
  }catch(error){driverFailure??={code:/^qa_[a-z0-9_]{1,100}$/.test(error.code??'')?error.code:'qa_rehearsal_assertion_failed',message:String(error.message).split('\n')[0].slice(0,200)};}
  finally{input.end();try{ownerResult??=await timeout(ownerPromise,120000,'qa_rehearsal_teardown_timeout');}catch{driverFailure??={code:'qa_rehearsal_teardown_failed'};}}
  const report={status:driverFailure?'failed':'passed',qualification:'compiled-synthetic-ownership-projection-and-ready-boot-only',inference:'not-run',cases,failure:driverFailure,refusals:events.filter(row=>row.status==='refused').map(row=>({code:row.code})),owner:ownerResult&&{grantCount:ownerResult.grantCount,teardown:ownerResult.teardown,leakScan:ownerResult.leakScan,retained:ownerResult.retained,timings:ownerResult.timings}};
  checkNoCanaries(JSON.stringify(report));await fs.writeFile(path.join(session.options.evidenceRoot,'rehearsal.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  return {status:report.status,evidenceRoot:session.options.evidenceRoot,failure:driverFailure};
}

export async function runLiveCredentialRehearsal({artifactRoot}){
  const prepared=await prepareRehearsal(artifactRoot),child=startOwnedProcess(process.execPath,[fileURLToPath(import.meta.url),'--owner-session',prepared.sessionFile],{cwd:qaRepository,env:prepared.env});
  let result;
  try{
    const exit=new Promise((resolve,reject)=>{child.child.once('error',reject);child.child.once('exit',(code,signal)=>resolve({code,signal}));});
    const outcome=await timeout(exit,360000,'qa_rehearsal_bound');
    result=JSON.parse(await readQaPinnedFile(path.join(prepared.session.options.evidenceRoot,'rehearsal.json')));
    assert.equal(outcome.signal,null);assert.equal(outcome.code,result.status==='passed'?0:1);
  }finally{await child.stop();await child.auditStopped();}
  return {root:prepared.root,evidenceRoot:prepared.session.options.evidenceRoot,status:result.status,failure:result.failure};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const args=process.argv.slice(2);if(args.length!==2||!args[1]||!['--artifact-root','--owner-session'].includes(args[0]))throw fail('qa_rehearsal_flags_invalid');
    const result=args[0]==='--owner-session'?await runOwnerRehearsal(args[1]):await runLiveCredentialRehearsal({artifactRoot:args[1]});process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=result.status==='passed'?0:1;
  }catch(error){process.stderr.write(JSON.stringify({status:'failed',code:/^qa_[a-z0-9_]{1,100}$/.test(error.code??'')?error.code:'qa_rehearsal_failed'})+'\n');process.exitCode=1;}
}
