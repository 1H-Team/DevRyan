import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readRuntimeBundleBinding} from '../../packages/web/server/lib/opencode/runtime-host/runtime-bundle-binding.js';
import {nativeBundleCredentialFingerprint as hash,NATIVE_BUNDLE_CREDENTIAL_CONTRACT as protocol} from '../../packages/web/server/lib/opencode/runtime-host/native-bundle-credential-contract.js';
import {credentialMutationFingerprint} from '../../packages/web/server/lib/opencode/runtime-host/native-credential-mutation-owner.js';
import {createHeldSourceCredentials} from './held-source-credentials.mjs';
import {createCredentialLeakProbe} from './credential-leak-probe.mjs';
import {createAccessOnlyAnthropic} from './access-only-anthropic.mjs';
import {claudeKeychainService} from '../../packages/web/server/lib/opencode/claude-credential-projection.js';

// Constructor contracts only. Real compiled projection/host startup is exercised
// by live-credential-rehearsal; these dummy files never confer native admission.
async function fixture(t){
  const root=await fs.mkdtemp(path.resolve('.cache/held-source-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const workspace=path.join(root,'workspace');await fs.mkdir(workspace);
  const bindingFor=async id=>{
    const controlRoot=path.join(root,id),bundleRoot=path.join(controlRoot,'bundles',id);await fs.mkdir(bundleRoot,{recursive:true,mode:0o700});
    const global=Object.fromEntries(['home','config','data','state','cache','tmp','bin','log','repos'].map(key=>[key,key==='config'?path.join(bundleRoot,'config/opencode'):path.join(bundleRoot,'global',key)]));
    const launch={opencodeDatabasePath:path.join(bundleRoot,'opencode/opencode.db'),webDataDirectory:path.join(bundleRoot,'web-data'),webConfigDirectory:path.join(bundleRoot,'config/openchamber'),opencodeConfigDirectory:global.config,global,
      reviewedNativeConfigPath:path.join(bundleRoot,'config/reviewed-native.json'),reviewedPluginManifestPath:path.join(bundleRoot,'config/reviewed-plugins.json'),controllerBinary:path.join(root,'controller'),writerBinary:path.join(root,'writer'),artifactManifestPath:path.join(root,'native-bundle.json'),artifactManifestSha256:'a'.repeat(64)};
    for(const directory of [...Object.values(global),launch.webDataDirectory,launch.webConfigDirectory,path.dirname(launch.opencodeDatabasePath),path.join(bundleRoot,'sources')])await fs.mkdir(directory,{recursive:true,mode:0o700});
    for(const file of [launch.opencodeDatabasePath,launch.reviewedNativeConfigPath,launch.reviewedPluginManifestPath,path.join(bundleRoot,'sources/migration.json')])await fs.writeFile(file,'{}');
    const descriptor={schema:1,bundleID:id,generation:2,createdAt:Date.now(),launch,projectMap:[{sourceDirectory:workspace,targetDirectory:workspace,mode:'identity'}],
      checkpoint:{checkpointID:'fixture',ownerID:'legacy',generation:1,databasePath:launch.opencodeDatabasePath,webDataDirectory:launch.webDataDirectory,webConfigDirectory:launch.webConfigDirectory,opencodeConfigDirectory:global.config,settledAt:Date.now()},
      preparedManifestPath:path.join(bundleRoot,'prepared.json'),migrationReceiptPath:path.join(bundleRoot,'sources/migration.json')};
    const bytes=JSON.stringify(descriptor);await fs.writeFile(path.join(bundleRoot,'descriptor.json'),bytes);
    const manifest=JSON.stringify({schema:1,bundleID:id,checkpointID:'fixture',descriptorSha256:createHash('sha256').update(bytes).digest('hex')});await fs.writeFile(descriptor.preparedManifestPath,manifest);
    await fs.writeFile(path.join(controlRoot,'selection.json'),JSON.stringify({schema:1,revision:1,selectedBundleID:id,previousBundleID:null,transition:'activate',reconciliationRequired:false,preparedManifestSha256:createHash('sha256').update(manifest).digest('hex')}));
    return readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:controlRoot});
  };
  const source=await bindingFor('source'),candidate=await bindingFor('candidate'),calls=[];let sourceHeld=false,escaped,mutateBeforeProject=false;
  const canary='synthetic-private-canary-'+ 'Z'.repeat(40);
  const row={id:'fixture_account',integrationID:'xai',label:'private label',active:true,value:{type:'key',key:canary}};
  const empty={protocol,credentials:[],refreshBlockState:null,claudeLifecycle:null};
  const snapshots=new Map([['source',{...empty,credentials:[row]}],['candidate',structuredClone(empty)]]);
  const grant=Object.freeze({ownerID:'source',controlRoot:source.controlRoot,withHeldCheckpoint:async action=>{
    assert.equal(sourceHeld,false);sourceHeld=true;try{return await action({assertHeld:async()=>{if(!sourceHeld)throw Object.assign(new Error('expired'),{code:'fixture_source_expired'});}});}finally{sourceHeld=false;}
  }});
  const credentialProcess=async({descriptor,action,assertHeld})=>{
    await assertHeld();calls.push([descriptor.bundleID,action.action]);
    if(action.action==='capture'){const snapshot=structuredClone(snapshots.get(descriptor.bundleID));return {protocol,status:'captured',snapshot,sha256:hash(snapshot)};}
    assert.equal(sourceHeld,true);assert.equal(descriptor.bundleID,'candidate');assert.equal(action.binding.sourceBundleID,'source');
    if(mutateBeforeProject)snapshots.get('candidate').refreshBlockState={changed:true};
    if(action.binding.expectedTargetSha256!==hash(snapshots.get('candidate')))throw Object.assign(new Error('CAS changed'),{code:'bundle_credential_baseline_changed'});
    snapshots.set('candidate',structuredClone(action.source));await assertHeld();return {protocol,status:'projected',...action.binding,appliedSha256:hash(action.source)};
  };
  const options={neverStarted:true,closeAdmission:async()=>calls.push(['candidate','close-admission']),getController:()=>null,stopProducers:async()=>{},executionHost:{drain:async()=>{}},drainStores:async()=>{}};
  const owner=createHeldSourceCredentials({grant,sourceBinding:source,credentialProcess});
  return {root,source,candidate,calls,row,canary,snapshots,owner,grant,credentialProcess,options,
    preparedSource:{checkpointOptions:async()=>options},race:()=>{mutateBeforeProject=true;},setEscaped:fn=>{escaped=fn;},getEscaped:()=>escaped};
}
test('source verification and nested candidate CAS return only bound native admission rows and exact metadata fingerprints',async t=>{
  const f=await fixture(t);const rows=await f.owner.verify({requiredProviders:['xai'],timeoutMs:1000});
  assert.equal(Object.isFrozen(rows),true);assert.equal(rows.xai.expectedFingerprint,credentialMutationFingerprint({id:f.row.id,integrationID:'xai',label:f.row.label,value:f.row.value}));
  const projected=await f.owner.bootstrap({binding:f.candidate,requiredProviders:['xai'],preparedSource:f.preparedSource,cellTimeoutMs:1000});
  assert.equal(projected.credentials.xai.bundleID,'candidate');assert.equal(projected.credentials.xai.expectedFingerprint,rows.xai.expectedFingerprint);
  assert.deepEqual(f.calls,[['source','capture'],['source','capture'],['candidate','close-admission'],['candidate','capture'],['candidate','project'],['candidate','capture']]);
  const output=JSON.stringify({rows,projected});for(const value of [f.canary,'private label',hash(f.snapshots.get('source')),'sourceSha256','refreshBlockState','claudeLifecycle'])assert.equal(output.includes(value),false);
  assert.deepEqual(await fs.readdir(f.root),['candidate','source','workspace']);
});
test('unverified source, changed source and a racing candidate baseline refuse without retry or projection overwrite',async t=>{
  const f=await fixture(t),input={binding:f.candidate,requiredProviders:['xai'],preparedSource:f.preparedSource,cellTimeoutMs:1000};
  await assert.rejects(f.owner.bootstrap(input),{code:'qa_held_source_unverified'});await f.owner.verify({requiredProviders:['xai'],timeoutMs:1000});
  f.snapshots.get('source').credentials[0].value.key+='changed';await assert.rejects(f.owner.bootstrap(input),{code:'qa_held_source_changed'});
  f.snapshots.get('source').credentials[0].value.key=f.canary;f.race();await assert.rejects(f.owner.bootstrap(input),{code:'bundle_credential_baseline_changed'});
  assert.deepEqual(f.snapshots.get('candidate').credentials,[]);assert.equal(f.calls.filter(([,action])=>action==='project').length,1);
});
test('a candidate must be never-started and escaped held authority expires after the composed action',async t=>{
  const f=await fixture(t);
  let escaped;
  const owner=createHeldSourceCredentials({grant:f.grant,sourceBinding:f.source,credentialProcess:f.credentialProcess,
    verifyAdditionalCredentials:async({binding,assertHeld})=>{await assertHeld();return {anthropic:{kind:'meridian-profile',providerId:'anthropic',bundleID:binding.descriptor.bundleID,controlRoot:binding.controlRoot,profileID:'private_profile',configurationFingerprint:'c'.repeat(64),authKind:'claude-max',expires:Date.now()+3600000}};},
    admitCandidate:async({binding,assertHeld})=>{await assertHeld();if(escaped)await assert.rejects(escaped());escaped=assertHeld;f.setEscaped(assertHeld);return {anthropic:{kind:'meridian-profile',providerId:'anthropic',bundleID:binding.descriptor.bundleID,controlRoot:binding.controlRoot,profileID:'private_profile',configurationFingerprint:'d'.repeat(64),authKind:'claude-max',expires:Date.now()+3600000}};}});
  await owner.verify({requiredProviders:['xai','anthropic'],timeoutMs:1000});
  const input={binding:f.candidate,requiredProviders:['xai','anthropic'],preparedSource:f.preparedSource,cellTimeoutMs:1000};
  await assert.rejects(owner.bootstrap({...input,preparedSource:{checkpointOptions:async()=>({...f.options,neverStarted:false})}}),{code:'qa_held_source_candidate_not_never_started'});
  await owner.bootstrap(input);await assert.rejects(f.getEscaped()());
  await owner.bootstrap(input);await assert.rejects(f.getEscaped()());
});
test('dedicated Claude enrollment and insufficient OAuth lifetime refuse the default access-only lane',async t=>{
  const f=await fixture(t);f.snapshots.get('source').claudeLifecycle={protocol:'devryan.claude-lifecycle/1',revision:1,accounts:[],unresolved:[]};
  await assert.rejects(f.owner.verify({requiredProviders:['xai'],timeoutMs:1000}),{code:'qa_held_source_claude_enrollment_present'});
  f.snapshots.get('source').claudeLifecycle=null;f.snapshots.get('source').credentials[0].value={type:'oauth',access:f.canary,refresh:f.canary,expires:Date.now()+1000,methodID:'device'};
  await assert.rejects(f.owner.verify({requiredProviders:['xai'],timeoutMs:1000}),{code:'qa_native_credential_expiry'});
});
test('keyed leakage windows detect raw, encoded and unaligned fragments across chunk boundaries with counts only',async t=>{
  const root=await fs.mkdtemp(path.resolve('.cache/leak-probe-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const value='secret-canary-+/=?'+ 'Q'.repeat(40),probe=createCredentialLeakProbe();probe.record(value);
  const file=path.join(root,'evidence.json');await fs.writeFile(file,JSON.stringify({safe:'admission only'}));
  assert.deepEqual(await probe.scan(root),{files:1,bytes:(await fs.stat(file)).size,hits:0});
  for(const leaked of [value,Buffer.from(value).toString('base64'),encodeURIComponent(value),value.slice(9,45)]){
    await fs.writeFile(file,'a'.repeat(16377)+leaked+'b'.repeat(20));const result=await probe.scan(root);assert.ok(result.hits>0);assert.deepEqual(Object.keys(result),['files','bytes','hits']);
  }
  await fs.unlink(file);await fs.symlink('/never/read/account',file);await assert.rejects(probe.scan(root),{code:'qa_leak_probe_path_invalid'});
});
async function accessOnlyFixture(t){
  const f=await fixture(t),profileID='qa-independent-cli';
  const directoryFor=binding=>path.join(binding.descriptor.launch.global.home,'.config/meridian/accounts',createHash('sha256').update(profileID).digest('hex'));
  const service=claudeKeychainService(directoryFor(f.source),f.source.descriptor.launch.global.home);
  const configure=async(binding,keychainService=service)=>{
    const directory=directoryFor(binding);await fs.mkdir(directory,{recursive:true,mode:0o700});
    await fs.writeFile(path.join(binding.descriptor.launch.global.home,'.config/meridian/profiles.json'),JSON.stringify([{id:profileID,type:'claude-max',claudeConfigDir:directory,keychainService}]),{mode:0o600});
    await fs.writeFile(path.join(binding.descriptor.launch.global.home,'.config/meridian/settings.json'),JSON.stringify({activeProfile:profileID}),{mode:0o600});
  };
  await configure(f.source);await configure(f.candidate);
  let value={claudeAiOauth:{accessToken:f.canary,refreshToken:f.canary+'-refresh',expiresAt:Date.now()+3600000}},reads=0;
  const access=createAccessOnlyAnthropic({sourceBinding:f.source,credentialProcess:f.credentialProcess,
    verifyArtifacts:async()=>({reviewedClaudeCredentials:{},reviewedClaude:{claude:{path:path.join(f.root,'DevRyan-Claude')}}}),
    loadReviewedModule:async()=>({ensureFreshToken:()=>assert.fail('refresh forbidden'),refreshOAuthToken:()=>assert.fail('exchange forbidden'),
      createPlatformCredentialStore:options=>{assert.equal(options.serviceName,service);return {read:async()=>{reads++;return structuredClone(value);},write:()=>assert.fail('write forbidden')};}})});
  const owner=createHeldSourceCredentials({grant:f.grant,sourceBinding:f.source,credentialProcess:f.credentialProcess,
    verifyAdditionalCredentials:access.verifyLogin,admitCandidate:access.admitCandidate});
  return {...f,access,owner,configure,value:()=>value,setValue:next=>{value=next;},reads:()=>reads};
}
test('access-only Claude uses the exact source service in both holds and returns expiring profile metadata without refresh or writes',async t=>{
  const f=await accessOnlyFixture(t),requiredProviders=['xai','anthropic'];
  const verified=await f.owner.verify({requiredProviders,timeoutMs:1000});
  const candidate=await f.owner.bootstrap({binding:f.candidate,requiredProviders,preparedSource:f.preparedSource,cellTimeoutMs:1000});
  assert.equal(verified.anthropic.authKind,'claude-max');assert.equal(candidate.credentials.anthropic.bundleID,'candidate');assert.ok(f.reads()>1);
  assert.equal(JSON.stringify({verified,candidate}).includes(f.canary),false);
  const command=await f.access.loginCommand(f.root);
  assert.ok(command.includes('env -i'));assert.ok(command.includes("'DevRyan-Claude'")===false);assert.ok(command.includes(path.join(f.root,'DevRyan-Claude')));assert.ok(command.endsWith(' auth login'));
  assert.equal(command.includes(f.canary),false);assert.equal(command.includes('ANTHROPIC_API_KEY'),false);
});
test('a changed Claude record, foreign candidate service and insufficient token lifetime refuse access-only admission',async t=>{
  const f=await accessOnlyFixture(t),requiredProviders=['xai','anthropic'];await f.owner.verify({requiredProviders,timeoutMs:1000});
  const input={binding:f.candidate,requiredProviders,preparedSource:f.preparedSource,cellTimeoutMs:1000};
  const original=f.value();f.setValue({...original,claudeAiOauth:{...original.claudeAiOauth,accessToken:f.canary+'-changed'}});
  await assert.rejects(f.owner.bootstrap(input),{code:'qa_access_only_login_changed'});
  f.setValue(original);await f.configure(f.candidate,'Claude Code-credentials-12345678');
  await assert.rejects(f.owner.bootstrap(input),{code:'qa_access_only_service_changed'});
  const g=await accessOnlyFixture(t);g.setValue({...g.value(),claudeAiOauth:{...g.value().claudeAiOauth,expiresAt:Date.now()+120000}});
  await assert.rejects(g.owner.verify({requiredProviders,timeoutMs:1000}),{code:'qa_native_credential_expiry'});
});
