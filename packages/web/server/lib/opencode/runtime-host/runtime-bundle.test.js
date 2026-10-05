import {NATIVE_BUNDLE_CREDENTIAL_CONTRACT} from './native-bundle-credential-contract.js';
import {claudeKeychainService} from '../claude-credential-projection.js';
import {readRollbackIntentSync} from './bundle-rollback-intent.js';
import {verifyNativeBootMigration} from './native-boot-migration.js';
import {recoveredInputHash} from './native-recovered-input-hash.js';
import { afterEach, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveSqliteDriver } from '../db-maintenance-core.js';
import { verifyBundleOwnedContinuations } from './bundle-owned-continuations.js';
import { inspectBundleHarness } from './bundle-harness-integrity.js';
import { buildV2PromptContent, buildV2PromptFingerprint, buildDevryanPromptMetadata } from '../v2/admission.js';
import { createRuntimeBundleStore } from './runtime-bundle.js';
import { assertNoPendingMigration, assertBundlePendingInput, verifyMigrationReferences, sha256,canonicalJSON } from './bundle-migration-inventory.js';
import { readRuntimeBundleBinding, getRuntimeHome } from './runtime-bundle-binding.js';
import { git } from '../../../../../harness-runtime/lib/session-changes-git.js';
import { openChangeStore, changeKey } from '../../../../../harness-runtime/lib/session-changes-store.js';
import { createMigrationFixture, assertMigratedFixture } from '../../../../../../scripts/opencode-v2-native/migration-fixture.mjs';

const execute=promisify(execFile), roots=[];
// Store composition seam; native-bundle-credentials.test.ts exercises the
// original Credential/Database/KV operations against disposable native stores.
const emptyCredentialSnapshot={protocol:NATIVE_BUNDLE_CREDENTIAL_CONTRACT,credentials:[],refreshBlockState:null,claudeLifecycle:null};
const captureCredentials=async()=>({protocol:NATIVE_BUNDLE_CREDENTIAL_CONTRACT,status:'captured',snapshot:emptyCredentialSnapshot,sha256:sha256(canonicalJSON(emptyCredentialSnapshot))});
const reconciledCredentials=async({credentialBinding})=>({status:'reconciled',credentialReceipt:{protocol:NATIVE_BUNDLE_CREDENTIAL_CONTRACT,status:'projected',...credentialBinding,appliedSha256:credentialBinding.sourceSha256}});
afterEach(async () => { await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true}))); });
async function fixture({ compiledContracts = ['devryan.bundle.credential-owners/2',NATIVE_BUNDLE_CREDENTIAL_CONTRACT] } = {}) {
  const root=await fs.mkdtemp(path.resolve(import.meta.dirname,'../../../../../../.cache/v2-validation/runtime-bundle-')); roots.push(root);
  const seed=await createMigrationFixture({root});
  const artifacts=path.join(root,'artifacts'); await fs.mkdir(artifacts);
  const controllerBinary=path.join(artifacts,'DevRyan-controller'), writerBinary=path.join(artifacts,'DevRyan-writer');
  await fs.writeFile(controllerBinary,'unit-test artifact bytes\n'); await fs.writeFile(writerBinary,'unit-test writer bytes\n');
  const artifactManifestPath=path.join(artifacts,'manifest.json'); await fs.writeFile(artifactManifestPath,JSON.stringify({schema:1,...(compiledContracts===null?{}:{compiledContracts}),files:await Promise.all([controllerBinary,writerBinary].map(async file=>({path:path.basename(file),sha256:sha256(await fs.readFile(file)),size:(await fs.stat(file)).size,mode:(await fs.stat(file)).mode&0o777}))),inputs:{reviewedPlugins:[]}})+'\n');
  const reviewedNativeConfigPath=path.join(artifacts,'reviewed-native.json'), reviewedPluginManifestPath=path.join(artifacts,'reviewed-plugins.json');
  await fs.writeFile(reviewedNativeConfigPath,JSON.stringify({schema:1,configuration:{},catalogRequirements:{agents:[],plugins:[],tools:[],models:[]},
    locations:seed.projectMap.map(map=>({directory:map.targetDirectory,readRoots:[map.targetDirectory],protectedRoots:[]}))}));
  await fs.writeFile(reviewedPluginManifestPath,'{"schema":1,"plugins":[]}');
  const launchArtifacts={controllerBinary,writerBinary,artifactManifestPath,artifactManifestSha256:sha256(await fs.readFile(artifactManifestPath)),reviewedNativeConfigPath,reviewedPluginManifestPath};
  const sourceLaunch={opencodeDatabasePath:seed.sourceLaunch.opencodeDatabasePath,webDataDirectory:seed.sourceLaunch.webDataDirectory,webConfigDirectory:seed.sourceLaunch.webConfigDirectory,opencodeConfigDirectory:seed.sourceLaunch.opencodeConfigDirectory,global:{home:seed.sourceLaunch.global.home}};
  const controlRoot=path.join(root,'control'), checkpoints=[];
  let store;
  const withQuiescedSource=async (source,action) => {
    const descriptor=source.kind==='legacy' ? {generation:1,launch:source.launch}:JSON.parse(await fs.readFile(path.join(controlRoot,'bundles',source.bundleID,'descriptor.json'),'utf8'));
    // This fixture owns no live controller or scheduler. Its source SQLite
    // writer is closed by createMigrationFixture before this exclusive span.
    const checkpoint={checkpointID:`checkpoint_${checkpoints.length+1}`,ownerID:source.kind==='bundle'?source.bundleID:'fixture-offline-owner',generation:descriptor.generation,
      databasePath:descriptor.launch.opencodeDatabasePath,webDataDirectory:descriptor.launch.webDataDirectory,
      webConfigDirectory:descriptor.launch.webConfigDirectory,opencodeConfigDirectory:descriptor.launch.opencodeConfigDirectory,settledAt:Date.now()};
    checkpoints.push(checkpoint);let copying=true;
    const instanceID='00000000-0000-4000-8000-000000000001';
    const receipt={terminated:true,confined:true,cancelled:false,exitCode:0};
    const receiptPath=path.join(path.dirname(descriptor.launch.opencodeDatabasePath),'..','.native-controller',instanceID,'termination.json');
    await fs.mkdir(path.dirname(receiptPath),{recursive:true,mode:0o700});await fs.writeFile(receiptPath,JSON.stringify(receipt),{mode:0o600});
    // Constructor fixture only: tests do not claim real OS settlement.
    const settlement={host:{pid:1000001,startIdentity:'fixture original host'},controller:{pid:1000002,startIdentity:'fixture original controller',instanceID,code:0,signal:null,receipt:{path:receiptPath,...receipt},receiptSha256:sha256(canonicalJSON(receipt))},credentialDrained:true,storesDrained:true,registries:[{name:'managed-opencode-processes.json',sha256:null},{name:'managed-native-provider-processes.json',sha256:null}]};
    try{return await action(checkpoint,{settlement,assertHeld:async()=>{if(!copying)throw Error('fixture_checkpoint_expired');}});}finally{copying=false;}
  };
  const runMigration=async request => {
    const requestFile=path.join(root,'migration-request.json'); await fs.writeFile(requestFile,JSON.stringify(request));
    const script=path.join(root,'migration-runner.mjs');
    await fs.writeFile(script,`import fs from 'node:fs/promises';
import os from 'node:os'; import {runMigrationRequest} from ${JSON.stringify(path.join(process.cwd(),'server/lib/opencode/runtime-host/migration-mode.ts'))}; await runMigrationRequest(JSON.parse(await fs.readFile(process.argv[2],'utf8')));`);
    await execute('bun',[script,requestFile],{env:seed.environment,timeout:30_000,maxBuffer:1024*1024});
    return JSON.parse(await fs.readFile(request.receiptPath,'utf8'));
  };
  // These tests exercise copied stores with dummy executable bytes. Actual
  // package qualification uses the strict production verifier, never this seam.
  const verifyArtifacts=async ({generation,launch})=>{
    expect(generation).toBe(2);
    expect(launch.controllerBinary).toBe(controllerBinary);
    expect(launch.writerBinary).toBe(writerBinary);
    expect(launch.artifactManifestPath).toBe(artifactManifestPath);
    expect(launch.artifactManifestSha256).toBe(sha256(await fs.readFile(artifactManifestPath)));
    return {manifest:JSON.parse(await fs.readFile(artifactManifestPath,'utf8'))};
  };
  store=createRuntimeBundleStore({controlRoot,withQuiescedSource,runMigration,verifyArtifacts,captureCredentials});
  const baselineInput={bundleID:'baseline',generation:2,source:{kind:'legacy',launch:sourceLaunch},projectMap:seed.projectMap,auxiliary:{kind:'absent'},launchArtifacts};
  return {root,seed,controlRoot,store,baselineInput,launchArtifacts,checkpoints,withQuiescedSource,runMigration,verifyArtifacts};
}
test('original store clone forwards captured native enrollment authority without copying the dedicated account',async()=>{
 const f=await fixture(),baseline=await f.store.prepare(f.baselineInput);
 await f.store.select({bundleID:'baseline',expectedRevision:0});
 const enrollmentID='00000000-0000-4000-8000-000000000001';
 const directory=path.join(f.controlRoot,'claude-enrollments',enrollmentID);
 await fs.mkdir(path.dirname(directory),{mode:0o700});await fs.mkdir(directory,{mode:0o700});
 const profile={id:'devryan-'+enrollmentID,type:'claude-max',claudeConfigDir:directory,keychainService:claudeKeychainService(directory,baseline.launch.global.home),credentialPolicy:'access-only'};
 const profiles=path.join(baseline.launch.global.home,'.config/meridian/profiles.json');
 await fs.mkdir(path.dirname(profiles),{recursive:true});await fs.writeFile(profiles,JSON.stringify([profile]));
 // Any attempted external token copy/read would fail. Native capture is the
 // original constructor seam; actual KV/credential tests own its authority.
 await fs.symlink('/never/read/enrollment-credentials',path.join(directory,'.credentials.json'));
 const snapshot={...emptyCredentialSnapshot,claudeLifecycle:{protocol:'devryan.claude-lifecycle/1',revision:1,accounts:[{profileID:profile.id,service:profile.keychainService,configDirectory:directory,enrollmentID,generation:'original-generation',grantFingerprint:'a'.repeat(64),recordFingerprint:'b'.repeat(64)}],unresolved:[]}};
 const captured={protocol:NATIVE_BUNDLE_CREDENTIAL_CONTRACT,status:'captured',snapshot,sha256:sha256(canonicalJSON(snapshot))};
 const store=createRuntimeBundleStore({controlRoot:f.controlRoot,withQuiescedSource:f.withQuiescedSource,runMigration:f.runMigration,verifyArtifacts:f.verifyArtifacts,captureCredentials:async()=>captured});
 const candidate=await store.prepare({...f.baselineInput,bundleID:'enrolled',source:{kind:'bundle',bundleID:'baseline'}});
 expect(JSON.parse(await fs.readFile(path.join(candidate.launch.global.home,'.config/meridian/profiles.json'),'utf8'))).toEqual([profile]);
 expect((await fs.lstat(path.join(directory,'.credentials.json'))).isSymbolicLink()).toBe(true);
 const selected=await store.select({bundleID:'enrolled',expectedRevision:1});expect(selected.selectedBundleID).toBe('enrolled');
 const clone=JSON.parse(await fs.readFile(path.join(f.controlRoot,'bundles/enrolled/sources/clone.json'),'utf8'));
 expect(clone.sourceCredentialSha256).toBe(captured.sha256);
});
test('coherent legacy copy selects and rolls back existing bundles without the new clone capability',async () => {
  const f=await fixture({compiledContracts:[NATIVE_BUNDLE_CREDENTIAL_CONTRACT]}), original=sha256(await fs.readFile(f.seed.sourceLaunch.opencodeDatabasePath));
  const baseline=await f.store.prepare(f.baselineInput);
  const candidate=await f.store.prepare({...f.baselineInput,bundleID:'candidate',generation:2});
  await assertMigratedFixture({fixture:f.seed,descriptor:candidate});
  expect(sha256(await fs.readFile(f.seed.sourceLaunch.opencodeDatabasePath))).toBe(original);
  expect(await fs.readFile(path.join(candidate.launch.webConfigDirectory,'settings.json'),'utf8')).toContain('fixture-web-only');
  expect(await fs.readFile(path.join(candidate.launch.opencodeConfigDirectory,'opencode.json'),'utf8')).toContain('fixture-native-only');
  expect(candidate.launch.global.config).toBe(candidate.launch.opencodeConfigDirectory);
  await f.store.select({bundleID:'baseline',expectedRevision:0});
  const selected=await f.store.select({bundleID:'candidate',expectedRevision:1});
  expect(readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:f.controlRoot}).descriptor.generation).toBe(2);
  expect((await f.store.readSelected()).descriptor.bundleID).toBe('candidate');
  await expect(f.store.select({bundleID:'candidate',expectedRevision:0})).rejects.toMatchObject({code:'bundle_selection_revision_conflict'});
  const db=resolveSqliteDriver().open(candidate.launch.opencodeDatabasePath);
  const rootSession=f.seed.expected.sessions.find(row=>!row.parentID).id;
  db.prepare('UPDATE session_v2 SET metadata=? WHERE id=?').run('{"ownedAfterActivation":true}',rootSession);
  db.close();
  await fs.writeFile(path.join(candidate.launch.webDataDirectory,'candidate-created.txt'),'retained candidate work\n');
  expect((await f.store.verify({bundleID:'candidate',phase:'resume'})).integrity).toBe('verified');
  await expect(f.store.verify({bundleID:'candidate',phase:'prepared'})).rejects.toMatchObject({code:'bundle_snapshot_changed'});
  await expect(f.store.rollback({targetBundleID:'baseline',expectedRevision:selected.revision})).rejects.toMatchObject({code:'bundle_rollback_reconciliation_required'});
  expect((await f.store.readSelected()).descriptor.bundleID).toBe('candidate');
  expect(await fs.readFile(path.join(candidate.launch.webDataDirectory,'candidate-created.txt'),'utf8')).toBe('retained candidate work\n');
  expect(baseline.launch.opencodeDatabasePath).not.toBe(f.seed.sourceLaunch.opencodeDatabasePath);
  let reconciledCandidate;
  const resolver=createRuntimeBundleStore({controlRoot:f.controlRoot,withQuiescedSource:f.withQuiescedSource,runMigration:f.runMigration,verifyArtifacts:f.verifyArtifacts,
    captureCredentials,reconcileRollback:async input=>{reconciledCandidate=input.candidate.bundleID;return reconciledCredentials(input);}});
  const recovered=await resolver.rollback({targetBundleID:'baseline',expectedRevision:selected.revision});
  expect(reconciledCandidate).toBe('candidate'); expect(recovered.selection.previousBundleID).toBe('candidate');
  expect(recovered.selection.reconciliationRequired).toBe(false);
  expect(readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:f.controlRoot}).descriptor.generation).toBe(2);
});
test.each([
 ['missing',null],['empty',[]],['historical',['devryan-v2-clone/1','devryan.bundle.credentials/1','devryan.bundle.credential-owners/1']],
 ['foreign',['other.bundle.credential-owners/2']],['prefix',['devryan.bundle.credential-owners/20']],
])('new V2 clones refuse %s target capability before checkpoint or copy even for the same manifest',async(_name,compiledContracts)=>{
 const f=await fixture({compiledContracts});await f.store.prepare(f.baselineInput);await f.store.select({bundleID:'baseline',expectedRevision:0});
 const before=await fs.readFile(path.join(f.controlRoot,'selection.json')),checkpoints=f.checkpoints.length;
 await expect(f.store.prepare({...f.baselineInput,bundleID:'rejected',source:{kind:'bundle',bundleID:'baseline'}}))
  .rejects.toMatchObject({code:'bundle_credential_owner_unsupported'});
 expect(f.checkpoints).toHaveLength(checkpoints);
 expect(await fs.readFile(path.join(f.controlRoot,'selection.json'))).toEqual(before);
 await expect(fs.stat(path.join(f.controlRoot,'bundles','rejected'))).rejects.toMatchObject({code:'ENOENT'});
});
test('new V2 clones refuse a different historical target before compatibility, checkpoint or copy',async()=>{
 const f=await fixture();await f.store.prepare(f.baselineInput);await f.store.select({bundleID:'baseline',expectedRevision:0});
 const targetManifest={schema:1,compiledContracts:['devryan-v2-clone/1','devryan.bundle.credentials/1']};
 const artifactManifestPath=path.join(f.root,'artifacts','historical-manifest.json');await fs.writeFile(artifactManifestPath,JSON.stringify(targetManifest)+'\n');
 const targetArtifacts={...f.launchArtifacts,artifactManifestPath,artifactManifestSha256:sha256(await fs.readFile(artifactManifestPath))};
 const checkpoints=f.checkpoints.length;let compatibilityCalls=0;
 const store=createRuntimeBundleStore({controlRoot:f.controlRoot,withQuiescedSource:f.withQuiescedSource,runMigration:f.runMigration,captureCredentials,
  verifyArtifacts:async({generation,launch})=>{expect(generation).toBe(2);expect(launch).toBe(targetArtifacts);return {manifest:targetManifest};},
  verifyV2Compatibility:async()=>{compatibilityCalls++;throw Error('Incompatible consumer must be refused first');}});
 await expect(store.prepare({...f.baselineInput,bundleID:'rejected',source:{kind:'bundle',bundleID:'baseline'},launchArtifacts:targetArtifacts}))
  .rejects.toMatchObject({code:'bundle_credential_owner_unsupported'});
 expect(compatibilityCalls).toBe(0);expect(f.checkpoints).toHaveLength(checkpoints);
 expect((await f.store.readSelected()).descriptor.bundleID).toBe('baseline');
 await expect(fs.stat(path.join(f.controlRoot,'bundles','rejected'))).rejects.toMatchObject({code:'ENOENT'});
});
test('new V2 clones use the verified result, never a capability claim in the caller or raw manifest',async()=>{
 const f=await fixture();await f.store.prepare(f.baselineInput);await f.store.select({bundleID:'baseline',expectedRevision:0});
 const checkpoints=f.checkpoints.length;
 expect(JSON.parse(await fs.readFile(f.launchArtifacts.artifactManifestPath,'utf8')).compiledContracts).toContain('devryan.bundle.credential-owners/2');
 const store=createRuntimeBundleStore({controlRoot:f.controlRoot,withQuiescedSource:f.withQuiescedSource,runMigration:f.runMigration,captureCredentials,
  verifyArtifacts:async input=>{await f.verifyArtifacts(input);return {manifest:{compiledContracts:[]}};}});
 await expect(store.prepare({...f.baselineInput,bundleID:'rejected',source:{kind:'bundle',bundleID:'baseline'},
  launchArtifacts:{...f.launchArtifacts,compiledContracts:['devryan.bundle.credential-owners/2']}})).rejects.toMatchObject({code:'bundle_credential_owner_unsupported'});
 expect(f.checkpoints).toHaveLength(checkpoints);
 await expect(fs.stat(path.join(f.controlRoot,'bundles','rejected'))).rejects.toMatchObject({code:'ENOENT'});
});
test('a verified current target clones an old source and rollback retains the original artifact and candidate work',async()=>{
 const f=await fixture({compiledContracts:['devryan-v2-clone/1','devryan.bundle.credentials/1']});
 const baseline=await f.store.prepare(f.baselineInput);await f.store.select({bundleID:'baseline',expectedRevision:0});
 const originalPrepared=await fs.readFile(baseline.preparedManifestPath),originalDescriptor=await fs.readFile(path.join(f.controlRoot,'bundles','baseline','descriptor.json'));
 const targetManifest={...JSON.parse(await fs.readFile(f.launchArtifacts.artifactManifestPath,'utf8')),
  compiledContracts:['devryan-v2-clone/1',NATIVE_BUNDLE_CREDENTIAL_CONTRACT,'devryan.bundle.credential-owners/2']};
 const artifactManifestPath=path.join(f.root,'artifacts','current-manifest.json');await fs.writeFile(artifactManifestPath,JSON.stringify(targetManifest)+'\n');
 const targetArtifacts={...f.launchArtifacts,artifactManifestPath,artifactManifestSha256:sha256(await fs.readFile(artifactManifestPath))};
 const verified=[];
 const store=createRuntimeBundleStore({controlRoot:f.controlRoot,withQuiescedSource:f.withQuiescedSource,runMigration:f.runMigration,captureCredentials,reconcileRollback:reconciledCredentials,
  verifyArtifacts:async input=>{
   verified.push(input.launch.artifactManifestSha256);
   if(input.launch.artifactManifestPath!==artifactManifestPath)return f.verifyArtifacts(input);
   expect(input.generation).toBe(2);expect(input.launch.controllerBinary).toBe(targetArtifacts.controllerBinary);expect(input.launch.writerBinary).toBe(targetArtifacts.writerBinary);
   expect(input.launch.artifactManifestSha256).toBe(sha256(await fs.readFile(artifactManifestPath)));return {manifest:targetManifest};
  },verifyV2Compatibility:async({source,artifacts})=>({status:'compatible',binding:{protocol:'devryan-v2-clone/1',sourceBundleID:source.bundleID,
   sourceManifestSha256:source.launch.artifactManifestSha256,targetManifestSha256:artifacts.artifactManifestSha256}})});
 const candidate=await store.prepare({...f.baselineInput,bundleID:'current',source:{kind:'bundle',bundleID:'baseline'},launchArtifacts:targetArtifacts});
 expect(verified[0]).toBe(targetArtifacts.artifactManifestSha256);
 await store.select({bundleID:'current',expectedRevision:1});await fs.writeFile(path.join(candidate.launch.webDataDirectory,'candidate-work.txt'),'retained');
 const before=f.checkpoints.length;await expect(store.rollback({targetBundleID:'baseline',expectedRevision:2})).rejects.toMatchObject({code:'bundle_credential_contract_incompatible'});expect(f.checkpoints).toHaveLength(before);expect((await store.readSelected()).descriptor.bundleID).toBe('current');
 expect(baseline.sourceBundleID).toBeUndefined();expect(baseline.launch.artifactManifestSha256).toBe(f.launchArtifacts.artifactManifestSha256);
 expect(await fs.readFile(baseline.preparedManifestPath)).toEqual(originalPrepared);
 expect(await fs.readFile(path.join(f.controlRoot,'bundles','baseline','descriptor.json'))).toEqual(originalDescriptor);
 expect(await fs.readFile(path.join(candidate.launch.webDataDirectory,'candidate-work.txt'),'utf8')).toBe('retained');
 expect((await store.verify({bundleID:'baseline',phase:'resume'})).integrity).toBe('verified');
});
test('a selected V2 source clones its current database, settings and globals without rerunning V1 import',async()=>{
 const f=await fixture(),baseline=await f.store.prepare(f.baselineInput);await f.store.select({bundleID:'baseline',expectedRevision:0});
 const db=resolveSqliteDriver().open(baseline.launch.opencodeDatabasePath);
 const rootSession=f.seed.expected.sessions.find(row=>!row.parentID).id;
 db.prepare('UPDATE session_v2 SET metadata=? WHERE id=?').run('{"nativeV2AfterImport":true}',rootSession);
 db.prepare('INSERT INTO session_message(id,session_id,type,seq,data,time_created,time_updated) VALUES(?,?,?,?,?,?,?)')
  .run('msg_current_native',rootSession,'user',100,JSON.stringify({text:'Current native work',time:{created:1}}),1,1);
 db.prepare('INSERT INTO session_message(id,session_id,type,seq,data,time_created,time_updated) VALUES(?,?,?,?,?,?,?)')
  .run('msg_current_native_assistant',rootSession,'assistant',101,JSON.stringify({agent:'orchestrator',model:{providerID:'devryan-smoke',id:'smoke-write'},content:[{type:'text',text:'Current native complete'}],finish:'stop',time:{created:2,completed:3}}),2,3);db.close();
 await fs.writeFile(path.join(baseline.launch.webDataDirectory,'settings.json'),'{"themeId":"current-v2"}');
 await fs.writeFile(path.join(baseline.launch.global.state,'owned-current.json'),'current state');
 const before=sha256(await fs.readFile(baseline.launch.opencodeDatabasePath));
 const copied=await f.store.prepare({...f.baselineInput,bundleID:'successor',source:{kind:'bundle',bundleID:'baseline'}});
 expect(copied.sourceBundleID).toBe('baseline');expect(copied.checkpoint.generation).toBe(2);
 const target=resolveSqliteDriver().open(copied.launch.opencodeDatabasePath,{readonly:true});
 expect(JSON.parse(target.prepare('SELECT metadata FROM session_v2 WHERE id=?').get(rootSession).metadata)).toEqual({nativeV2AfterImport:true});
 expect(target.prepare('SELECT id FROM session_message WHERE id=?').get('msg_current_native').id).toBe('msg_current_native');target.close();
 expect(await fs.readFile(path.join(copied.launch.global.state,'owned-current.json'),'utf8')).toBe('current state');
 expect(JSON.parse(await fs.readFile(path.join(copied.launch.webDataDirectory,'settings.json'),'utf8'))).toEqual({themeId:'current-v2'});
 expect(sha256(await fs.readFile(baseline.launch.opencodeDatabasePath))).toBe(before);
 await f.store.select({bundleID:'successor',expectedRevision:1});
 expect((await f.store.verify({bundleID:'successor',phase:'resume'})).integrity).toBe('verified');
 const receiptBytes=await fs.readFile(copied.migrationReceiptPath);
 await expect(verifyNativeBootMigration({bundleID:copied.bundleID,databasePath:copied.launch.opencodeDatabasePath,manifestSha256:copied.launch.artifactManifestSha256,
  migrationEvidence:{path:copied.migrationReceiptPath,sha256:sha256(receiptBytes),clone:{preparedManifestPath:copied.preparedManifestPath,preparedManifestSha256:sha256(await fs.readFile(copied.preparedManifestPath))}}})).resolves.toMatchObject({bundleID:'baseline'});
});
test('blocked projection remains inspectable and resumes only unchanged retained B',async()=>{
 const f=await fixture();await f.store.prepare(f.baselineInput);await f.store.select({bundleID:'baseline',expectedRevision:0});
 await f.store.prepare({...f.baselineInput,bundleID:'candidate',source:{kind:'bundle',bundleID:'baseline'}});await f.store.select({bundleID:'candidate',expectedRevision:1});
 const candidate=(await f.store.readSelected()).descriptor;
 await fs.writeFile(path.join(candidate.launch.webDataDirectory,'current-candidate-work.txt'),'retained candidate work');
 const blocked=createRuntimeBundleStore({controlRoot:f.controlRoot,withQuiescedSource:f.withQuiescedSource,runMigration:f.runMigration,verifyArtifacts:f.verifyArtifacts,captureCredentials,
  reconcileRollback:async()=>({status:'blocked',reason:'bundle_credential_contract_incompatible'})});
 const result=await blocked.rollback({targetBundleID:'baseline',expectedRevision:2});
 expect(result.reason).toBe('bundle_credential_contract_incompatible');expect(result.selection.reconciliationRequired).toBe(true);
 expect(()=>readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:f.controlRoot})).toThrow('bundle_rollback_reconciliation_required');
 const inspected=readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:f.controlRoot},{allowHeldInspection:true});expect(inspected.admission).toBe('held');expect(inspected.descriptor.bundleID).toBe('baseline');
 const restored=createRuntimeBundleStore({controlRoot:f.controlRoot,withQuiescedSource:f.withQuiescedSource,runMigration:f.runMigration,verifyArtifacts:f.verifyArtifacts,captureCredentials,readProcessIdentity:()=>null});
 await expect(blocked.rollback({targetBundleID:'baseline',expectedRevision:3})).rejects.toMatchObject({code:'bundle_recovery_resume_required'});
 const final=await restored.resume({expectedRevision:3});expect(final.revision).toBe(4);expect(final.reconciliationRequired).toBe(false);expect(final.selectedBundleID).toBe('candidate');
 expect(readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:f.controlRoot}).admission).toBe('pending');
 expect(await fs.readFile(path.join(candidate.launch.webDataDirectory,'current-candidate-work.txt'),'utf8')).toBe('retained candidate work');
});
test('V2 activation refuses credentials changed after clone instead of selecting stale saved connections',async()=>{
 const f=await fixture();await f.store.prepare(f.baselineInput);await f.store.select({bundleID:'baseline',expectedRevision:0});
 await f.store.prepare({...f.baselineInput,bundleID:'candidate',source:{kind:'bundle',bundleID:'baseline'}});
 const snapshot={...emptyCredentialSnapshot,refreshBlockState:{fixtureChanged:true}};
 const changed=createRuntimeBundleStore({controlRoot:f.controlRoot,withQuiescedSource:f.withQuiescedSource,runMigration:f.runMigration,verifyArtifacts:f.verifyArtifacts,
  captureCredentials:async()=>({protocol:NATIVE_BUNDLE_CREDENTIAL_CONTRACT,status:'captured',snapshot,sha256:sha256(canonicalJSON(snapshot))})});
 await expect(changed.select({bundleID:'candidate',expectedRevision:1})).rejects.toMatchObject({code:'bundle_clone_credentials_changed'});
 expect((await changed.readSelected()).descriptor.bundleID).toBe('baseline');
 expect((await changed.verify({bundleID:'candidate',phase:'prepared'})).integrity).toBe('verified');
});
test('rollback refuses host quota disconnection before native projection and selects only held inspection',async()=>{
 const f=await fixture();const baseline=await f.store.prepare(f.baselineInput);
 const quota=path.join(baseline.launch.webDataDirectory,'quota','cursor-acp.json');await fs.mkdir(path.dirname(quota),{recursive:true});await fs.writeFile(quota,'{"accessToken":"synthetic-quota"}');
 await f.store.select({bundleID:'baseline',expectedRevision:0});
 const candidate=await f.store.prepare({...f.baselineInput,bundleID:'candidate',source:{kind:'bundle',bundleID:'baseline'}});
 await f.store.select({bundleID:'candidate',expectedRevision:1});
 await fs.rm(path.join(candidate.launch.webDataDirectory,'quota','cursor-acp.json'));let projected=false;
 const store=createRuntimeBundleStore({controlRoot:f.controlRoot,withQuiescedSource:f.withQuiescedSource,runMigration:f.runMigration,verifyArtifacts:f.verifyArtifacts,captureCredentials,
  reconcileRollback:async input=>{projected=true;return reconciledCredentials(input);}});
 const result=await store.rollback({targetBundleID:'baseline',expectedRevision:2});
 expect(result.reason).toBe('bundle_credential_owner_unsupported');expect(result.selection.reconciliationRequired).toBe(true);expect(projected).toBe(false);
 expect(()=>readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:f.controlRoot})).toThrow('bundle_rollback_reconciliation_required');
 expect(readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:f.controlRoot},{allowHeldInspection:true}).descriptor.bundleID).toBe('baseline');
 expect(await fs.readFile(quota,'utf8')).toContain('synthetic-quota');await expect(fs.stat(path.join(candidate.launch.webDataDirectory,'quota','cursor-acp.json'))).rejects.toMatchObject({code:'ENOENT'});
});
test('resume accepts completed conversation-only Revert while migration and unfinished ledger work remain closed',async()=>{
  const f=await fixture(); await f.store.prepare(f.baselineInput);
  const candidate=await f.store.prepare({...f.baselineInput,bundleID:'candidate',generation:2});
  const sessionID='ses_migration_root_1', messageID=`msg_${sessionID}_user`, directory=f.seed.projectMap[0].targetDirectory;
  const root=path.join(candidate.launch.webDataDirectory,'harness','session-mutations',changeKey(directory)), gitDir=path.join(root,'git');
  await fs.mkdir(root,{recursive:true}); await git(root,['init','--bare','--quiet',gitDir]);
  const ledger=await openChangeStore(root,gitDir), transactionID='10000000-0000-4000-8000-000000000001';
  const transaction={id:transactionID,rootSessionID:sessionID,members:[sessionID],targets:[{id:sessionID,targetMessageID:messageID}],state:'committed'};
  const session={id:sessionID,directory,generation:1,pending:null};
  const txKey=`transactions/${changeKey(transactionID)}.json`, sessionKey=`sessions/${changeKey(sessionID)}.json`;
  ledger.set('meta.json',{version:1,directory,sequence:1}); ledger.set(txKey,transaction); ledger.set(sessionKey,session); await ledger.commit();
  const native=resolveSqliteDriver().open(candidate.launch.opencodeDatabasePath);
  const marker={messageID,files:[]};
  const setMarker=value=>native.prepare('UPDATE session_v2 SET revert=? WHERE id=?').run(JSON.stringify(value),sessionID);
  const verify=()=>f.store.verify({bundleID:'candidate',phase:'resume'});
  try {
    setMarker(marker);
    expect((await verify()).admission).toBe('held');
    expect(()=>assertNoPendingMigration({all:(sql,params=[])=>native.prepare(sql).all(...params)})).toThrow('migration_revert_pending');
    ledger.set(txKey,{...transaction,state:'prepared'}); await ledger.commit();
    await expect(verify()).rejects.toMatchObject({code:'migration_revert_pending'});
    ledger.set(txKey,transaction); ledger.set(sessionKey,{...session,pending:transactionID}); await ledger.commit();
    await expect(verify()).rejects.toMatchObject({code:'migration_revert_pending'});
    ledger.set(sessionKey,session); await ledger.commit();
    ledger.set('materialization.json',{transactionID}); await ledger.commit();
    await expect(verify()).rejects.toMatchObject({code:'bundle_materialization_pending'});
    ledger.remove('materialization.json'); await ledger.commit();
    for (const value of [{...marker,snapshot:'unowned'}, {...marker,files:[{}]}, {...marker,partID:5}, {...marker,unknown:true}]) {
      setMarker(value); await expect(verify()).rejects.toMatchObject({code:'bundle_native_revert_invalid'});
    }
    setMarker({messageID:'msg_ses_migration_root_2_user',files:[]});
    await expect(verify()).rejects.toMatchObject({code:'migration_reference_lost'});
    setMarker(marker);
    const source=JSON.parse(await fs.readFile(candidate.migrationReceiptPath+'.source.json','utf8'));
    native.prepare('DELETE FROM kv WHERE key=?').run('migration.v1-v2');
    expect(()=>verifyMigrationReferences({all:(sql,params=[])=>native.prepare(sql).all(...params)},source.inventory,{phase:'resume',migrationReceiptMarker:'not-needed'})).toThrow('migration_marker_invalid');
    native.prepare('INSERT INTO kv(key,value,time_created,time_updated) VALUES(?,?,0,0)').run('migration.v1-v2','{"phase":"sessions"}');
    await expect(verify()).rejects.toMatchObject({code:'migration_marker_invalid'});
    native.prepare('UPDATE kv SET value=? WHERE key=?').run('{"phase":"completed"}','migration.v1-v2');
    expect((await verify()).integrity).toBe('verified');
  } finally { native.close(); }
});
test('scope-mismatched quiescence cannot make a prepared candidate',async () => {
  const f=await fixture();
  const store=createRuntimeBundleStore({controlRoot:f.controlRoot,runMigration:f.runMigration,verifyArtifacts:f.verifyArtifacts,
    withQuiescedSource:async (_source,action)=>action({checkpointID:'wrong',ownerID:'fixture',generation:1,settledAt:Date.now(),databasePath:'/wrong',
      webDataDirectory:f.seed.sourceLaunch.webDataDirectory,webConfigDirectory:f.seed.sourceLaunch.webConfigDirectory,opencodeConfigDirectory:f.seed.sourceLaunch.opencodeConfigDirectory})});
  await expect(store.prepare(f.baselineInput)).rejects.toMatchObject({code:'bundle_quiescence_scope_mismatch'});
  expect(await store.readSelected()).toBeNull();
  await expect(fs.stat(path.join(f.controlRoot,'bundles','baseline','descriptor.json'))).rejects.toMatchObject({code:'ENOENT'});
});
test('immutable reviewed catalog and artifact changes refuse resume and never update selection',async () => {
  const f=await fixture(); const baseline=await f.store.prepare(f.baselineInput);
  await fs.writeFile(baseline.launch.reviewedNativeConfigPath,'{}');
  await expect(f.store.verify({bundleID:'baseline',phase:'resume'})).rejects.toMatchObject({code:'bundle_snapshot_changed'});
  expect(await f.store.readSelected()).toBeNull();
});
test('early binding accepts exact generation-one globals and refuses a stale descriptor or a reconciliation hold',async () => {
  const f=await fixture(), baseline=await f.store.prepare(f.baselineInput);
  await f.store.select({bundleID:'baseline',expectedRevision:0});
  const bound=readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:f.controlRoot});
  expect(bound.descriptor.launch.global.data).toBe(path.join(f.controlRoot,'bundles','baseline','global','data'));
  expect(Object.isFrozen(bound.descriptor.launch.global)).toBe(true);
  expect(getRuntimeHome()).toBe(os.homedir());
  const descriptorFile=path.join(f.controlRoot,'bundles','baseline','descriptor.json');
  await fs.writeFile(descriptorFile,JSON.stringify({...baseline,createdAt:baseline.createdAt+1}));
  expect(()=>readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:f.controlRoot})).toThrow('runtime_bundle_binding_invalid');
  await fs.writeFile(descriptorFile,JSON.stringify(baseline));
  await fs.writeFile(path.join(f.controlRoot,'selection.json'),JSON.stringify({...bound.selection,reconciliationRequired:true}));
  expect(()=>readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:f.controlRoot})).toThrow('bundle_rollback_reconciliation_required');
});
test('copied existing ledger preserves original refs and rebinds settled lease paths with native identities',async()=>{
  const f=await fixture(), sourceDirectory=f.seed.projectMap[0].sourceDirectory, sessionID='ses_migration_root_1';
  const root=path.join(f.seed.sourceLaunch.webDataDirectory,'harness','session-mutations',changeKey(sourceDirectory)), gitDir=path.join(root,'git');
  await fs.mkdir(root,{recursive:true}); await git(root,['init','--bare','--quiet',gitDir]);
  const db=await openChangeStore(root,gitDir), token='10000000-0000-4000-8000-000000000001';
  db.set('meta.json',{version:1,directory:sourceDirectory,sequence:1});
  db.set(`sessions/${changeKey(sessionID)}.json`,{id:sessionID,generation:0,pending:null});
  db.set(`leases/${changeKey(token)}.json`,{token,directory:sourceDirectory,projectDirectory:sourceDirectory,
    scope:{sessionID,messageID:`msg_${sessionID}_assistant`,userMessageID:`msg_${sessionID}_user`,callID:`call_${sessionID}_read`},
    state:'cancelled',executionKind:'process',cancelledBeforeStart:true,cleaned:true,cleanupPending:false,
    viewDirectory:path.join(root,'views',token,'worktree'),workingDirectory:path.join(root,'views',token,'worktree'),auxiliaryDirectory:path.join(root,'context-cache')});
  await db.commit(); const originalOID=db.tree;
  await f.store.prepare(f.baselineInput);
  const candidate=await f.store.prepare({...f.baselineInput,bundleID:'candidate',generation:2});
  const targetDirectory=f.seed.projectMap[0].targetDirectory, targetRoot=path.join(candidate.launch.webDataDirectory,'harness','session-mutations',changeKey(targetDirectory));
  const copied=await openChangeStore(targetRoot,path.join(targetRoot,'git')), lease=await copied.get(`leases/${changeKey(token)}.json`);
  expect(lease.scope.userMessageID).toBe(`msg_${sessionID}_user`); expect(lease.directory).toBe(targetDirectory);
  expect(lease.viewDirectory).toBe(path.join(targetRoot,'views',token,'worktree'));
  const refs=(await git(targetRoot,['--git-dir',path.join(targetRoot,'git'),'for-each-ref','--format=%(refname) %(objectname)'])).toString();
  expect(refs).toContain(`refs/devryan/migration/checkpoint_2/state ${originalOID}`);
  const lost=await openChangeStore(targetRoot,path.join(targetRoot,'git')); lost.set('operations/lost.json',{scope:{sessionID,messageID:'msg_missing_owned_ref'}}); await lost.commit();
  await expect(f.store.verify({bundleID:'candidate',phase:'resume'})).rejects.toMatchObject({code:'bundle_message_reference_lost'});
});
test('a completed import with a lost host acknowledgement resumes only its exact copied preparation',async()=>{
  const f=await fixture(); await f.store.prepare(f.baselineInput);
  let interrupted=true;
  const store=createRuntimeBundleStore({controlRoot:f.controlRoot,withQuiescedSource:f.withQuiescedSource,verifyArtifacts:f.verifyArtifacts,
    runMigration:async request=>{const receipt=await f.runMigration(request); if(interrupted){interrupted=false;throw Object.assign(new Error('fixture_lost_migration_ack'),{code:'fixture_lost_migration_ack'});} return receipt;}});
  const input={...f.baselineInput,bundleID:'candidate',generation:2};
  await expect(store.prepare(input)).rejects.toMatchObject({code:'fixture_lost_migration_ack'});
  expect(await store.readSelected()).toBeNull();
  await expect(store.verify({bundleID:'candidate',phase:'resume'})).rejects.toMatchObject({code:'ENOENT'});
  await expect(store.prepare({...input,projectMap:input.projectMap.slice(0,1)})).rejects.toMatchObject({code:'bundle_preparation_identity_conflict'});
  const recovered=await store.prepare(input); await assertMigratedFixture({fixture:f.seed,descriptor:recovered});
  expect((await store.prepare(input)).bundleID).toBe('candidate');
  expect(await store.readSelected()).toBeNull();
});
test('selection pins prepared evidence even when a changed manifest hides a reviewed catalog mutation',async()=>{
  const f=await fixture(), baseline=await f.store.prepare(f.baselineInput); await f.store.select({bundleID:'baseline',expectedRevision:0});
  await fs.writeFile(baseline.launch.reviewedNativeConfigPath,'{}');
  const prepared=JSON.parse(await fs.readFile(baseline.preparedManifestPath,'utf8'));
  prepared.immutableFiles=prepared.immutableFiles.filter(row=>row.path!=='config/reviewed-native.json');
  await fs.writeFile(baseline.preparedManifestPath,JSON.stringify(prepared));
  await expect(f.store.readSelected()).rejects.toMatchObject({code:'bundle_selected_evidence_changed'});
  await expect(f.store.verify({bundleID:'baseline',phase:'resume'})).rejects.toMatchObject({code:'bundle_manifest_invalid'});
  expect(()=>readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:f.controlRoot})).toThrow('runtime_bundle_binding_invalid');
});
test('an identity baseline needs its own exact reviewed source locations; copied candidates retain relocation protection',async()=>{
 const f=await fixture();
 const projectMap=f.seed.projectMap.map(row=>({sourceDirectory:row.sourceDirectory,targetDirectory:row.sourceDirectory,mode:'identity'}));
 await expect(f.store.prepare({...f.baselineInput,bundleID:'wrong-identity',projectMap})).rejects.toMatchObject({code:'bundle_reviewed_source_access'});
 const reviewed=JSON.parse(await fs.readFile(f.launchArtifacts.reviewedNativeConfigPath,'utf8'));
 const reviewedNativeConfigPath=path.join(f.root,'identity-reviewed.json');
 await fs.writeFile(reviewedNativeConfigPath,JSON.stringify({...reviewed,locations:projectMap.map(row=>({directory:row.targetDirectory,readRoots:[row.targetDirectory],protectedRoots:[]}))}));
 const baseline=await f.store.prepare({...f.baselineInput,projectMap,launchArtifacts:{...f.launchArtifacts,reviewedNativeConfigPath}});
 expect(baseline.projectMap).toEqual(projectMap);
 expect((await f.store.verify({bundleID:'baseline',phase:'resume'})).descriptor.bundleID).toBe('baseline');
 await f.store.select({bundleID:'baseline',expectedRevision:0});
 expect((await f.store.readSelected()).descriptor.generation).toBe(2);
});
test('a copied native candidate cannot review a source project or an ancestor as a read root',async()=>{
  const f=await fixture(); await f.store.prepare(f.baselineInput);
  const document=JSON.parse(await fs.readFile(f.launchArtifacts.reviewedNativeConfigPath,'utf8'));
  document.locations[0].readRoots.push(path.dirname(f.seed.projectMap[0].sourceDirectory));
  await fs.writeFile(f.launchArtifacts.reviewedNativeConfigPath,JSON.stringify(document));
  await expect(f.store.prepare({...f.baselineInput,bundleID:'candidate',generation:2}))
    .rejects.toMatchObject({code:'bundle_reviewed_source_access'});
  expect(await f.store.readSelected()).toBeNull();
});
test('generation one cannot be prepared or selected and legacy input contains only offline data',async()=>{
 const f=await fixture();
 await expect(f.store.prepare({...f.baselineInput,generation:1})).rejects.toMatchObject({code:'bundle_prepare_invalid'});
 expect(f.checkpoints).toHaveLength(0);expect(await f.store.readSelected()).toBeNull();
 await expect(f.store.prepare({...f.baselineInput,source:{kind:'legacy',launch:{...f.baselineInput.source.launch,controllerBinary:f.launchArtifacts.controllerBinary}}})).rejects.toMatchObject({code:'bundle_legacy_source_invalid'});
 const baseline=await f.store.prepare(f.baselineInput);
 const descriptorFile=path.join(f.controlRoot,'bundles','baseline','descriptor.json');
 await fs.writeFile(descriptorFile,JSON.stringify({...baseline,generation:1}));
 await expect(f.store.select({bundleID:'baseline',expectedRevision:0})).rejects.toMatchObject({code:'bundle_descriptor_invalid'});
 await expect(f.store.verify({bundleID:'baseline',phase:'resume'})).rejects.toMatchObject({code:'bundle_descriptor_invalid'});
});
test('production preparation requires complete verified native artifacts before copying',async()=>{
 const f=await fixture();const store=createRuntimeBundleStore({controlRoot:f.controlRoot,withQuiescedSource:f.withQuiescedSource,runMigration:f.runMigration});
 await expect(store.prepare(f.baselineInput)).rejects.toMatchObject({code:'native_runtime_artifacts_unverified'});
 expect(f.checkpoints).toHaveLength(0);expect(await store.readSelected()).toBeNull();
});

test('baseline and native candidate preserve only existing global skill data roots and exact supporting bytes',async()=>{
  const f=await fixture(), home=f.seed.sourceLaunch.global.home;
  const records=[
    ['.agents/skills/16 Personal Name/SKILL.md',Buffer.from('---\nname: 16 Personal Name\ndescription: Original bytes\n---\nExact body\r\n')],
    ['.agents/skills/16 Personal Name/references/nested/notes.txt',Buffer.from('nested support\n')],
    ['.agents/skills/16 Personal Name/assets/data.bin',Buffer.from([0,1,2,255])],
    ['.opencode/skill/legacy/SKILL.md',Buffer.from('---\nname: Legacy\n---\nLegacy body\n')],
    ['.opencode/skills/plural/nested/SKILL.md',Buffer.from('---\nname: Nested Display\n---\nNested skill\n')],
  ];
  for(const [relative,bytes]of records){await fs.mkdir(path.dirname(path.join(home,relative)),{recursive:true});await fs.writeFile(path.join(home,relative),bytes);}
  await fs.writeFile(path.join(home,'.agents','private-state.json'),'fixture-only excluded home state');
  await fs.writeFile(path.join(home,'.opencode','auth.json'),'fixture-only excluded home state');
  const sourceDB=sha256(await fs.readFile(f.seed.sourceLaunch.opencodeDatabasePath));
  const baseline=await f.store.prepare(f.baselineInput);
  const candidate=await f.store.prepare({...f.baselineInput,bundleID:'candidate',generation:2});
  await assertMigratedFixture({fixture:f.seed,descriptor:candidate});
  for(const value of [baseline,candidate]){
    const manifest=JSON.parse(await fs.readFile(value.preparedManifestPath,'utf8'));
    for(const [relative,bytes]of records){
      expect(await fs.readFile(path.join(value.launch.global.home,relative))).toEqual(bytes);
      expect(manifest.initialFiles).toContainEqual({path:'global/home/'+relative,sha256:sha256(bytes)});
    }
    for(const relative of ['.agents/private-state.json','.opencode/auth.json'])await expect(fs.lstat(path.join(value.launch.global.home,relative))).rejects.toMatchObject({code:'ENOENT'});
    expect((await f.store.verify({bundleID:value.bundleID,phase:'resume'})).integrity).toBe('verified');
  }
  for(const [relative,bytes]of records)expect(await fs.readFile(path.join(home,relative))).toEqual(bytes);
  expect(sha256(await fs.readFile(f.seed.sourceLaunch.opencodeDatabasePath))).toBe(sourceDB);
});

test('fresh bundle creates parents for exact Meridian setup files in both prepared bundles',async()=>{
  const f=await fixture(),home=f.seed.sourceLaunch.global.home;
  const settings=Buffer.from('{"activeProfile":"fixture-account"}\n');
  const credentials=Buffer.from('{"claudeAiOauth":{"accessToken":"fixture-only","expiresAt":1}}\n');
  for(const [relative,bytes] of [['.config/meridian/settings.json',settings],['.claude/.credentials.json',credentials]]){
    const file=path.join(home,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes,{mode:0o600});
  }
  await fs.writeFile(path.join(home,'.config','meridian','profiles.json'),JSON.stringify([{id:'fixture-account',type:'claude-max'}]));
  const baseline=await f.store.prepare(f.baselineInput);
  const candidate=await f.store.prepare({...f.baselineInput,bundleID:'candidate',generation:2});
  for(const bundle of [baseline,candidate]){
    expect(await fs.readFile(path.join(bundle.launch.global.home,'.config','meridian','settings.json'))).toEqual(settings);
    expect(await fs.readFile(path.join(bundle.launch.global.home,'.claude','.credentials.json'))).toEqual(credentials);
    const [profile]=JSON.parse(await fs.readFile(path.join(bundle.launch.global.home,'.config','meridian','profiles.json'),'utf8'));
    expect(profile.id).toBe('fixture-account');expect(profile.claudeConfigDir.startsWith(bundle.launch.global.home+path.sep)).toBe(true);
    expect(await fs.readFile(path.join(profile.claudeConfigDir,'.credentials.json'))).toEqual(credentials);
    expect((await fs.stat(path.join(bundle.launch.global.home,'.claude','.credentials.json'))).mode&0o777).toBe(0o600);
  }
  expect(await fs.readFile(path.join(home,'.config','meridian','settings.json'))).toEqual(settings);
  expect(await fs.readFile(path.join(home,'.claude','.credentials.json'))).toEqual(credentials);
});
for(const attack of ['ancestor','leaf'])test(`global skill ${attack} symlink cannot escape during baseline copy`,async()=>{
  const f=await fixture(), home=f.seed.sourceLaunch.global.home, outside=path.join(f.root,'unreviewed-skill-data');
  await fs.mkdir(outside);await fs.writeFile(path.join(outside,'SKILL.md'),'fixture-only outside skill');
  if(attack==='ancestor')await fs.symlink(outside,path.join(home,'.agents'));
  else {await fs.mkdir(path.join(home,'.agents','skills','safe'),{recursive:true});await fs.symlink(path.join(outside,'SKILL.md'),path.join(home,'.agents','skills','safe','SKILL.md'));}
  const sourceDB=sha256(await fs.readFile(f.seed.sourceLaunch.opencodeDatabasePath));
  await expect(f.store.prepare(f.baselineInput)).rejects.toMatchObject({code:'bundle_symlink_source'});
  await expect(fs.stat(path.join(f.controlRoot,'bundles','baseline','prepared.json'))).rejects.toMatchObject({code:'ENOENT'});
  expect(await fs.readFile(path.join(outside,'SKILL.md'),'utf8')).toBe('fixture-only outside skill');
  expect(sha256(await fs.readFile(f.seed.sourceLaunch.opencodeDatabasePath))).toBe(sourceDB);
});

async function queuedContinuationFixture() {
  const f=await fixture(); await f.store.prepare(f.baselineInput);
  const candidate=await f.store.prepare({...f.baselineInput,bundleID:'candidate',generation:2});
  await f.store.select({bundleID:'baseline',expectedRevision:0}); await f.store.select({bundleID:'candidate',expectedRevision:1});
  const sessionID='ses_migration_root_1', directory=f.seed.projectMap[0].targetDirectory;
  const sourceUserMessageID='msg_resumeUser',sourceAssistantMessageID='msg_resumeAssistant',messageID='msg_resumeTodo';
  const model={providerID:'devryan-smoke',id:'smoke-write',variant:'default'}, tools={};
  const prompt={messageID,agent:'orchestrator',model:{providerID:model.providerID,modelID:model.id},variant:model.variant,
    objectiveID:sourceUserMessageID,tools,parts:[{type:'text',synthetic:true,text:'[devryan-open-todo-continuation:v1]\nContinue the open todo.'}]};
  const content=buildV2PromptContent(prompt.parts);
  const fingerprint=buildV2PromptFingerprint({sessionID,messageID,content,selection:prompt,objectiveID:prompt.objectiveID,origin:'managed-primary',resume:true,delivery:'queue',planMode:false});
  const payload={text:content.text,metadata:{devryan:buildDevryanPromptMetadata({origin:'managed-primary',agent:prompt.agent,
    providerID:model.providerID,modelID:model.id,variant:model.variant,planMode:false,parts:content.segments,
    objectiveID:prompt.objectiveID,admission:{v:1,fingerprint}},{text:content.text})}};
  const record={version:1,revision:3,sessionID,directory,anchorID:sourceUserMessageID,providerID:model.providerID,modelID:model.id,
    agent:prompt.agent,variant:model.variant,tools,owner:null,executionGeneration:2,state:'observing',attemptCount:0,
    guardedIDs:[],createdAt:1,updatedAt:3,cancellationGeneration:2,todoContinuationCount:1,stepID:null,recoveryID:null,
    continuationID:messageID,nativeContinuation:{messageID,sourceUserMessageID,sourceAssistantMessageID,cancellationGeneration:2,
      kind:'orchestrator_todo',prompt}};
  const file=path.join(candidate.launch.webDataDirectory,'harness','provider-recovery',sha256(sessionID)+'.json');
  const writeRecord=async value=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify({version:1,key:sha256(sessionID),record:value}));};
  await writeRecord(record);
  const native=resolveSqliteDriver().open(candidate.launch.opencodeDatabasePath);
  native.prepare('UPDATE session_v2 SET agent=?,model=? WHERE id=?').run(prompt.agent,JSON.stringify(model),sessionID);
  const addMessage=(id,seq,data)=>native.prepare('INSERT INTO session_message(id,session_id,type,seq,data,time_created,time_updated) VALUES(?,?,?,?,?,?,?)')
    .run(id,sessionID,data.type,seq,JSON.stringify({...data,type:undefined,time:{created:100,...data.time}}),100,100);
  const max=native.prepare('SELECT MAX(seq) AS seq FROM session_message WHERE session_id=?').get(sessionID).seq;
  addMessage(sourceUserMessageID,max+1,{type:'user',text:'Own the todo objective'});
  addMessage(sourceAssistantMessageID,max+2,{type:'assistant',agent:prompt.agent,model,content:[{type:'text',text:'Initial turn complete'}],finish:'stop',time:{completed:101}});
  const insert=()=>native.prepare('INSERT INTO session_inbox(id,session_id,type,payload,delivery,enqueued_seq,time_created) VALUES(?,?,?,?,?,?,?)')
    .run(messageID,sessionID,'user',JSON.stringify(payload),'queue',max+3,102);
  insert();
  return {...f,candidate,sessionID,directory,record,payload,file,native,writeRecord,insert,addMessage,
    verify:()=>f.store.verify({bundleID:'candidate',phase:'resume'})};
}

test('selected native bundle resumes an exact durable TODO inbox reservation without consuming it',async()=>{
  const f=await queuedContinuationFixture();
  try {
    const before=await fs.readFile(f.file);
    expect((await f.verify()).integrity).toBe('verified');
    expect((await f.verify()).admission).toBe('held');
    expect(await fs.readFile(f.file)).toEqual(before);
    expect(f.native.prepare('SELECT COUNT(*) AS n FROM session_inbox').get().n).toBe(1);
    expect(()=>assertNoPendingMigration({all:(sql,params=[])=>f.native.prepare(sql).all(...params)})).toThrow('migration_pending_input_unsupported');
  } finally {f.native.close();}
});

test('native bundle retains reservation before dispatch and already committed input before the primary ACK',async()=>{
  const f=await queuedContinuationFixture();
  try {
    f.native.prepare('DELETE FROM session_inbox').run();
    expect((await f.verify()).integrity).toBe('verified');
    const next=f.native.prepare('SELECT MAX(seq) AS seq FROM session_message WHERE session_id=?').get(f.sessionID).seq+1;
    f.addMessage(f.record.continuationID,next,{type:'user',...f.payload});
    expect((await f.verify()).integrity).toBe('verified');
    await f.writeRecord({...f.record,executionGeneration:1});
    await expect(f.verify()).rejects.toMatchObject({code:'migration_pending_input_unsupported'});
  } finally {f.native.close();}
});

test('native bundle refuses unproved pending rows and changed durable continuation contracts',async()=>{
  const f=await queuedContinuationFixture(), refused={code:'migration_pending_input_unsupported'};
  const setPayload=value=>f.native.prepare('UPDATE session_inbox SET payload=?').run(JSON.stringify(value));
  try {
    for (const change of [
      r=>{r.executionGeneration=1;},r=>{r.sessionID='ses_wrong';},r=>{r.directory=path.dirname(r.directory);},
      r=>{r.state='cancelled';},r=>{r.recoverySuppressed=true;},r=>{r.owner={};},r=>{r.todoContinuationCount=0;},
      r=>{r.todoContinuationCount=4;},r=>{r.cancellationGeneration++;},r=>{r.nativeContinuation.cancellationGeneration++;},
      r=>{r.nativeContinuation.sourceUserMessageID='msg_wrong';},r=>{r.nativeContinuation.sourceAssistantMessageID='msg_wrong';},
      r=>{r.nativeContinuation.kind='unknown';},r=>{r.nativeContinuation.prompt.objectiveID='msg_wrong';},
      r=>{r.nativeContinuation.prompt.parts[0].text+=' changed';},r=>{r.nativeContinuation.prompt.model.modelID='changed';},
    ]) {
      const record=structuredClone(f.record);change(record);await f.writeRecord(record);
      await expect(f.verify()).rejects.toMatchObject(refused);
    }
    await f.writeRecord(f.record);
    for(const change of [p=>{p.text+=' changed';},p=>{p.metadata.devryan.admission.fingerprint='a'.repeat(64);},
      p=>{p.metadata.devryan.parts[0].kind='text';},p=>{p.files=[];},p=>{p.skills=[];}]){
      const payload=structuredClone(f.payload);change(payload);setPayload(payload);
      await expect(f.verify()).rejects.toMatchObject(refused);
    }
    setPayload(f.payload);
    for(const [column,value]of [['delivery','steer'],['type','synthetic'],['session_id','ses_migration_root_2']]){
      f.native.prepare(`UPDATE session_inbox SET ${column}=?`).run(value);await expect(f.verify()).rejects.toMatchObject(refused);
      f.native.prepare(`UPDATE session_inbox SET ${column}=?`).run(column==='delivery'?'queue':column==='type'?'user':f.sessionID);
    }
    f.native.prepare('INSERT INTO session_inbox(id,session_id,type,payload,delivery,enqueued_seq,time_created) VALUES(?,?,?,?,?,?,?)')
      .run('msg_extra',f.sessionID,'user',JSON.stringify(f.payload),'queue',1000,102);
    await expect(f.verify()).rejects.toMatchObject(refused);f.native.prepare('DELETE FROM session_inbox WHERE id=?').run('msg_extra');
    f.native.prepare('INSERT INTO session_pending(id,session_id,type,data,admitted_seq,time_created) VALUES(?,?,?,?,?,?)')
      .run('msg_pending',f.sessionID,'user',JSON.stringify(f.payload),1000,102);
    await expect(f.verify()).rejects.toMatchObject(refused);f.native.prepare('DELETE FROM session_pending').run();
    f.native.prepare('UPDATE session_v2 SET agent=? WHERE id=?').run('build',f.sessionID);
    await expect(f.verify()).rejects.toMatchObject(refused);f.native.prepare('UPDATE session_v2 SET agent=? WHERE id=?').run(f.record.agent,f.sessionID);
    const source=f.native.prepare('SELECT data FROM session_message WHERE id=?').get(f.record.nativeContinuation.sourceAssistantMessageID).data;
    f.native.prepare('UPDATE session_message SET data=? WHERE id=?').run(JSON.stringify({...JSON.parse(source),time:{created:100}}),f.record.nativeContinuation.sourceAssistantMessageID);
    await expect(f.verify()).rejects.toMatchObject(refused);f.native.prepare('UPDATE session_message SET data=? WHERE id=?').run(source,f.record.nativeContinuation.sourceAssistantMessageID);
    f.addMessage('msg_newerInput',1000,{type:'user',text:'A newer real turn'});await expect(f.verify()).rejects.toMatchObject(refused);
    f.native.prepare('DELETE FROM session_message WHERE id=?').run('msg_newerInput');
    f.addMessage(f.record.continuationID,1000,{type:'user',...f.payload});await expect(f.verify()).rejects.toMatchObject(refused);
    f.native.prepare('DELETE FROM session_message WHERE id=?').run(f.record.continuationID);
    expect((await f.verify()).integrity).toBe('verified');
    await expect(f.store.select({bundleID:'candidate',expectedRevision:2})).rejects.toMatchObject(refused);
    await expect(f.store.verify({bundleID:'candidate',phase:'prepared'})).rejects.toMatchObject({code:'bundle_snapshot_changed'});
  } finally {f.native.close();}
});

test('queued message references cannot borrow another namespace, file or occurrence exemption',async()=>{
  const f=await queuedContinuationFixture(),refused={code:'bundle_message_reference_lost'};
  try {
    const context=path.join(f.candidate.launch.webDataDirectory,'harness','context','borrow.json');
    await fs.mkdir(path.dirname(context),{recursive:true});
    await fs.writeFile(context,JSON.stringify({sessionID:f.sessionID,anchorID:f.record.continuationID}));
    await expect(f.verify()).rejects.toMatchObject(refused);await fs.rm(context);
    await f.writeRecord({...f.record,extra:{sessionID:f.sessionID,anchorID:f.record.continuationID}});
    await expect(f.verify()).rejects.toMatchObject(refused);await f.writeRecord(f.record);
    const other=path.join(path.dirname(f.file),sha256('ses_migration_root_2')+'.json');
    const borrowed={...f.record,sessionID:'ses_migration_root_2',directory:f.seed.projectMap[1].targetDirectory,
      anchorID:'msg_ses_migration_root_2_user',nativeContinuation:undefined};
    await fs.writeFile(other,JSON.stringify({version:1,key:sha256(borrowed.sessionID),record:borrowed}));
    await expect(f.verify()).rejects.toMatchObject(refused);await fs.rm(other);
    expect((await f.verify()).integrity).toBe('verified');
  } finally {f.native.close();}
});

test('verified continuation pins refuse subsequent database or recovery-file changes',async()=>{
  const f=await queuedContinuationFixture();
  const db={all:(sql,params=[])=>f.native.prepare(sql).all(...params)};
  try {
    const proofs=await verifyBundleOwnedContinuations(db,f.candidate.launch.webDataDirectory);
    const sessionIDs=f.native.prepare('SELECT id FROM session_v2').all().map(row=>row.id),messageIDs=f.native.prepare('SELECT id FROM session_message').all().map(row=>row.id);
    const inspect=()=>inspectBundleHarness(f.candidate.launch.webDataDirectory,{sessionIDs,messageIDs,verifiedContinuations:proofs});
    await fs.rm(f.file);await expect(inspect()).rejects.toMatchObject({code:'bundle_message_reference_lost'});
    await f.writeRecord({...f.record,owner:'changed-owner'});await expect(inspect()).rejects.toMatchObject({code:'bundle_message_reference_lost'});
    await f.writeRecord(f.record);expect((await inspect()).sessionReferences).toContain(f.sessionID);
    f.native.prepare('UPDATE session_inbox SET time_created=time_created+1').run();
    expect(()=>assertBundlePendingInput(db,proofs)).toThrow('migration_pending_input_unsupported');
    f.native.prepare('UPDATE session_inbox SET time_created=time_created-1').run();
    f.native.prepare('UPDATE session_v2 SET title=? WHERE id=?').run('Changed pinned session',f.sessionID);
    expect(()=>assertBundlePendingInput(db,proofs)).toThrow('migration_pending_input_unsupported');
  } finally {f.native.close();}
});

test('existing builder and collection reservation kinds retain their queued restart contracts',async()=>{
  const f=await queuedContinuationFixture();
  try {
    for(const [kind,agent,count]of [['builder_todo','build',1],['collect','orchestrator',0]]){
      const record=structuredClone(f.record);record.agent=agent;record.todoContinuationCount=count;
      record.nativeContinuation.kind=kind;record.nativeContinuation.prompt.agent=agent;
      const prompt=record.nativeContinuation.prompt,content=buildV2PromptContent(prompt.parts);
      const fingerprint=buildV2PromptFingerprint({sessionID:f.sessionID,messageID:record.continuationID,content,selection:prompt,
        objectiveID:prompt.objectiveID,origin:'managed-primary',resume:true,delivery:'queue',planMode:content.planMode});
      const payload={text:content.text,metadata:{devryan:buildDevryanPromptMetadata({origin:'managed-primary',agent,
        providerID:record.providerID,modelID:record.modelID,variant:record.variant,planMode:content.planMode,
        parts:content.segments,objectiveID:prompt.objectiveID,admission:{v:1,fingerprint}},{text:content.text})}};
      f.native.prepare('UPDATE session_v2 SET agent=? WHERE id=?').run(agent,f.sessionID);
      const sourceID=record.nativeContinuation.sourceAssistantMessageID;
      const source=JSON.parse(f.native.prepare('SELECT data FROM session_message WHERE id=?').get(sourceID).data);
      f.native.prepare('UPDATE session_message SET data=? WHERE id=?').run(JSON.stringify({...source,agent}),sourceID);
      f.native.prepare('UPDATE session_inbox SET payload=?').run(JSON.stringify(payload));
      await f.writeRecord(record);expect((await f.verify()).integrity).toBe('verified');
    }
  } finally {f.native.close();}
});

test('canonical synthetic and compaction source parents retain the native sequence ownership proof',async()=>{
  const f=await queuedContinuationFixture();
  try {
    const userID=f.record.nativeContinuation.sourceUserMessageID;
    for(const [type,data]of [['synthetic',{text:'Owned shell completion',time:{created:100}}],
      ['compaction',{status:'completed',reason:'auto',summary:'Owned compact context',recent:'',time:{created:100}}]]){
      f.native.prepare('UPDATE session_message SET type=?,data=? WHERE id=?').run(type,JSON.stringify(data),userID);
      expect((await f.verify()).integrity).toBe('verified');
    }
  } finally {f.native.close();}
});

test('resolved exact cancellation permits rollback and reactivation while actual pending input remains refused',async()=>{
 const f=await queuedContinuationFixture();try{
  const row=f.native.prepare('SELECT * FROM session_inbox').get();
  f.native.prepare('INSERT INTO event_sequence(aggregate_id,seq) VALUES(?,?)').run(f.sessionID+':recovered-input-cancellation',row.enqueued_seq+1);
  f.native.prepare('DELETE FROM session_inbox').run();
  f.native.prepare('INSERT INTO event(id,aggregate_id,seq,created,type,data) VALUES(?,?,?,?,?,?)').run('evt_recoveredCancel:recovered-input',f.sessionID+':recovered-input-cancellation',row.enqueued_seq+1,103,'devryan.recovered-input.cancelled@1',JSON.stringify({version:1,sessionID:f.sessionID,inboxID:row.id,enqueuedSeq:row.enqueued_seq,type:row.type,delivery:row.delivery,payloadHash:recoveredInputHash({type:row.type,delivery:row.delivery,payload:f.payload}),instanceID:'fixture',nativeEvent:{id:'evt_recoveredCancel',type:'session.inbox.cancelled',version:1,aggregateID:f.sessionID,seq:row.enqueued_seq+1}}));
  const {nativeContinuation:_retired,...record}=f.record;
  await f.writeRecord({...record,state:'cancelled',recoveredInputDispositions:[{inputID:row.id,payloadHash:(await import('./native-recovered-input-hash.js')).recoveredInputHash({type:'user',delivery:'queue',payload:f.payload}),enqueuedSeq:row.enqueued_seq,type:'user',delivery:'queue',phase:'cancelled',eventID:'evt_recoveredCancel',eventSeq:row.enqueued_seq+1}]});
  expect((await f.verify()).integrity).toBe('verified');
  const lifecycle=createRuntimeBundleStore({controlRoot:f.controlRoot,withQuiescedSource:f.withQuiescedSource,runMigration:f.runMigration,verifyArtifacts:f.verifyArtifacts,captureCredentials,reconcileRollback:reconciledCredentials});
  const rolled=await lifecycle.rollback({targetBundleID:'baseline',expectedRevision:2});expect(rolled.selection.reconciliationRequired).toBe(false);
  const selected=await lifecycle.select({bundleID:'candidate',expectedRevision:rolled.selection.revision});expect(selected.selectedBundleID).toBe('candidate');
  f.insert();await expect(lifecycle.select({bundleID:'candidate',expectedRevision:selected.revision})).rejects.toMatchObject({code:'migration_pending_input_unsupported'});
 }finally{f.native.close();}
});

test('fresh default startup imports a private empty source and selects only verified native artifacts',async()=>{
 const f=await fixture(),home=path.join(f.root,'fresh-home'),artifactDirectory=path.dirname(f.launchArtifacts.artifactManifestPath);
 await fs.mkdir(home);await fs.copyFile(f.launchArtifacts.artifactManifestPath,path.join(artifactDirectory,'native-bundle.json'));
 const {provisionDefaultNativeBundle}=await import('./native-default-bundle.js');let verifications=0;
 const env={PATH:process.env.PATH},cwd=f.seed.projectMap[0].targetDirectory;
 const controlRoot=await provisionDefaultNativeBundle({env,home,cwd,artifactDirectory,runMigration:f.runMigration,
  verifyArtifacts:async({manifestPath,manifestSha256,launcher})=>{verifications++;const directory=path.dirname(manifestPath);return {directory,manifestPath,manifestSha256,launcher,controller:path.join(directory,path.basename(f.launchArtifacts.controllerBinary)),writer:path.join(directory,path.basename(f.launchArtifacts.writerBinary)),manifest:{inputs:{reviewedPlugins:[]}}};}});
 const binding=readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:controlRoot});expect(binding.descriptor.generation).toBe(2);
 expect(binding.descriptor.checkpoint.generation).toBe(1);expect(verifications).toBeGreaterThan(1);
 expect(binding.descriptor.launch.artifactManifestPath.startsWith(path.join(controlRoot,'artifacts')+path.sep)).toBe(true);
 expect(await fs.stat(path.join(path.dirname(controlRoot),'fresh-native-source')).catch(error=>error.code)).toBe('ENOENT');
 const db=resolveSqliteDriver().open(binding.descriptor.launch.opencodeDatabasePath,{readonly:true});try{expect(db.prepare('SELECT count(*) AS count FROM session_v2').get().count).toBe(0);}finally{db.close();}
 await fs.writeFile(path.join(binding.descriptor.launch.webDataDirectory,'settings.json'),'{"themeId":"current-native","selectedSessionId":"native-session"}');
 const beforeNative=sha256(await fs.readFile(binding.descriptor.launch.opencodeDatabasePath));
 expect(await provisionDefaultNativeBundle({env,home,cwd,artifactDirectory,verifyArtifacts:async()=>{throw Error('selected bundle not reimported');}})).toBe(controlRoot);
 expect(sha256(await fs.readFile(binding.descriptor.launch.opencodeDatabasePath))).toBe(beforeNative);
 expect(JSON.parse(await fs.readFile(path.join(binding.descriptor.launch.webDataDirectory,'settings.json'),'utf8')).selectedSessionId).toBe('native-session');
});
test('fresh default startup reseeds an abandoned first attempt with the owner current setup and leaves v1 plans in place',async()=>{
 const f=await fixture(),home=path.join(f.root,'retry-home'),config=path.join(home,'.config','openchamber'),artifactDirectory=path.dirname(f.launchArtifacts.artifactManifestPath);
 await fs.copyFile(f.launchArtifacts.artifactManifestPath,path.join(artifactDirectory,'native-bundle.json'));
 const plan=path.join(config,'projects','path_a','plans','plan.md');await fs.mkdir(path.dirname(plan),{recursive:true});await fs.writeFile(plan,'# saved v1 plan');
 await fs.writeFile(path.join(config,'projects','.DS_Store'),'\0\0\0\x01Bud1');await fs.writeFile(path.join(config,'projects','path_a.json'),'{broken');
 await fs.writeFile(path.join(config,'settings.json'),JSON.stringify({themeId:'first'}));
 const {provisionDefaultNativeBundle}=await import('./native-default-bundle.js');
 const env={PATH:process.env.PATH},cwd=f.seed.projectMap[0].targetDirectory,options={env,home,cwd,artifactDirectory,runMigration:f.runMigration,
  verifyArtifacts:async({manifestPath,manifestSha256,launcher})=>{const directory=path.dirname(manifestPath);return {directory,manifestPath,manifestSha256,launcher,controller:path.join(directory,path.basename(f.launchArtifacts.controllerBinary)),writer:path.join(directory,path.basename(f.launchArtifacts.writerBinary)),manifest:{inputs:{reviewedPlugins:[]}}};}};
 await expect(provisionDefaultNativeBundle(options)).rejects.toMatchObject({code:'native_setup_json_invalid',relativePath:'projects/path_a.json'});
 const sourceRoot=path.join(home,'.local','state','devryan','fresh-native-source');
 expect(JSON.parse(await fs.readFile(path.join(sourceRoot,'web-data','settings.json'),'utf8'))).toEqual({themeId:'first'});
 expect(await fs.stat(path.join(sourceRoot,'web-data','native-setup-seed.json')).catch(error=>error.code)).toBe('ENOENT');
 // The owner keeps using the old install between attempts.
 await fs.writeFile(path.join(config,'settings.json'),JSON.stringify({themeId:'second'}));await fs.writeFile(path.join(config,'projects','path_a.json'),JSON.stringify({id:'a',path:cwd,selectedSessionId:'old'}));
 const controlRoot=await provisionDefaultNativeBundle(options),binding=readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:controlRoot});
 expect(JSON.parse(await fs.readFile(path.join(binding.descriptor.launch.webDataDirectory,'settings.json'),'utf8')).themeId).toBe('second');
 expect(await fs.readdir(path.join(binding.descriptor.launch.webConfigDirectory,'projects'))).toEqual(['path_a.json']);
 expect(JSON.parse(await fs.readFile(path.join(binding.descriptor.launch.webConfigDirectory,'projects','path_a.json'),'utf8'))).toEqual({id:'a',path:cwd});
 expect(await fs.readFile(plan,'utf8')).toBe('# saved v1 plan');expect(await fs.stat(sourceRoot).catch(error=>error.code)).toBe('ENOENT');
});
test('default startup ignores old conversation databases and never falls back to an ambient runtime',async()=>{
 const f=await fixture(),home=path.join(f.root,'existing-home'),data=path.join(home,'.local','share','opencode');await fs.mkdir(data,{recursive:true});
 const file=path.join(data,'opencode.db');await fs.writeFile(file,'existing accepted work');const before=sha256(await fs.readFile(file));
 const artifactDirectory=path.dirname(f.launchArtifacts.artifactManifestPath);await fs.copyFile(f.launchArtifacts.artifactManifestPath,path.join(artifactDirectory,'native-bundle.json'));
 const {provisionDefaultNativeBundle}=await import('./native-default-bundle.js');
 const controlRoot=await provisionDefaultNativeBundle({env:{},home,cwd:f.root,artifactDirectory,runMigration:f.runMigration,
  verifyArtifacts:async({manifestPath,manifestSha256,launcher})=>{const directory=path.dirname(manifestPath);return {directory,manifestPath,manifestSha256,launcher,controller:path.join(directory,path.basename(f.launchArtifacts.controllerBinary)),writer:path.join(directory,path.basename(f.launchArtifacts.writerBinary)),manifest:{inputs:{reviewedPlugins:[]}}};}});
 expect(readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:controlRoot}).descriptor.generation).toBe(2);
 expect(sha256(await fs.readFile(file))).toBe(before);
 for(const env of [{OPENCODE_HOST:'http://localhost:1'},{OPENCODE_BINARY:'/fixture/opencode'},{OPENCODE_SKIP_START:'true'},{DEVRYAN_OPENCODE_GENERATION:'1'}])await expect(provisionDefaultNativeBundle({env,home,cwd:f.root})).rejects.toMatchObject({code:'native_runtime_configuration_unsupported'});
 const fresh=path.join(f.root,'missing-artifacts-home');await fs.mkdir(fresh);
 await expect(provisionDefaultNativeBundle({env:{},home:fresh,cwd:f.root,artifactDirectory:path.join(f.root,'missing')})).rejects.toMatchObject({code:'native_runtime_artifacts_unverified'});
 expect(await fs.stat(path.join(fresh,'.local','state','devryan','runtime-bundles','selection.json')).catch(error=>error.code)).toBe('ENOENT');
});

const releaseArtifacts=async(f,release,reviewedPlugins=[])=>{
 const directory=path.join(f.root,'release-'+release),files=[];await fs.mkdir(directory);
 for(const name of ['DevRyan-controller','DevRyan-writer']){const bytes=Buffer.from(`fixture ${name} ${release}\n`);await fs.writeFile(path.join(directory,name),bytes);await fs.chmod(path.join(directory,name),0o755);
  files.push({path:name,sha256:sha256(bytes),size:bytes.length,mode:0o755});}
 await fs.writeFile(path.join(directory,'native-bundle.json'),JSON.stringify({schema:1,release,files,inputs:{reviewedPlugins}})+'\n');return directory;
};
const launchDefault=async(f,home,artifactDirectory,runMigration=f.runMigration,captureLogicalSetup)=>{
 const {provisionDefaultNativeBundle}=await import('./native-default-bundle.js');await fs.mkdir(home,{recursive:true});
 return provisionDefaultNativeBundle({env:{PATH:process.env.PATH},home,cwd:f.seed.projectMap[0].targetDirectory,artifactDirectory,runMigration,captureLogicalSetup,
  verifyArtifacts:async({manifestPath,manifestSha256,launcher})=>{const directory=path.dirname(manifestPath);return {directory,manifestPath,manifestSha256,launcher,
   controller:path.join(directory,'DevRyan-controller'),writer:path.join(directory,'DevRyan-writer'),manifest:JSON.parse(await fs.readFile(manifestPath,'utf8'))};}});
};
const draftRoot=home=>path.join(home,'.local','state','devryan','runtime-bundles','bundles','default-native');
const timedOut=async()=>{throw Object.assign(Error('native_migration_timeout'),{code:'native_migration_timeout'});};
test('fresh default startup discards a candidate that died before its preparation seal and prepares again',async()=>{
 const f=await fixture(),home=path.join(f.root,'interrupted-home'),release=await releaseArtifacts(f,'A');
 const copyFile=fs.copyFile,web=path.join(draftRoot(home),'web-data')+path.sep;
 fs.copyFile=async(source,target,...rest)=>{if(String(target).startsWith(web))throw Object.assign(Error('EIO injected'),{code:'EIO'});return copyFile.call(fs,source,target,...rest);};
 try{await expect(launchDefault(f,home,release)).rejects.toMatchObject({code:'EIO'});}finally{fs.copyFile=copyFile;}
 expect(await fs.stat(draftRoot(home)).then(stat=>stat.isDirectory())).toBe(true);
 expect(await fs.stat(path.join(draftRoot(home),'sources','preparation.json')).catch(error=>error.code)).toBe('ENOENT');
 const controlRoot=await launchDefault(f,home,release);
 expect(readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:controlRoot}).descriptor.bundleID).toBe('default-native');
});
test('fresh default startup replaces a draft sealed by an earlier release and regenerates its reviewed plugins',async()=>{
 const f=await fixture(),home=path.join(f.root,'release-home'),plugin={id:'fixture-release-b',manifestDigest:'b'.repeat(64),capabilities:['read']};
 const releaseA=await releaseArtifacts(f,'A'),releaseB=await releaseArtifacts(f,'B',[plugin]);
 await expect(launchDefault(f,home,releaseA,timedOut)).rejects.toMatchObject({code:'native_migration_timeout'});
 expect(await fs.stat(path.join(draftRoot(home),'sources','preparation.json')).then(stat=>stat.isFile())).toBe(true);
 const controlRoot=await launchDefault(f,home,releaseB),binding=readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:controlRoot});
 expect(binding.descriptor.launch.artifactManifestSha256).toBe(sha256(await fs.readFile(path.join(releaseB,'native-bundle.json'))));
 expect(JSON.parse(await fs.readFile(binding.descriptor.launch.reviewedPluginManifestPath,'utf8')).plugins).toEqual([{...plugin,legacySpecs:[]}]);
});
test('fresh default startup resumes its own sealed draft and never resets anything once a bundle is selected',async()=>{
 const f=await fixture(),home=path.join(f.root,'resume-home'),releaseA=await releaseArtifacts(f,'A'),releaseB=await releaseArtifacts(f,'B');
 await expect(launchDefault(f,home,releaseA,timedOut)).rejects.toMatchObject({code:'native_migration_timeout'});
 const preparation=path.join(draftRoot(home),'sources','preparation.json'),sealed=await fs.readFile(preparation);
 const controlRoot=await launchDefault(f,home,releaseA);
 expect(await fs.readFile(preparation)).toEqual(sealed);
 const selection=await fs.readFile(path.join(controlRoot,'selection.json'));
 expect(await launchDefault(f,home,releaseB,timedOut)).toBe(controlRoot);
 expect(await fs.readFile(preparation)).toEqual(sealed);expect(await fs.readFile(path.join(controlRoot,'selection.json'))).toEqual(selection);
});
test('an interrupted stale-draft reset leaves only a .stale sibling that the next launch sweeps before provisioning',async()=>{
 const f=await fixture(),home=path.join(f.root,'sweep-home'),plugin={id:'fixture-release-b',manifestDigest:'b'.repeat(64),capabilities:['read']};
 const releaseA=await releaseArtifacts(f,'A'),releaseB=await releaseArtifacts(f,'B',[plugin]),bundles=path.dirname(draftRoot(home));
 await expect(launchDefault(f,home,releaseA,timedOut)).rejects.toMatchObject({code:'native_migration_timeout'});
 // The reset dies while removing the renamed draft: default-native is already gone.
 const rm=fs.rm;fs.rm=async(target,...rest)=>{if(path.basename(String(target)).startsWith('.stale-'))throw Object.assign(Error('EIO injected'),{code:'EIO'});return rm.call(fs,target,...rest);};
 try{await expect(launchDefault(f,home,releaseB)).rejects.toMatchObject({code:'EIO'});}finally{fs.rm=rm;}
 const [stale,...others]=await fs.readdir(bundles);expect(others).toEqual([]);expect(stale).toMatch(/^\.stale-/);
 expect(await fs.stat(path.join(bundles,stale,'sources','preparation.json')).then(value=>value.isFile())).toBe(true);
 await fs.rm(path.join(bundles,stale,'web-data'),{recursive:true,force:true});
 const controlRoot=await launchDefault(f,home,releaseB),binding=readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:controlRoot});
 expect(await fs.readdir(bundles)).toEqual(['default-native']);expect(binding.descriptor.bundleID).toBe('default-native');
 expect(JSON.parse(await fs.readFile(binding.descriptor.launch.reviewedPluginManifestPath,'utf8')).plugins).toEqual([{...plugin,legacySpecs:[]}]);
 // Once selected, a later unheld launch still sweeps .stale-* leftovers but never resets the selected draft.
 await fs.mkdir(path.join(bundles,'.stale-selected'));expect(await launchDefault(f,home,releaseA,timedOut)).toBe(controlRoot);
 expect(await fs.readdir(bundles)).toEqual(['default-native']);
});
test('a selected unheld launch prunes unreferenced artifact sets, sweeps drafts and finishes a half-deleted seed, but never under a lifecycle lock',async()=>{
 const f=await fixture(),home=path.join(await fs.realpath(os.tmpdir()),`selected-hygiene-${process.pid}-${Date.now()}`);roots.push(home);
 const releaseA=await releaseArtifacts(f,'A'),releaseB=await releaseArtifacts(f,'B'),bundles=path.dirname(draftRoot(home));
 await expect(launchDefault(f,home,releaseA,timedOut)).rejects.toMatchObject({code:'native_migration_timeout'});
 const controlRoot=await launchDefault(f,home,releaseB),artifacts=path.join(controlRoot,'artifacts');
 const shaA=sha256(await fs.readFile(path.join(releaseA,'native-bundle.json'))),shaB=sha256(await fs.readFile(path.join(releaseB,'native-bundle.json')));
 expect((await fs.readdir(artifacts)).sort()).toEqual([shaA,shaB].sort());
 const aged=new Date(Date.now()-2*60*60_000);for(const sha of [shaA,shaB])await fs.utimes(path.join(artifacts,sha),aged,aged);
 await fs.mkdir(path.join(bundles,'.stale-left'));
 // A 2.0.0 in-place removal of the fresh seed was interrupted after selection.
 const sourceRoot=path.join(path.dirname(controlRoot),'fresh-native-source');await fs.mkdir(path.join(sourceRoot,'opencode-config'),{recursive:true});
 await fs.writeFile(path.join(sourceRoot,'opencode-config','opencode.json'),'{}');
 // A lifecycle operation holds the selector: nothing is swept and the launch still succeeds.
 const {withCrossProcessFileLock}=await import('../../../../../harness-runtime/lib/atomic-file.js');
 await withCrossProcessFileLock(path.join(controlRoot,'selection.lock'),async()=>{expect(await launchDefault(f,home,releaseB)).toBe(controlRoot);});
 expect((await fs.readdir(bundles)).sort()).toEqual(['.stale-left','default-native']);expect((await fs.readdir(artifacts)).sort()).toEqual([shaA,shaB].sort());
 expect(await launchDefault(f,home,releaseB)).toBe(controlRoot);
 expect(await fs.readdir(bundles)).toEqual(['default-native']);expect(await fs.readdir(artifacts)).toEqual([shaB]);
 expect(await fs.stat(sourceRoot).catch(error=>error.code)).toBe('ENOENT');
 await expect(createRuntimeBundleStore({controlRoot,allowRecoveredInputStartup:true,runMigration:async()=>{throw Error('fixture no migration');},
  withQuiescedSource:async()=>{throw Error('fixture no checkpoint');},verifyArtifacts:async()=>{}}).verify({bundleID:'default-native',phase:'resume'})).resolves.toMatchObject({integrity:'verified'});
});
test('the stale sweep keeps a matching sealed draft',async()=>{
 const f=await fixture(),home=path.join(f.root,'sweep-sealed-home'),release=await releaseArtifacts(f,'A'),bundles=path.dirname(draftRoot(home));
 await expect(launchDefault(f,home,release,timedOut)).rejects.toMatchObject({code:'native_migration_timeout'});
 const preparation=path.join(draftRoot(home),'sources','preparation.json'),sealed=await fs.readFile(preparation);
 await fs.mkdir(path.join(bundles,'.stale-left','sources'),{recursive:true});await fs.writeFile(path.join(bundles,'.stale-left','sources','preparation.json'),sealed);
 await launchDefault(f,home,release);
 expect(await fs.readdir(bundles)).toEqual(['default-native']);expect(await fs.readFile(preparation)).toEqual(sealed);
});
const killedBeforeSelect=async(f,home,release)=>{
 const open=fs.open;fs.open=async(file,...rest)=>{if(path.basename(String(file))==='selection.lock')throw Object.assign(Error('killed before select'),{code:'EKILLED'});return open.call(fs,file,...rest);};
 try{await expect(launchDefault(f,home,release)).rejects.toMatchObject({code:'EKILLED'});}finally{fs.open=open;}
 expect(await fs.stat(path.join(draftRoot(home),'prepared.json')).then(stat=>stat.isFile())).toBe(true);
};
test('a sealed default draft whose migrated database was reopened before selection relaunches',async()=>{
 const f=await fixture(),home=path.join(f.root,'unselected-home'),release=await releaseArtifacts(f,'A');
 await killedBeforeSelect(f,home,release);
 const opencode=path.join(draftRoot(home),'opencode');expect((await fs.readdir(opencode)).sort()).toEqual(['opencode.db','opencode.db-shm','opencode.db-wal']);
 const preparation=await fs.readFile(path.join(draftRoot(home),'sources','preparation.json'));
 const controlRoot=await launchDefault(f,home,release);
 expect(readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:controlRoot}).descriptor.bundleID).toBe('default-native');
 expect(await fs.readFile(path.join(draftRoot(home),'sources','preparation.json'))).toEqual(preparation);
 // Shared memory is not snapshot content; committed WAL pages still are.
 const manifest=JSON.parse(await fs.readFile(path.join(draftRoot(home),'prepared.json'),'utf8'));
 expect(manifest.initialFiles.map(row=>row.path)).toEqual(expect.arrayContaining(['opencode/opencode.db','opencode/opencode.db-wal']));
 expect(manifest.initialFiles.some(row=>row.path.endsWith('.db-shm'))).toBe(false);
 const store=createRuntimeBundleStore({controlRoot,runMigration:async()=>{throw Error('fixture no import');},
  withQuiescedSource:async()=>{throw Error('fixture no checkpoint');},verifyArtifacts:async()=>{}});
 await fs.appendFile(path.join(opencode,'opencode.db-wal'),'\0');
 await expect(store.verify({bundleID:'default-native',phase:'prepared'})).rejects.toMatchObject({code:'bundle_snapshot_changed'});
});
test('a tampered sealed default draft is reset before selection, never trusted',async()=>{
 const f=await fixture(),home=path.join(f.root,'tampered-home'),release=await releaseArtifacts(f,'A');
 await killedBeforeSelect(f,home,release);
 const injected=path.join(draftRoot(home),'web-data','injected.json');await fs.writeFile(injected,'{"not":"prepared"}');
 const store=createRuntimeBundleStore({controlRoot:path.dirname(path.dirname(draftRoot(home))),runMigration:async()=>{throw Error('fixture no import');},
  withQuiescedSource:async()=>{throw Error('fixture no checkpoint');},verifyArtifacts:async()=>{}});
 await expect(store.verify({bundleID:'default-native',phase:'prepared'})).rejects.toMatchObject({code:'bundle_snapshot_changed'});
 const controlRoot=await launchDefault(f,home,release);
 expect(readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:controlRoot}).descriptor.bundleID).toBe('default-native');
 expect(await fs.stat(injected).catch(error=>error.code)).toBe('ENOENT');expect(await fs.readdir(path.dirname(draftRoot(home)))).toEqual(['default-native']);
});
test('only the bundle database wal-index is outside the prepared snapshot; any other planted *.db-shm resets the draft',async()=>{
 const f=await fixture(),home=path.join(f.root,'planted-shm-home'),release=await releaseArtifacts(f,'A');
 await killedBeforeSelect(f,home,release);
 const planted=path.join(draftRoot(home),'web-data','evil.db-shm');await fs.writeFile(planted,'tamper');
 const store=createRuntimeBundleStore({controlRoot:path.dirname(path.dirname(draftRoot(home))),runMigration:async()=>{throw Error('fixture no import');},
  withQuiescedSource:async()=>{throw Error('fixture no checkpoint');},verifyArtifacts:async()=>{}});
 await expect(store.verify({bundleID:'default-native',phase:'prepared'})).rejects.toMatchObject({code:'bundle_snapshot_changed'});
 const controlRoot=await launchDefault(f,home,release);
 expect(readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:controlRoot}).descriptor.bundleID).toBe('default-native');
 expect(await fs.stat(planted).catch(error=>error.code)).toBe('ENOENT');
});
test('an interrupted fresh-source removal after selection leaves only a sibling the next launch sweeps',async()=>{
 const f=await fixture(),home=path.join(f.root,'removal-home'),release=await releaseArtifacts(f,'A'),state=path.join(home,'.local','state','devryan');
 const rm=fs.rm;fs.rm=async(target,...rest)=>{
  if(path.basename(String(target)).startsWith('.fresh-native-source.removing-')||String(target)===path.join(state,'fresh-native-source')){
   await rm.call(fs,path.join(String(target),'web-data'),{recursive:true});throw Object.assign(Error('killed during removal'),{code:'EKILLED'});}
  return rm.call(fs,target,...rest);};
 try{await expect(launchDefault(f,home,release)).rejects.toMatchObject({code:'EKILLED'});}finally{fs.rm=rm;}
 const controlRoot=path.join(state,'runtime-bundles'),selection=await fs.readFile(path.join(controlRoot,'selection.json'));
 expect(await fs.stat(path.join(state,'fresh-native-source')).catch(error=>error.code)).toBe('ENOENT');
 expect((await fs.readdir(state)).filter(name=>name.startsWith('.fresh-native-source.removing-'))).toHaveLength(1);
 expect(await launchDefault(f,home,release,timedOut)).toBe(controlRoot);
 expect((await fs.readdir(state)).sort()).toEqual(['runtime-bundles']);expect(await fs.readFile(path.join(controlRoot,'selection.json'))).toEqual(selection);
});
test('a concurrent first start waits for a live provisioning holder longer than the default lock timeout',async()=>{
 const f=await fixture(),home=path.join(f.root,'concurrent-home'),release=await releaseArtifacts(f,'A');
 const slow=async request=>{await new Promise(resolve=>setTimeout(resolve,5_500));return f.runMigration(request);};
 const first=launchDefault(f,home,release,slow);
 await new Promise(resolve=>setTimeout(resolve,200));
 const [owner,waiter]=await Promise.all([first,launchDefault(f,home,release,timedOut)]);
 expect(waiter).toBe(owner);expect(readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:owner}).descriptor.bundleID).toBe('default-native');
},60_000);
const bootstrapLock=home=>path.join(home,'.local','state','devryan','runtime-bundles','bootstrap.lock');
const plantLock=async(home,owner)=>{await fs.mkdir(path.dirname(bootstrapLock(home)),{recursive:true,mode:0o700});
 await fs.writeFile(bootstrapLock(home),JSON.stringify({ownerToken:'f'.repeat(32),...owner})+'\n',{mode:0o600});};
// A pid reused after the lock was written: a live process started after its createdAt.
const reusedPid=async()=>{const c=spawn('/bin/sleep',['60']);await new Promise((resolve,reject)=>{c.once('spawn',resolve);c.once('error',reject);});return c;};
test('a bootstrap lock whose pid a later process reused, or whose holder died, is reclaimed at once',async()=>{
 const f=await fixture(),release=await releaseArtifacts(f,'A'),reused=await reusedPid();
 const dead=spawn(process.execPath,['-e','']),deadPid=await new Promise(resolve=>dead.on('close',()=>resolve(dead.pid)));
 try{for(const pid of [reused.pid,deadPid]){
  const home=path.join(f.root,`reclaimed-lock-${pid}`);await plantLock(home,{pid,createdAt:Date.now()-60_000});
  const started=Date.now(),controlRoot=await launchDefault(f,home,release);expect(Date.now()-started).toBeLessThan(30_000);
  expect(readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:controlRoot}).descriptor.bundleID).toBe('default-native');
  expect(await fs.stat(bootstrapLock(home)).catch(error=>error.code)).toBe('ENOENT');
 }}finally{reused.kill();}
},90_000);
test('a live original bootstrap holder is waited for however old its lock reads, even after a system sleep',async()=>{
 const f=await fixture(),release=await releaseArtifacts(f,'A');
 // This process and launchd both started before their locks were written; a sleep only advances the clock.
 for(const [pid,createdAt,clock] of [[process.pid,Date.now(),11*60_000],[1,Date.now()-11*60_000,0]]){
  const home=path.join(f.root,`live-lock-${pid}`);await plantLock(home,{pid,createdAt});
  const now=Date.now,clockJump=vi.spyOn(Date,'now').mockImplementation(()=>now()+clock);
  try{
   let settled=false;const launch=launchDefault(f,home,release).finally(()=>{settled=true;});
   await new Promise(resolve=>setTimeout(resolve,1_500));expect(settled).toBe(false);
   expect(await fs.stat(path.join(draftRoot(home))).catch(error=>error.code)).toBe('ENOENT');
   expect(JSON.parse(await fs.readFile(bootstrapLock(home),'utf8'))).toMatchObject({pid,createdAt});
   await fs.rm(bootstrapLock(home));
   expect(readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:await launch}).descriptor.bundleID).toBe('default-native');
  }finally{clockJump.mockRestore();}
 }
},90_000);
test('five concurrent first starts on a reused-pid bootstrap lock provision exactly once',async()=>{
 const f=await fixture(),release=await releaseArtifacts(f,'A'),home=path.join(f.root,'race-home'),reused=await reusedPid();
 let active=0,overlap=false,calls=0;
 const counted=async request=>{calls++;if(++active>1)overlap=true;try{return await f.runMigration(request);}finally{active--;}};
 try{
  await plantLock(home,{pid:reused.pid,createdAt:Date.now()-60_000});
  const started=Date.now(),roots=await Promise.all(Array.from({length:5},()=>launchDefault(f,home,release,counted)));
  expect(Date.now()-started).toBeLessThan(30_000);expect(new Set(roots).size).toBe(1);expect(overlap).toBe(false);
  expect(readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:roots[0]}).descriptor.bundleID).toBe('default-native');
 }finally{reused.kill();}
 const single=path.join(f.root,'single-home');let singleCalls=0;
 await launchDefault(f,single,release,async request=>{singleCalls++;return f.runMigration(request);});
 expect(calls).toBe(singleCalls);
},120_000);
test('selected default bundle still verifies after its one-shot owner snapshot is consumed',async()=>{
 const f=await fixture(),home=path.join(f.root,'owner-home'),owners={'supabase-local-owner':{id:'10000000-0000-4000-8000-000000000001',scope:'local-admin'}};
 const controlRoot=await launchDefault(f,home,await releaseArtifacts(f,'A'),f.runMigration,async()=>({localOwners:owners}));
 const {restoreNativeSetupOwners}=await import('./native-setup-local-owners.js'),{createSessionVault}=await import('../../multi-user/vault.js');
 const webData=readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:controlRoot}).descriptor.launch.webDataDirectory;
 for(const start of [1,2])await restoreNativeSetupOwners(webData);
 expect((await createSessionVault({dataDirectory:webData})).get('supabase-local-owner').principal).toMatchObject({id:owners['supabase-local-owner'].id,scope:'local-admin'});
 expect(await fs.stat(path.join(webData,'native-setup-local-owners.json')).catch(error=>error.code)).toBe('ENOENT');
 const store=createRuntimeBundleStore({controlRoot,allowRecoveredInputStartup:true,runMigration:async()=>{throw Error('fixture no import');},
  withQuiescedSource:async()=>{throw Error('fixture no checkpoint');},verifyArtifacts:async()=>{}});
 await expect(store.verify({bundleID:'default-native',phase:'resume'})).resolves.toMatchObject({integrity:'verified'});
});
test('fresh default startup refuses to reset a symlinked draft and leaves its target untouched',async()=>{
 const f=await fixture(),home=path.join(f.root,'symlink-home'),outside=path.join(f.root,'outside');
 await fs.mkdir(outside);await fs.writeFile(path.join(outside,'kept.txt'),'kept');
 await fs.mkdir(path.dirname(draftRoot(home)),{recursive:true});await fs.symlink(outside,draftRoot(home));
 await expect(launchDefault(f,home,await releaseArtifacts(f,'A'))).rejects.toMatchObject({code:'bundle_path_invalid'});
 expect(await fs.readFile(path.join(outside,'kept.txt'),'utf8')).toBe('kept');
 await fs.rm(draftRoot(home));await fs.symlink(outside,path.join(path.dirname(draftRoot(home)),'.stale-link'));
 await expect(launchDefault(f,home,await releaseArtifacts(f,'B'))).rejects.toMatchObject({code:'bundle_path_invalid'});
 expect(await fs.readFile(path.join(outside,'kept.txt'),'utf8')).toBe('kept');
});

async function recoveryFixture(reconcileRollback){
 const f=await fixture();await f.store.prepare(f.baselineInput);await f.store.select({bundleID:'baseline',expectedRevision:0});
 const candidate=await f.store.prepare({...f.baselineInput,bundleID:'candidate',source:{kind:'bundle',bundleID:'baseline'}});await f.store.select({bundleID:'candidate',expectedRevision:1});
 const options={controlRoot:f.controlRoot,withQuiescedSource:f.withQuiescedSource,runMigration:f.runMigration,verifyArtifacts:f.verifyArtifacts,captureCredentials,readProcessIdentity:()=>null};
 const store=createRuntimeBundleStore({...options,reconcileRollback});return {...f,candidate,options,store};
}
test('projection exception leaves durable pending B and cold bootstrap cannot open it; local resume CAS bumps B to B',async()=>{
 let projection=0;const f=await recoveryFixture(async({target})=>{projection++;await fs.writeFile(path.join(target.launch.webDataDirectory,'partial-target.txt'),'partial target only');throw Error('simulated projection crash');});
 await expect(f.store.rollback({targetBundleID:'baseline',expectedRevision:2})).rejects.toThrow('simulated projection crash');
 expect(projection).toBe(1);const intent=readRollbackIntentSync(f.controlRoot);expect(intent.state).toBe('pending');expect(intent.revision).toBe(2);
 await expect(f.store.select({bundleID:'baseline',expectedRevision:2})).rejects.toMatchObject({code:'bundle_recovery_resume_required'});
 await expect(f.store.prepare({...f.baselineInput,bundleID:'escape',source:{kind:'bundle',bundleID:'candidate'}})).rejects.toMatchObject({code:'bundle_recovery_resume_required'});
 expect((await f.store.readSelected()).selection).toMatchObject({selectedBundleID:'candidate',revision:2,reconciliationRequired:false});
 const cold=readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:f.controlRoot},{allowHeldInspection:true});expect(cold.admission).toBe('held');expect(cold.rollbackRecovery.reason).toBe('bundle_rollback_pending');
 await expect(f.store.resume({expectedRevision:1})).rejects.toMatchObject({code:'bundle_selection_revision_conflict'});
 const selected=await f.store.resume({expectedRevision:2});expect(selected).toMatchObject({selectedBundleID:'candidate',revision:3,reconciliationRequired:false});
 expect(readRollbackIntentSync(f.controlRoot).state).toBe('resumed');expect(readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:f.controlRoot}).admission).toBe('pending');
 expect(await fs.readFile(path.join(f.controlRoot,'bundles','baseline','web-data','partial-target.txt'),'utf8')).toBe('partial target only');
});
test('resume refuses original live process, modified B, missing receipt and changed credential snapshot without selector writes',async()=>{
 const f=await recoveryFixture(async()=>({status:'blocked',reason:'bundle_credential_conflict'}));await f.store.rollback({targetBundleID:'baseline',expectedRevision:2});
 const before=await fs.readFile(path.join(f.controlRoot,'selection.json'));
 const active=createRuntimeBundleStore({...f.options,readProcessIdentity:pid=>({pid,startIdentity:pid===1000001?'fixture original host':'other process'})});
 await expect(active.resume({expectedRevision:3})).rejects.toMatchObject({code:'bundle_recovery_original_process_active'});
 const changedCredentials=createRuntimeBundleStore({...f.options,captureCredentials:async()=>{const snapshot={...emptyCredentialSnapshot,credentials:[{synthetic:true}]};return {protocol:NATIVE_BUNDLE_CREDENTIAL_CONTRACT,status:'captured',snapshot,sha256:sha256(canonicalJSON(snapshot))};}});
 await expect(changedCredentials.resume({expectedRevision:3})).rejects.toMatchObject({code:'bundle_recovery_candidate_changed'});
 const input=path.join(f.candidate.launch.webDataDirectory,'changed.txt');await fs.writeFile(input,'new B work');
 await expect(f.store.resume({expectedRevision:3})).rejects.toMatchObject({code:'bundle_recovery_candidate_changed'});await fs.rm(input);
 const intent=readRollbackIntentSync(f.controlRoot);await fs.rm(intent.settlement.controller.receipt.path);
 await expect(f.store.resume({expectedRevision:3})).rejects.toMatchObject({code:'bundle_recovery_exit_unverified'});
 expect(await fs.readFile(path.join(f.controlRoot,'selection.json'))).toEqual(before);
});
test('static incompatible A contract never checkpoints, projects or closes B admission',async()=>{
 let projects=0;const f=await recoveryFixture(async input=>{projects++;return reconciledCredentials(input);});
 const source=await f.store.readSelected(),before=f.checkpoints.length;
 const refused=createRuntimeBundleStore({...f.options,verifyArtifacts:async input=>{const result=await f.verifyArtifacts(input);return input.launch.opencodeDatabasePath===source.descriptor.launch.opencodeDatabasePath?result:{manifest:{compiledContracts:['devryan.bundle.credentials/1']}};},reconcileRollback:async()=>{projects++;}});
 await expect(refused.rollback({targetBundleID:'baseline',expectedRevision:2})).rejects.toMatchObject({code:'bundle_credential_contract_incompatible'});
 expect(projects).toBe(0);expect(f.checkpoints).toHaveLength(before);expect(readRollbackIntentSync(f.controlRoot)).toBeNull();expect(readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:f.controlRoot}).admission).toBe('pending');
});
test('verified completion is durable before A CAS and older completed intent does not hold a later valid activation',async()=>{
 const f=await recoveryFixture(reconciledCredentials);const result=await f.store.rollback({targetBundleID:'baseline',expectedRevision:2});
 expect(result.selection).toMatchObject({revision:3,selectedBundleID:'baseline',reconciliationRequired:false});
 const intent=readRollbackIntentSync(f.controlRoot);expect(intent.state).toBe('completed');expect(intent.completion.protocol).toBe(NATIVE_BUNDLE_CREDENTIAL_CONTRACT);
 expect(readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:f.controlRoot}).admission).toBe('pending');
 await f.store.select({bundleID:'candidate',expectedRevision:3});expect(readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:f.controlRoot}).admission).toBe('pending');
});

test('target with only historical native credential contract refuses new clone before checkpoint',async()=>{
 const f=await fixture({compiledContracts:['devryan.bundle.credential-owners/2','devryan.bundle.credentials/1']});await f.store.prepare(f.baselineInput);await f.store.select({bundleID:'baseline',expectedRevision:0});const before=f.checkpoints.length;
 await expect(f.store.prepare({...f.baselineInput,bundleID:'candidate',source:{kind:'bundle',bundleID:'baseline'}})).rejects.toMatchObject({code:'bundle_credential_contract_incompatible'});expect(f.checkpoints).toHaveLength(before);await expect(fs.lstat(path.join(f.controlRoot,'bundles','candidate'))).rejects.toMatchObject({code:'ENOENT'});
});
