import fs from 'node:fs/promises';
import path from 'node:path';
import {afterEach,expect,test} from 'vitest';
import {parseRollbackIntent,rollbackIntentUnresolved,captureRollbackFiles,captureRollbackRegistries,assertPrivateBundleControlRoot,saveRollbackIntent,readRollbackIntentSync} from './bundle-rollback-intent.js';
import {NATIVE_BUNDLE_CREDENTIAL_CONTRACT} from './native-bundle-credential-contract.js';
const roots=[];afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
const digest='a'.repeat(64);
const proof=()=>({protocol:'devryan.bundle.rollback-intent/1',state:'pending',revision:2,candidateBundleID:'B',targetBundleID:'A',candidateDescriptorSha256:digest,candidatePreparedSha256:digest,candidateManifestSha256:digest,targetDescriptorSha256:digest,targetPreparedSha256:digest,targetManifestSha256:digest,expectedTargetCredentialSha256:digest,nativeCredentialSha256:digest,hostOwners:{protocol:'devryan.bundle.credential-owners/2',sha256:digest,accountDirectories:{}},files:[{path:'opencode/opencode.db',sha256:digest}],checkpoint:{checkpointID:'checkpoint',ownerID:'B',generation:2,databasePath:'/owned/B/opencode/opencode.db',webDataDirectory:'/owned/B/web-data',webConfigDirectory:'/owned/B/config/openchamber',opencodeConfigDirectory:'/owned/B/config/opencode',settledAt:1},settlement:{host:{pid:12,startIdentity:'original host'},controller:{pid:13,startIdentity:'original controller',instanceID:'00000000-0000-4000-8000-000000000001',code:0,signal:null,receipt:{path:'/owned/B/.native-controller/00000000-0000-4000-8000-000000000001/termination.json',terminated:true,confined:true,cancelled:false,exitCode:0},receiptSha256:digest},credentialDrained:true,storesDrained:true,registries:[{name:'managed-opencode-processes.json',sha256:null},{name:'managed-native-provider-processes.json',sha256:null}]}});
const selected=(id,revision=2)=>({selectedBundleID:id,revision,preparedManifestSha256:digest,reconciliationRequired:false});
test('durable intent crash boundaries remain held until the exact completed or resumed selector commit',()=>{
 const intent=proof();expect(rollbackIntentUnresolved(intent,selected('B'))).toBe(true);
 const completion={protocol:NATIVE_BUNDLE_CREDENTIAL_CONTRACT,status:'projected',sourceBundleID:'B',targetBundleID:'A',targetManifestSha256:digest,sourceSha256:digest,appliedSha256:digest,expectedTargetSha256:digest};
 const completed=parseRollbackIntent({...intent,state:'completed',completion});
 expect(rollbackIntentUnresolved(completed,selected('B'))).toBe(true);
 expect(rollbackIntentUnresolved(completed,{...selected('A',3),reconciliationRequired:true})).toBe(true);
 expect(rollbackIntentUnresolved(completed,selected('A',3))).toBe(false);
 expect(rollbackIntentUnresolved(completed,{...selected('A',3),preparedManifestSha256:'b'.repeat(64)})).toBe(true);
 const resuming=parseRollbackIntent({...intent,state:'resuming',resumeRevision:3});
 expect(rollbackIntentUnresolved(resuming,selected('B'))).toBe(true);expect(rollbackIntentUnresolved(resuming,selected('B',3))).toBe(false);
 expect(rollbackIntentUnresolved({...resuming,state:'resumed'},selected('A',4))).toBe(false);
});
test('missing drains, unsuccessful receipt, foreign checkpoint, malformed files and extra authority fields refuse',()=>{
 for(const mutate of [p=>delete p.settlement,p=>p.settlement.credentialDrained=false,p=>p.settlement.storesDrained=false,p=>p.settlement.controller.receipt.cancelled=true,p=>p.settlement.controller.code=1,p=>p.checkpoint.ownerID='A',p=>p.files[0].path='../A/database',p=>p.settlement.controller.receipt.extra='foreign',p=>p.callerAck=true]){const intent=proof();mutate(intent);expect(()=>parseRollbackIntent(intent)).toThrow('bundle_rollback_proof_invalid');}
});
test('bounded closed inventory preserves main DB/WAL and credential bytes, excludes only transient controller/scratch/WAL-index sources',async()=>{
 const root=await fs.mkdtemp(path.resolve('../../.cache/v2-validation/rollback-proof-'));roots.push(root);
 for(const [name,value] of Object.entries({'opencode/opencode.db':'db','opencode/opencode.db-wal':'wal','opencode/opencode.db-shm':'index','web-data/quota/cursor-acp.json':'credentials','global/log/log.txt':'transient','.native-controller/id/termination.json':'controller','global/home/.claude/.credentials.json':'account'})){const file=path.join(root,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,value);}
 const before=await captureRollbackFiles(root);expect(before.map(row=>row.path)).toEqual(['global/home/.claude/.credentials.json','opencode/opencode.db','opencode/opencode.db-wal','web-data/quota/cursor-acp.json']);
 await fs.writeFile(path.join(root,'opencode/opencode.db-shm'),'different index');expect(await captureRollbackFiles(root)).toEqual(before);
 await fs.writeFile(path.join(root,'opencode/opencode.db-wal'),'different durable WAL');expect(await captureRollbackFiles(root)).not.toEqual(before);
 await fs.symlink(path.join(root,'opencode/opencode.db'),path.join(root,'foreign'));await expect(captureRollbackFiles(root)).rejects.toMatchObject({code:'bundle_recovery_inventory_invalid'});
});
test('original registry publication is retained; any live child or malformed registry refuses closure proof',async()=>{
 const root=await fs.mkdtemp(path.resolve('../../.cache/v2-validation/rollback-registry-'));roots.push(root);
 expect((await captureRollbackRegistries(root)).every(row=>row.sha256===null)).toBe(true);
 const file=path.join(root,'managed-opencode-processes.json');await fs.writeFile(file,JSON.stringify({version:2,processes:[{childPid:10}]}));await expect(captureRollbackRegistries(root)).rejects.toMatchObject({code:'bundle_recovery_exit_unverified'});
 await fs.writeFile(file,JSON.stringify({version:2,processes:[]}));expect((await captureRollbackRegistries(root))[0].sha256).toMatch(/^[a-f0-9]{64}$/);
});
test('local authority requires same-UID private canonical control files and preserves corrupt proof as held failure',async()=>{
 const root=await fs.mkdtemp(path.resolve('../../.cache/v2-validation/rollback-authority-'));roots.push(root);
 await fs.chmod(root,0o700);await fs.writeFile(path.join(root,'selection.json'),'{}',{mode:0o600});await saveRollbackIntent(root,proof());
 await expect(assertPrivateBundleControlRoot(root)).resolves.toBeUndefined();expect(readRollbackIntentSync(root).candidateBundleID).toBe('B');
 await expect(assertPrivateBundleControlRoot(root,(process.getuid?.()??0)+1)).rejects.toMatchObject({code:'bundle_recovery_owner_required'});
 await fs.chmod(path.join(root,'selection.json'),0o644);await expect(assertPrivateBundleControlRoot(root)).rejects.toMatchObject({code:'bundle_recovery_owner_required'});
 await fs.writeFile(path.join(root,'rollback/intent.json'),'{}');expect(()=>readRollbackIntentSync(root)).toThrow('bundle_rollback_proof_invalid');
});
