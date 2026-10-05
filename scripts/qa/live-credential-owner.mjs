import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {randomBytes} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify,isDeepStrictEqual} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {qaRepository,qaCache,qaHash,readQaPinnedFile,assertQaPrivateDirectory} from './live-setup-mirror.mjs';
import {createQaNativePreparationFactory} from './native-profile-factory.mjs';
import {createQaNativeInputVerifier,prepareQaNativeBundle,createQaNativeLaunchEnvironment,readQaNativeSelectionView,qaNativeRequiredProviders} from './native-profile-preparation.mjs';
import {createQaHostLaunchEnvironment} from './launch-environment.mjs';
import {loadQaMatrixConfig,expandQaMatrix} from './matrix-config.mjs';
import {captureQaSourceIdentity,captureQaArtifactIdentity} from './artifact-evidence.mjs';
import {createAccessOnlyAnthropic,prepareAccessOnlyAnthropicSource} from './access-only-anthropic.mjs';
import {createHeldSourceCredentials} from './held-source-credentials.mjs';
import {verifyNativeRuntimeArtifacts} from '../../packages/web/server/lib/opencode/runtime-host/native-artifacts.js';
import {readRuntimeBundleBinding} from '../../packages/web/server/lib/opencode/runtime-host/runtime-bundle-binding.js';
import {createProjectIdFromPath} from '../../packages/web/server/lib/projects/project-id.js';
import {createDiagnosticSanitizer} from '../../packages/harness-runtime/lib/sanitizer.js';
import {inspectOAuthLoopbackPort} from '../../packages/web/server/lib/opencode/oauth-loopback-preflight.js';
import {waitForQaHostReady} from './host-readiness.mjs';
import {createQaProcessOwnership} from './process-ownership.mjs';

const fail=code=>Object.assign(new Error(code),{code});
const finite=error=>/^(qa_|bundle_|native_)[a-z0-9_]{1,100}$/.test(error?.code??'')?error.code:'qa_live_owner_failed';
const scripts=fileURLToPath(new URL('../',import.meta.url)).replace(/\/$/,'');
const inside=(root,file)=>file.startsWith(root+path.sep);
const commands=['status','enroll-link','hold-and-verify','run','close'];
const hashFile=async file=>{const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');};

export function parseLiveOwnerFlags(args){
  const flags=new Map(),allowed=['--artifact-root','--mirror','--mirror-sha256','--matrix','--matrix-sha256','--evidence-root','--reuse-source'];
  for(let index=0;index<args.length;index+=2){if(!allowed.includes(args[index])||flags.has(args[index])||!args[index+1]||args[index+1].startsWith('--'))throw fail('qa_live_flags_invalid');flags.set(args[index],args[index+1]);}
  for(const flag of allowed.slice(0,6))if(!flags.has(flag))throw fail('qa_live_flags_invalid');
  for(const flag of ['--mirror-sha256','--matrix-sha256'])if(!/^[a-f0-9]{64}$/.test(flags.get(flag)))throw fail('qa_live_flags_invalid');
  return {artifactRoot:flags.get('--artifact-root'),mirrorFile:flags.get('--mirror'),mirrorSha256:flags.get('--mirror-sha256'),matrixFile:flags.get('--matrix'),matrixSha256:flags.get('--matrix-sha256'),evidenceRoot:flags.get('--evidence-root'),reuseSource:flags.get('--reuse-source')};
}
export function parseLiveOwnerCommand(line){
  if(Buffer.byteLength(line)>1024)throw fail('qa_live_command_invalid');
  let input;try{input=JSON.parse(line);}catch{throw fail('qa_live_command_invalid');}
  if(!input||Array.isArray(input)||Object.keys(input).length!==1||!commands.includes(input.command))throw fail('qa_live_command_invalid');return input.command;
}

async function readInputs(options){
  await assertQaPrivateDirectory(options.artifactRoot);
  const mirror=JSON.parse(await readQaPinnedFile(options.mirrorFile,options.mirrorSha256,4*1024*1024));
  if(mirror.schema!==1||mirror.status!=='prepared-no-credentials-no-runtime'||mirror.preparedInput?.artifactRoot!==options.artifactRoot)throw fail('qa_live_mirror_invalid');
  const verifier=await createQaNativeInputVerifier(mirror.preparedInput);if(verifier.inputDigest!==mirror.inputDigest)throw fail('qa_live_mirror_invalid');
  await readQaPinnedFile(options.matrixFile,options.matrixSha256,4*1024*1024);
  const config=loadQaMatrixConfig(options.matrixFile),cells=expandQaMatrix(config);
  if(config.evidenceRoot!==options.evidenceRoot||cells.some(cell=>cell.transport!=='live'||cell.preserveOrchestration!==true||cell.mirrorPersonalSetup
    ||cell.allowCrossProviderAssignments||Object.keys(cell.agentAssignments??{}).length))throw fail('qa_live_matrix_invalid');
  const plannedRunMs=cells.reduce((total,cell)=>total+cell.timeoutMs,0);if(!Number.isSafeInteger(plannedRunMs))throw fail('qa_live_matrix_invalid');
  return {mirror,verifier,config,cells,plannedRunMs};
}

async function captureIdentities(options,input){
  const manifestPath=path.join(options.artifactRoot,'native-bundle.json'),manifestSha256=qaHash(await readQaPinnedFile(manifestPath,undefined,4*1024*1024));
  const artifacts=await verifyNativeRuntimeArtifacts({manifestPath,manifestSha256,launcher:path.join(options.artifactRoot,`DevRyan-execution-${process.platform}-${process.arch}`)});
  if(input.mirror.artifact?.manifestSha256!==manifestSha256||input.mirror.artifact.buildID!==artifacts.manifest.buildId)throw fail('qa_live_identity_changed');
  return {sourceSha256:(await captureQaSourceIdentity(qaRepository)).sha256,runnerSha256:(await captureQaArtifactIdentity(scripts)).sha256,
    artifactManifestSha256:manifestSha256,buildID:artifacts.manifest.buildId,mirrorSha256:qaHash(await readQaPinnedFile(options.mirrorFile,options.mirrorSha256,4*1024*1024)),
    inputDigest:await input.verifier.verifyInputs(),matrixSha256:qaHash(await readQaPinnedFile(options.matrixFile,options.matrixSha256,4*1024*1024)),
    executable:{path:await fs.realpath(process.execPath),sha256:await hashFile(await fs.realpath(process.execPath)),version:process.version}};
}

async function initOwnedGit(directory,root,home){
  await assertQaPrivateDirectory(directory);
  const template=path.join(root,'git-template');await fs.mkdir(template,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});await assertQaPrivateDirectory(template);
  await promisify(execFile)('git',['init','--quiet',`--template=${template}`,directory],{cwd:root,timeout:15000,maxBuffer:65536,
    env:createQaHostLaunchEnvironment({HOME:home,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GIT_CEILING_DIRECTORIES:root})});
}

/** Launcher owns files only. Only the fresh in-process application can hand
 * authority to the child; no capability, value or snapshot enters this record. */
export async function prepareLiveCredentialSession(options){
  const input=await readInputs(options),identities=await captureIdentities(options,input);
  await assertQaPrivateDirectory(path.dirname(options.evidenceRoot));await fs.mkdir(options.evidenceRoot,{mode:0o700});await assertQaPrivateDirectory(options.evidenceRoot);
  const root=options.reuseSource??await fs.mkdtemp(path.join(qaCache,'v2-validation/live-owner-'));await assertQaPrivateDirectory(root);
  const runtimeRoot=path.join(root,'source-runtime'),workspace=path.join(root,'workspace'),stateFile=path.join(root,'source-state.json');let binding;
  if(options.reuseSource){
    const previous=JSON.parse(await readQaPinnedFile(stateFile,undefined,4*1024*1024));
    if(!isDeepStrictEqual(previous.sourceIdentity,Object.fromEntries(Object.entries(identities).filter(([key])=>key!=='matrixSha256'))))throw fail('qa_live_identity_changed');
    await assertQaPrivateDirectory(runtimeRoot);await assertQaPrivateDirectory(workspace);
    binding=readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:path.join(runtimeRoot,'native-bundles')});
    if(!isDeepStrictEqual(binding,previous.binding))throw fail('qa_live_source_selection_changed');
  }else{
    for(const directory of [runtimeRoot,workspace])await fs.mkdir(directory,{mode:0o700});await initOwnedGit(workspace,root,workspace);
    const factory=await createQaNativePreparationFactory({preparedInput:input.verifier.input,mirror:input.mirror.mirror,bootstrapCredentials:async()=>{throw fail('qa_live_source_unverified');}});
    const source=await prepareAccessOnlyAnthropicSource(await factory.prepareSource({runtimeRoot,workspace,sourceHome:input.verifier.input.sourceHome,artifactRoot:options.artifactRoot}));
    const preferences=path.join(source.launch.webConfigDirectory,'settings.json');let settings={};
    try{settings=JSON.parse(await readQaPinnedFile(preferences));}catch(error){if(error.code!=='ENOENT')throw error;}
    settings.projects=[{id:createProjectIdFromPath(workspace),path:workspace,name:'Independent QA'}];
    await fs.writeFile(path.join(source.launch.webDataDirectory,'settings.json'),JSON.stringify(settings)+'\n',{flag:'wx',mode:0o600});
    ({binding}=await prepareQaNativeBundle({runtimeRoot,source,bundleID:'qa-login-source'}));
    await fs.writeFile(path.join(binding.descriptor.launch.global.home,'.devryan-qa-home'),'DevRyan isolated native QA\n',{flag:'wx',mode:0o600});
    await initOwnedGit(binding.descriptor.launch.global.home,root,binding.descriptor.launch.global.home);
    await fs.writeFile(stateFile,JSON.stringify({schema:1,binding,sourceIdentity:Object.fromEntries(Object.entries(identities).filter(([key])=>key!=='matrixSha256'))})+'\n',{flag:'wx',mode:0o600});
  }
  const env=createQaNativeLaunchEnvironment({binding,runtimeRoot}),view=await readQaNativeSelectionView(binding,env,workspace);
  for(const key of ['agentSelections','nativeBackupSelections','nativeCompactionSettings','councilMembers'])if(!isDeepStrictEqual(view[key],input.mirror.savedGraph[key]))throw fail('qa_live_saved_graph_changed');
  const providers=qaNativeRequiredProviders(view);
  if(input.cells.some(cell=>view.agentSelections[cell.agent]?.model!==`${cell.providerId}/${cell.modelId}`||(view.agentSelections[cell.agent]?.variant??null)!==cell.variant))throw fail('qa_live_matrix_selection_changed');
  const session={schema:1,options,root,runtimeRoot,workspace,binding,identities,providers,plannedRunMs:input.plannedRunMs};
  const sessionFile=path.join(options.evidenceRoot,'owner-session.json');await fs.writeFile(sessionFile,JSON.stringify(session)+'\n',{flag:'wx',mode:0o600});
  return {sessionFile,env,session};
}

/** The challenge and cookie live only in memory. Concurrent consumers reserve
 * the single use before awaiting the application's own session issuer. */
export async function createLiveOwnerLink({handle,hostOrigin,isHeld,now=Date.now}){
  const host=new URL(hostOrigin);if(host.protocol!=='http:'||host.hostname!=='127.0.0.1'||!host.port||host.origin!==hostOrigin)throw fail('qa_live_origin_invalid');
  let challenge,closed=false;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
    if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==`127.0.0.1:${server.address()?.port}`||req.method!=='GET'||closed||isHeld()
      ||!challenge||challenge.used||challenge.expiresAt<=now()||req.url!==`/owner/${challenge.nonce}`){res.writeHead(403);res.end();return;}
    const reserved=challenge;reserved.used=true;
    try{
      const cookie=await handle.issueLocalOwnerSession();
      if(closed||isHeld()||challenge!==reserved||reserved.expiresAt<=now()||cookie?.name!=='devryan_local_owner'||!/^[A-Za-z0-9_-]{43}$/.test(cookie.value??'')||!Number.isSafeInteger(cookie.maxAge)||cookie.maxAge<=0)throw fail('qa_live_owner_cookie_unavailable');
      res.writeHead(302,{'Location':hostOrigin+'/','Set-Cookie':`${cookie.name}=${cookie.value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${cookie.maxAge}`});res.end();
    }catch{res.writeHead(403);res.end();}
  });
  server.requestTimeout=10000;server.headersTimeout=10000;server.maxRequestsPerSocket=1;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return Object.freeze({
    issue:()=>{if(closed||isHeld())throw fail('qa_live_source_held');challenge={nonce:randomBytes(32).toString('base64url'),expiresAt:now()+600000,used:false};return {link:`http://127.0.0.1:${server.address().port}/owner/${challenge.nonce}`,expiresAt:challenge.expiresAt};},
    status:()=>challenge&&!closed&&!challenge.used&&!isHeld()&&challenge.expiresAt>now()?{linkValidUntil:challenge.expiresAt}:{},
    close:()=>{closed=true;challenge=undefined;return new Promise((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();});},
    port:server.address().port,
  });
}

async function listenerStopped(port){
  return new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port});socket.setTimeout(2000);socket.once('connect',()=>{socket.destroy();resolve(false);});socket.once('error',error=>resolve(error.code==='ECONNREFUSED'));socket.once('timeout',()=>{socket.destroy();resolve(false);});});
}

async function retainCellRuntime(session,cell){
  if(!inside(session.options.evidenceRoot,cell.evidenceDirectory)||path.basename(cell.evidenceDirectory)!==cell.runId)throw fail('qa_live_runtime_retention_invalid');
  const runtime=path.join(cell.evidenceDirectory,'runtime');let stat;
  try{stat=await assertQaPrivateDirectory(runtime);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  const retained=path.join(session.root,'private-retained');await fs.mkdir(retained,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});await assertQaPrivateDirectory(retained);
  const target=path.join(retained,cell.runId);try{await fs.lstat(target);throw fail('qa_live_runtime_retention_invalid');}catch(error){if(error.code!=='ENOENT')throw error;}
  await fs.rename(runtime,target);const after=await assertQaPrivateDirectory(target);if(after.ino!==stat.ino||after.dev!==stat.dev)throw fail('qa_live_runtime_retention_invalid');
  return {runId:cell.runId,status:'private-runtime-retained'};
}

/** Constructor injection is restricted to compiled synthetic rehearsal callers.
 * The live CLI has no flag for stores, grants, process owners or matrix adapters. */
export async function runLiveCredentialOwner({sessionFile,input=process.stdin,emit=value=>process.stdout.write(JSON.stringify(value)+'\n'),rehearsal=false,
  startServer,anthropicOptions={},beforeStart,runMatrix,inspectLoopback=inspectOAuthLoopbackPort,now=Date.now}){
  if(!rehearsal&&(!input.isTTY||!process.stdout.isTTY))throw fail('qa_live_owner_attendance_required');
  if(!rehearsal&&(startServer||beforeStart||runMatrix||Object.keys(anthropicOptions).length||inspectLoopback!==inspectOAuthLoopbackPort||now!==Date.now))throw fail('qa_live_constructor_invalid');
  const session=JSON.parse(await readQaPinnedFile(sessionFile,undefined,4*1024*1024));
  if(session.schema!==1||session.binding?.controlRoot!==process.env.DEVRYAN_RUNTIME_BUNDLE_ROOT||session.runtimeRoot!==process.env.DEVRYAN_QA_RUNTIME_ROOT
    ||session.binding.descriptor.launch.global.home!==process.env.DEVRYAN_QA_HOME||process.env.HOME!==process.env.DEVRYAN_QA_HOME)throw fail('qa_live_environment_invalid');
  for(const directory of [session.root,session.runtimeRoot,session.workspace,session.binding.controlRoot,session.binding.descriptor.launch.global.home,session.options.evidenceRoot])await assertQaPrivateDirectory(directory);
  if(!isDeepStrictEqual(readRuntimeBundleBinding(process.env),session.binding))throw fail('qa_live_source_selection_changed');
  const verifiedInput=await readInputs(session.options);
  const verifyIdentities=async()=>{if(!isDeepStrictEqual(await captureIdentities(session.options,verifiedInput),session.identities))throw fail('qa_live_identity_changed');};
  await verifyIdentities();
  const evidence=path.join(session.options.evidenceRoot,'live-owner');await fs.mkdir(evidence,{mode:0o700});
  const sanitizer=createDiagnosticSanitizer({homeDir:session.binding.descriptor.launch.global.home,pathMappings:[{path:qaRepository,placeholder:'<REPOSITORY>'}]});
  const record=async(name,value)=>fs.writeFile(path.join(evidence,name),JSON.stringify(sanitizer.sanitizeExportValue(value),null,2)+'\n',{flag:'wx',mode:0o600});
  await record('identities.json',session.identities);
  let grant,grantCount=0,handle,hostPort,failedStartStop,link,held,probe,state='awaiting-owner',matrixRun=false,summary,closing,stopRequested=false;
  const retained=[],timings=[];
  const timed=async(name,action)=>{const started=performance.now();try{return await action();}finally{timings.push({name,elapsedMs:performance.now()-started});}};
  const close=()=>closing??=(async()=>{
    let clean=true,leakScan;
    try{if(link)await link.close();}catch{clean=false;}
    try{if(handle)await handle.stop({exitProcess:false});else await failedStartStop?.({exitProcess:false});}catch{clean=false;}
    for(const cell of verifiedInput.cells)try{const row=await retainCellRuntime(session,cell);if(row)retained.push(row);}catch{clean=false;}
    try{await verifyIdentities();for(const directory of [session.root,session.runtimeRoot,session.binding.descriptor.launch.global.home])await assertQaPrivateDirectory(directory);
      if(hostPort&&!await listenerStopped(hostPort)||link&&!await listenerStopped(link.port))clean=false;
    }catch{clean=false;}
    if(probe)try{leakScan=await probe.scan(session.options.evidenceRoot);if(leakScan.hits)clean=false;}catch{clean=false;}
    state='closed';grant=undefined;held=undefined;
    const result={status:'closed',outcome:summary?.outcome==='passed'&&clean&&leakScan?.hits===0?'passed':'failed',matrixRun,teardown:clean?'passed':'failed',grantCount,leakScan,retained,timings,
      ownerCleanup:['Sign out the independent provider accounts.','Remove the isolated Claude login item through the vendor owner.','Review the private source and retained runtime paths and sizes before approving Trash.'],
      parentAudit:'pending',evidencePublishable:false};
    await record('summary.json',result);emit(result);return {exitCode:result.outcome==='passed'?0:1,...result};
  })();
  const signal=()=>{stopRequested=true;input.destroy?.();};
  process.on('SIGINT',signal);process.on('SIGTERM',signal);
  try{
    await beforeStart?.(session);
    let start=startServer;
    if(!start){const module=await import('../../packages/web/server/index.js');start=module.startWebUiServer;failedStartStop=module.gracefulShutdown;}
    handle=await timed('source-start',()=>start({host:'127.0.0.1',port:0,attachSignals:true,exitOnShutdown:false,retainRuntimeBundleCheckpoint:value=>{if(++grantCount!==1||!Object.isFrozen(value)||Object.keys(value).some(key=>!['ownerID','controlRoot','withHeldCheckpoint'].includes(key)))throw fail('qa_live_grant_invalid');grant=value;}}));
    hostPort=handle.getPort();
    await timed('source-ready',()=>waitForQaHostReady({origin:`http://127.0.0.1:${hostPort}`,checkAlive:()=>{if(stopRequested)throw fail('qa_live_interrupted');}}));
    const inspection=await handle.runtimeBundle.inspect();
    if(grantCount!==1||grant?.ownerID!==session.binding.descriptor.bundleID||grant.controlRoot!==session.binding.controlRoot||!handle.isReady()
      ||!['ready','upgrade_available'].includes(inspection.state)||inspection.restartRequired||inspection.reconciliationRequired||inspection.revision!==session.binding.selection.revision)throw fail('qa_live_source_not_ready');
    const view=await readQaNativeSelectionView(session.binding,createQaNativeLaunchEnvironment({binding:session.binding,runtimeRoot:session.runtimeRoot}),session.workspace);
    for(const key of ['agentSelections','nativeBackupSelections','nativeCompactionSettings','councilMembers'])if(!isDeepStrictEqual(view[key],verifiedInput.mirror.savedGraph[key]))throw fail('qa_live_saved_graph_changed');
    if(!isDeepStrictEqual(qaNativeRequiredProviders(view),session.providers)||verifiedInput.plannedRunMs!==session.plannedRunMs)throw fail('qa_live_session_changed');
    const loopback=inspectLoopback();if(loopback.busy&&loopback.holders.some(holder=>!holder.ownedByThisHost))throw fail('qa_live_oauth_port_busy');
    const anthropic=createAccessOnlyAnthropic({sourceBinding:session.binding,...anthropicOptions});
    held=createHeldSourceCredentials({grant,sourceBinding:session.binding,verifyAdditionalCredentials:anthropic.verifyLogin,admitCandidate:anthropic.admitCandidate});
    link=await createLiveOwnerLink({handle,hostOrigin:`http://127.0.0.1:${handle.getPort()}`,isHeld:()=>state!=='awaiting-owner',now});
    emit({status:'awaiting-owner',hostOrigin:`http://127.0.0.1:${handle.getPort()}`,...link.issue(),claudeLoginCommand:await anthropic.loginCommand(session.workspace),requiredProviders:session.providers,commands});
    const command=async value=>{
      if(value==='close')return close();
      if(value==='status'){emit({state,sourceHeld:state!=='awaiting-owner',verified:state==='verified',providersRequired:session.providers,matrixRun,...link.status()});return;}
      if(value==='enroll-link'){emit({status:'owner-link',...link.issue()});return;}
      if(value==='hold-and-verify'){
        if(state!=='awaiting-owner')throw fail('qa_live_source_held');
        await verifyIdentities();state='held-unverified';
        const rows=await timed('hold-and-verify',()=>held.verify({requiredProviders:session.providers,timeoutMs:session.plannedRunMs}));
        probe=held.createLeakProbe();const minOAuthExpiry=Math.min(...Object.values(rows).filter(row=>row.expires!==undefined).map(row=>row.expires));
        if(Number.isFinite(minOAuthExpiry)&&minOAuthExpiry<now()+session.plannedRunMs+600000)throw fail('qa_live_run_exceeds_token_lifetime');
        state='verified';await record('admission.json',{rows,plannedRunMs:session.plannedRunMs,...Number.isFinite(minOAuthExpiry)?{minOAuthExpiry}:{}});
        emit({status:'verified',rows:sanitizer.sanitizeExportValue(rows),plannedRunMs:session.plannedRunMs,...Number.isFinite(minOAuthExpiry)?{minOAuthExpiry}:{}});return;
      }
      if(matrixRun)throw fail('qa_live_matrix_already_run');
      if(state!=='verified')throw fail('qa_live_source_unverified');
      await verifyIdentities();matrixRun=true;
      const factory=await createQaNativePreparationFactory({preparedInput:verifiedInput.verifier.input,mirror:verifiedInput.mirror.mirror,bootstrapCredentials:held.bootstrap});
      const nativePreparation={...factory,prepareSource:async options=>anthropic.prepareCandidateSource(await factory.prepareSource(options))};
      const options={prepareCellInputs:async()=>({nativePreparation,sourceHome:verifiedInput.verifier.input.sourceHome}),afterCell:async cell=>{const row=await retainCellRuntime(session,cell);if(row)retained.push(row);}};
      summary=await timed('matrix',()=>runMatrix?runMatrix(session.options.matrixFile,options):import('./matrix-runner.mjs').then(module=>module.runQaMatrix(session.options.matrixFile,options)));
      for(const cell of verifiedInput.cells){const row=await retainCellRuntime(session,cell);if(row)retained.push(row);}
      const leakScan=await probe.scan(session.options.evidenceRoot);if(leakScan.hits)throw fail('qa_live_evidence_credential_leak');
      emit({status:'matrix-finished',outcome:summary.outcome,completed:summary.completed,planned:summary.planned,leakScan});
    };
    let pending=Buffer.alloc(0);
    for await(const bytes of input){
      if(stopRequested)break;
      pending=Buffer.concat([pending,Buffer.from(bytes)]);if(pending.length>65536)throw fail('qa_live_command_invalid');
      for(;;){const newline=pending.indexOf(10);if(newline<0)break;const line=pending.subarray(0,newline).toString('utf8');pending=pending.subarray(newline+1);
        try{const value=parseLiveOwnerCommand(line);await command(value);}catch(error){emit({status:'refused',code:finite(error)});}
        if(closing)break;
      }
      if(closing)break;if(pending.length>1024)throw fail('qa_live_command_invalid');
    }
    if(pending.length&&!closing)emit({status:'refused',code:'qa_live_command_invalid'});
    return await close();
  }catch(error){emit({status:'refused',code:finite(error)});return await close();}
  finally{process.off('SIGINT',signal);process.off('SIGTERM',signal);}
}

async function launch(options){
  if(!process.stdin.isTTY||!process.stdout.isTTY)throw fail('qa_live_owner_attendance_required');
  const {sessionFile,env}=await prepareLiveCredentialSession(options);
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--owner-child',sessionFile],{cwd:qaRepository,env,stdio:'inherit'});
  const ownership=createQaProcessOwnership(child);
  const interrupt=()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGINT');};
  process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
  let exitCode=1,teardown='failed';
  try{
    exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve(signal?1:code??1));});
  }catch{exitCode=1;
  }finally{
    try{await ownership.refresh();await ownership.terminateRemaining();await ownership.auditStopped();teardown='passed';}catch{teardown='failed';}
    finally{await ownership.closeTracking();process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);}
  }
  const sourceSummary=JSON.parse(await readQaPinnedFile(path.join(options.evidenceRoot,'live-owner/summary.json'),undefined,4*1024*1024));
  const result={status:'launcher-closed',teardown,outcome:exitCode===0&&teardown==='passed'?'passed':'failed',processes:ownership.getEvidence(),
    evidencePublishable:exitCode===0&&teardown==='passed'&&sourceSummary.teardown==='passed'&&sourceSummary.leakScan?.hits===0&&sourceSummary.retained?.length===0};
  await fs.writeFile(path.join(options.evidenceRoot,'live-owner/launcher-summary.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  process.stdout.write(JSON.stringify({status:result.status,teardown,outcome:result.outcome,evidencePublishable:result.evidencePublishable})+'\n');
  return result.outcome==='passed'?0:1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const args=process.argv.slice(2);
    process.exitCode=args[0]==='--owner-child'&&args.length===2?(await runLiveCredentialOwner({sessionFile:args[1]})).exitCode:await launch(parseLiveOwnerFlags(args));
  }catch(error){process.stderr.write(JSON.stringify({status:'refused',code:finite(error)})+'\n');process.exitCode=1;}
}
