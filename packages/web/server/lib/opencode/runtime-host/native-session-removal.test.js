import {afterAll,afterEach,expect,test,vi} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createSessionMutationRuntime} from '../../../../../harness-runtime/lib/session-mutations.js';
import {git} from '../../../../../harness-runtime/lib/session-changes-git.js';
import {initGitRepository} from '../../../../../../scripts/test-git-template.mjs';
import {createNativeAdmissionOwner} from './native-admission-owner.js';
import {createNativeSessionRemoval} from './native-session-removal.js';
import {createManagedTaskScheduler} from '../../../../../orchestration-runtime/scheduler.js';

// These tests commit real Git ledgers; the default unit-test budget can expire
// mid-write on hosted macOS and race cleanup against the still-running commit.
vi.setConfig({testTimeout:60_000,hookTimeout:60_000});

const roots=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});
const execute=promisify(execFile);
// Build once, execute many: the project repository and the ledger holding the registered
// root session are immutable setup. They are built once per file and each test gets a
// copy-on-write clone at the SAME path, so every path recorded in the ledger stays valid.
let template;
// APFS clone on macOS (-c); GNU cp -a elsewhere. Both keep modes and timestamps, which snapshot fingerprints include.
const cloneTree=async(from,to)=>{try{await execute('/bin/cp',['-cpR',from,to]);}catch{await fs.rm(to,{recursive:true,force:true});await execute('cp',['-a',from,to]);}};
async function seededRoot(){
  if(!template){
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'native-removal-')));
    const directory=path.join(root,'project'),storage=path.join(root,'ledger');await fs.mkdir(directory);await initGitRepository(directory);
    await fs.writeFile(path.join(directory,'published.txt'),'published bytes');
    await createSessionMutationRuntime({directory:storage}).registerNativeSession({directory,sessionID:'ses_root'});
    template={root,pristine:`${root}-pristine`,used:false};await cloneTree(root,template.pristine);
  }
  if(template.used){await fs.rm(template.root,{recursive:true,force:true});await cloneTree(template.pristine,template.root);}
  template.used=true;return template.root;
}
afterAll(async()=>{if(template)await Promise.all([template.root,template.pristine].map(directory=>fs.rm(directory,{recursive:true,force:true})));});
async function fixture({discardStreamReceipts,recordDiagnostic,managed=false}={}){
  const root=await seededRoot();roots.push(root);
  const directory=path.join(root,'project'),storage=path.join(root,'ledger');
  const runtime=createSessionMutationRuntime({directory:storage});
  // The idle child intentionally has no existing ledger row.
  const sessions=new Map([['ses_root',{id:'ses_root',parentID:null,directory}],['ses_child',{id:'ses_child',parentID:'ses_root',directory}]]);
  let allowed=true,failLeaf=false,failPreparation=false,failStop=false,addChild=false,claimed=false,claimRefused=false;
  const removed=[],stopped=[],cancellations=[],releasedClaims=[];
  const scheduler=managed?createManagedTaskScheduler({executor:{
    async start(_task,control){await control.setChildSessionId('ses_child');await control.markAccepted();return {status:'completed',summary:'done'};},
    async abort(){throw new Error('Terminal task must not abort its deleted child');},
    async reconcile(){throw new Error('Unexpected recovery');},async readRecoverableResult(){return {};}
  }}):null;
  if(scheduler){const task=await scheduler.submit({idempotencyKey:'managed-child',rootSessionId:'ses_root',parentTaskId:null,directory,mode:'orchestrator',providerId:'openai',modelId:'fixture',agent:'explorer',variant:null,label:'child',prompt:'child',timeoutAt:null});await scheduler.waitForTask(task.taskId,{timeoutMs:1000});}
  const owner=createNativeAdmissionOwner({runtime,directory,ownerID:'owned-bundle',getSession:async id=>sessions.get(id),recordDiagnostic,
    authorizeOperation:async()=>{throw new Error('Generic policy cannot delete');},withSessionLock:async(_id,action)=>action(),
    captureWebAuthorization:async()=>async()=>{if(!allowed)throw Object.assign(new Error('grant_revoked'),{code:'grant_revoked'});}});
  const rpc=(method,input)=>owner.handleRpc(`native.admission.${method}`,input);
  const inspectRemovalOwned=async({sessionID,permit})=>{
    await rpc('authorize',{operation:'removal.inspect',sessionID,existingPermit:permit});
    const ids=new Set([sessionID]);for(let changed=true;changed;){changed=false;for(const row of sessions.values())if(ids.has(row.parentID)&&!ids.has(row.id)){ids.add(row.id);changed=true;}}
    return {members:[...sessions.values()].filter(row=>ids.has(row.id)),states:[...ids].map(id=>({sessionID:id,exists:sessions.has(id),active:false,claimed,
      inboxIDs:sessions.has(id)?[`inbox_${id}`]:[],pendingIDs:sessions.has(id)?[`pending_${id}`]:[]}))};
  };
  const coordinator=createNativeSessionRemoval({runtime,admissionOwner:owner,ownerID:'owned-bundle',inspectRemovalOwned,discardStreamReceipts,recordDiagnostic,
    removeLeafOwned:async({intentID,sessionID,permit})=>{
      await rpc('authorize',{operation:'removal.delete',sessionID,input:{intentID},existingPermit:permit});
      if(sessions.has(sessionID)){sessions.delete(sessionID);removed.push(sessionID);}
      if(failLeaf){failLeaf=false;throw new Error('lost delete acknowledgement');}
      return {removed:true,sessionID};
    },
    releaseClaimOwned:async({sessionID,permit})=>{
      await rpc('authorize',{operation:'removal.release-claim',sessionID,existingPermit:permit});
      if(claimRefused)throw Object.assign(new Error('native_removal_settlement_uncertain'),{code:'native_removal_settlement_uncertain',status:409});
      const released=claimed;claimed=false;if(released)releasedClaims.push(sessionID);
      return {released,sessionID};
    },
    cancelAndWait:async({sessions:ids})=>{
      if(failStop){failStop=false;throw new Error('Native stop unavailable');}
      expect(ids.every(id=>sessions.has(id))).toBe(true);stopped.push([...ids]);
      return {terminated:true,sessions:ids};
    },
    cancelManaged:async input=>{
      const {verifyRemovedSession:_verifyRemovedSession,...record}=input;
      cancellations.push(structuredClone(record));
      if(scheduler)return scheduler.cancelSessionsForRemoval(input);
      if(input.phase==='fence'){
        if(addChild){addChild=false;sessions.set('ses_racing',{id:'ses_racing',parentID:'ses_root',directory});}
        return {fenced:true,sessions:input.sessions};
      }
      if(failPreparation){failPreparation=false;allowed=false;}
      return {settled:true,sessions:input.sessions};
    }});
  const removeSession=sessionID=>owner.withWebOperation({operation:'sessions.remove',method:'DELETE',path:`/api/session/${sessionID}`,directory},()=>coordinator.remove({sessionID,directory}));
  const remove=()=>removeSession('ses_root');
  return {directory,runtime,owner,coordinator,remove,removeSession,scheduler,sessions,removed,stopped,cancellations,releasedClaims,
    setAllowed:value=>{allowed=value;},setClaimed:value=>{claimed=value;},refuseClaimRelease:value=>{claimRefused=value;},failLeaf:()=>{failLeaf=true;},revokeDuringPreparation:()=>{failPreparation=true;},addRacingChild:()=>{addChild=true;},
    failStop:()=>{failStop=true;},
    reopen:()=>createSessionMutationRuntime({directory:storage})};
}

test('real managed settlement permits child-first archived deletion followed by its parent',async()=>{
  const f=await fixture({managed:true});
  try{
    await expect(f.removeSession('ses_child')).resolves.toBe(true);
    await expect(f.remove()).resolves.toBe(true);
    expect(f.removed).toEqual(['ses_child','ses_root']);
    expect(await f.reopen().nativeRemovals({directory:f.directory})).toEqual([]);
  }finally{await f.scheduler.shutdown();}
});

test('an interrupted child deletion stays fenced until its committed decision recovers, then parent retry succeeds',async()=>{
  const f=await fixture({managed:true});
  try{
    f.failLeaf();
    await expect(f.removeSession('ses_child')).rejects.toThrow('lost delete acknowledgement');
    await expect(f.remove()).rejects.toMatchObject({code:'native_removal_in_progress',status:409});
    const pending=await f.runtime.nativeRemovals({directory:f.directory});
    expect(pending.map(row=>row.state)).toEqual(['committed']);
    await f.coordinator.recover({directory:f.directory});
    await expect(f.remove()).resolves.toBe(true);
    expect(f.removed).toEqual(['ses_child','ses_root']);
    expect(await f.reopen().nativeRemovals({directory:f.directory})).toEqual([]);
  }finally{await f.scheduler.shutdown();}
});

test('a missing historical managed child without durable disposal proof still refuses parent deletion',async()=>{
  const f=await fixture({managed:true});
  try{
    f.sessions.delete('ses_child');
    await expect(f.remove()).rejects.toMatchObject({code:'native_removal_scope_invalid',statusCode:409});
    expect(f.removed).toEqual([]);
    expect((await f.runtime.nativeRemovals({directory:f.directory}))[0].state).toBe('preparing');
  }finally{await f.scheduler.shutdown();}
});

test('an ancestor cannot add overlapping holds while a descendant deletion is preparing',async()=>{
  const f=await fixture({managed:true});
  try{
    f.failStop();
    await expect(f.removeSession('ses_child')).rejects.toThrow('Native stop unavailable');
    await expect(f.remove()).rejects.toMatchObject({code:'native_removal_in_progress',status:409});
    expect(await f.runtime.nativeRemovals({directory:f.directory})).toHaveLength(1);
    await expect(f.removeSession('ses_child')).resolves.toBe(true);
    await expect(f.remove()).resolves.toBe(true);
    expect(f.removed).toEqual(['ses_child','ses_root']);
    expect(await f.reopen().nativeRemovals({directory:f.directory})).toEqual([]);
  }finally{await f.scheduler.shutdown();}
});

test('exact held subtree deletion registers idle children, disposes pending IDs and preserves published files',async()=>{
  const f=await fixture();await expect(f.remove()).resolves.toBe(true);
  expect(f.removed).toEqual(['ses_child','ses_root']);
  expect(await fs.readFile(path.join(f.directory,'published.txt'),'utf8')).toBe('published bytes');
  expect(await f.reopen().nativeRemovals({directory:f.directory})).toEqual([]);
  await expect(f.runtime.assertAdmission({directory:f.directory,sessionID:'ses_child'})).rejects.toMatchObject({code:'native_session_held'});
  expect((await f.runtime.nativeAdmissionState({directory:f.directory,sessionID:'ses_child'})).held).toBe(true);
});

test('stream proof cleanup follows acknowledged leaf deletion and remains retryable under the committed removal decision',async()=>{
 let calls=0;
 const f=await fixture({discardStreamReceipts:async intent=>{
  expect(intent.state).toBe('committed');expect(intent.removed.length).toBe(intent.members.length);
  expect(f.sessions.size).toBe(0);calls++;
  if(calls===1)throw Error('Proof cleanup unavailable');
 }});
 await expect(f.remove()).rejects.toThrow('Proof cleanup unavailable');
 expect((await f.reopen().nativeRemovals({directory:f.directory}))[0].state).toBe('committed');
 await f.coordinator.recover({directory:f.directory});expect(calls).toBe(2);
 expect(await f.reopen().nativeRemovals({directory:f.directory})).toEqual([]);
});

test('lost native leaf acknowledgement recovers only sealed IDs after controller invalidation',async()=>{
  const f=await fixture();f.failLeaf();await expect(f.remove()).rejects.toThrow('lost delete acknowledgement');
  const [intent]=await f.reopen().nativeRemovals({directory:f.directory});
  expect(intent.state).toBe('committed');expect(intent.removed).toEqual([]);
  expect(intent.dispositions).toEqual([{sessionID:'ses_child',inboxIDs:['inbox_ses_child'],pendingIDs:['pending_ses_child']}]);
  await f.owner.invalidateController();await f.coordinator.recover({directory:f.directory});
  expect(f.removed).toEqual(['ses_child','ses_root']);
  expect(f.stopped.at(-1)).toEqual(['ses_root']);
  expect(f.cancellations.at(-1)).toMatchObject({phase:'settle',sessions:['ses_root','ses_child'],absentSessions:['ses_child'],settled:{terminated:true,sessions:['ses_root']}});
  expect(await f.reopen().nativeRemovals({directory:f.directory})).toEqual([]);
});

test('tree changes and revoked preparation remain held, recover only fences, and require fresh authorized retry',async()=>{
  const f=await fixture();f.addRacingChild();await expect(f.remove()).rejects.toMatchObject({code:'native_removal_tree_changed'});
  expect(f.removed).toEqual([]);const count=f.stopped.length;
  await f.coordinator.recover({directory:f.directory});expect(f.stopped.length).toBe(count);
  f.revokeDuringPreparation();await expect(f.remove()).rejects.toMatchObject({code:'grant_revoked'});
  expect(f.removed).toEqual([]);f.setAllowed(true);await expect(f.remove()).resolves.toBe(true);
  expect(new Set(f.removed)).toEqual(new Set(['ses_root','ses_child','ses_racing']));
});

test('raw removal and foreign holds never acquire the private terminal capability',async()=>{
  const f=await fixture();await expect(f.owner.handleRpc('native.admission.authorize',{operation:'session.remove',sessionID:'ses_root'}))
    .rejects.toMatchObject({code:'native_owned_lifecycle_required'});
  await f.runtime.holdNativeAdmission({directory:f.directory,sessionID:'ses_root',ownerID:'foreign-owner'});
  await expect(f.remove()).rejects.toMatchObject({code:'native_session_held'});
  expect(f.removed).toEqual([]);
});

test('a final durable ACK followed by failed completion recovers with zero live cancellation',async()=>{
  const f=await fixture(),complete=f.runtime.completeNativeRemoval;
  let fail=true;f.runtime.completeNativeRemoval=async input=>{if(fail){fail=false;throw new Error('completion interrupted');}return complete(input);};
  await expect(f.remove()).rejects.toThrow('completion interrupted');expect(f.sessions.size).toBe(0);
  const before=f.stopped.length;await f.owner.invalidateController();await f.coordinator.recover({directory:f.directory});
  expect(f.stopped.length).toBe(before);
  expect(f.cancellations.at(-1)).toMatchObject({phase:'settle',settled:null,absentSessions:['ses_root','ses_child']});
});


test('final authorization runs inside the ledger commit after queued reads and leaves a revoked decision preparing',async()=>{
  const f=await fixture(),commit=f.runtime.commitNativeRemoval;
  f.runtime.commitNativeRemoval=async input=>{f.setAllowed(false);return commit(input);};
  await expect(f.remove()).rejects.toMatchObject({code:'grant_revoked'});
  const [intent]=await f.reopen().nativeRemovals({directory:f.directory});
  expect(intent.state).toBe('preparing');expect(f.removed).toEqual([]);
  f.runtime.commitNativeRemoval=commit;f.setAllowed(true);await expect(f.remove()).resolves.toBe(true);
});

test('an absent native row with a surviving claim cannot be treated as settled after a lost ACK',async()=>{
  const f=await fixture();f.failLeaf();await expect(f.remove()).rejects.toThrow('lost delete acknowledgement');
  const inspect=async({sessionID,permit})=>{
    await f.owner.handleRpc('native.admission.authorize',{operation:'removal.inspect',sessionID,existingPermit:permit});
    return {members:[...f.sessions.values()].filter(row=>sessionID==='ses_root' || row.id===sessionID),
      states:[{sessionID,exists:f.sessions.has(sessionID),active:sessionID==='ses_child',claimed:false,inboxIDs:[],pendingIDs:[]}]};
  };
  const recovering=createNativeSessionRemoval({runtime:f.runtime,admissionOwner:f.owner,ownerID:'owned-bundle',inspectRemovalOwned:inspect,
    removeLeafOwned:async()=>{throw new Error('must not delete');},cancelManaged:async()=>{throw new Error('must not settle');},
    cancelAndWait:async()=>{throw new Error('must not manufacture settlement');}});
  await expect(recovering.recover({directory:f.directory})).rejects.toMatchObject({code:'native_removal_settlement_uncertain'});
  expect((await f.reopen().nativeRemovals({directory:f.directory}))[0].state).toBe('committed');
});

async function inheritedRemoval(f, state='preparing') {
  const {createHash}=await import('node:crypto');
  let intent=await f.runtime.beginNativeRemoval({directory:f.directory,rootSessionID:'ses_root',ownerID:'previous-bundle'});
  if(state==='committed')intent=await f.runtime.commitNativeRemoval({directory:f.directory,intentID:intent.id,ownerID:'previous-bundle',members:[{id:'ses_root',parentID:null,directory:f.directory}]});
  const gitDir=path.join(path.dirname(f.directory),'ledger',createHash('sha256').update(f.directory).digest('hex'),'git');
  const checkpointID='verified-checkpoint';
  const sourceOID=(await git(f.directory,['--git-dir',gitDir,'rev-parse','refs/devryan/state'])).toString().trim();
  await git(f.directory,['--git-dir',gitDir,'update-ref',`refs/devryan/migration/${checkpointID}/state`,sourceOID]);
  return {intent,proof:{directory:f.directory,ownerID:'owned-bundle',checkpointID,sourceOID}};
}

test('verified inherited preparation retains its hold and needs a fresh authorized retry',async()=>{
  const f=await fixture(),{intent,proof}=await inheritedRemoval(f);
  await expect(f.remove()).rejects.toMatchObject({code:'native_session_held'});
  const before=await f.runtime.nativeAdmissionState({directory:f.directory,sessionID:'ses_root'});
  expect(await f.runtime.recoverNativeRemovalOwnership(proof)).toBe(1);
  expect(await f.runtime.nativeAdmissionState({directory:f.directory,sessionID:'ses_root'})).toEqual(before);
  expect(await f.runtime.recoverNativeRemovalOwnership(proof)).toBe(0);
  await f.coordinator.recover({directory:f.directory});expect(f.removed).toEqual([]);
  f.setAllowed(false);await expect(f.remove()).rejects.toMatchObject({code:'grant_revoked'});
  expect((await f.runtime.nativeRemoval({directory:f.directory,intentID:intent.id})).state).toBe('preparing');
  f.setAllowed(true);await expect(f.remove()).resolves.toBe(true);
  expect(f.removed).toEqual(['ses_child','ses_root']);
});

test('inheritance rejects changed checkpoint evidence and unrelated holds without transferring ownership',async()=>{
  const f=await fixture(),{intent,proof}=await inheritedRemoval(f);
  await expect(f.runtime.recoverNativeRemovalOwnership({...proof,sourceOID:'0'.repeat(40)})).rejects.toMatchObject({code:'native_removal_inheritance_invalid'});
  await f.runtime.holdNativeAdmission({directory:f.directory,sessionID:'ses_root',ownerID:'foreign-owner'});
  await expect(f.runtime.recoverNativeRemovalOwnership(proof)).rejects.toMatchObject({code:'native_removal_inheritance_invalid'});
  expect((await f.runtime.nativeRemoval({directory:f.directory,intentID:intent.id})).ownerID).toBe('previous-bundle');
});

test('inheritance releases a settled previous controller admission hold beside the removal hold',async()=>{
  const f=await fixture(),{intent,proof}=await inheritedRemoval(f);
  await f.runtime.holdNativeAdmission({directory:f.directory,sessionID:'ses_root',ownerID:'previous-bundle'});
  expect(await f.runtime.recoverNativeRemovalOwnership(proof)).toBe(1);
  const state=await f.runtime.nativeAdmissionState({directory:f.directory,sessionID:'ses_root'});
  expect(state.holds).toEqual([expect.objectContaining({removalID:intent.id,ownerID:`native-removal:${intent.id}`})]);
  expect((await f.runtime.nativeRemoval({directory:f.directory,intentID:intent.id})).ownerID).toBe('owned-bundle');
  await expect(f.remove()).resolves.toBe(true);
  expect(f.removed).toEqual(['ses_child','ses_root']);
});

test('inheritance releases the clone source admission hold only when the source is named',async()=>{
  const f=await fixture(),{intent,proof}=await inheritedRemoval(f);
  await f.runtime.holdNativeAdmission({directory:f.directory,sessionID:'ses_root',ownerID:'source-bundle'});
  await expect(f.runtime.recoverNativeRemovalOwnership(proof)).rejects.toMatchObject({code:'native_removal_inheritance_invalid'});
  expect(await f.runtime.recoverNativeRemovalOwnership({...proof,sourceOwnerID:'source-bundle'})).toBe(1);
  expect((await f.runtime.nativeAdmissionState({directory:f.directory,sessionID:'ses_root'})).holds)
    .toEqual([expect.objectContaining({removalID:intent.id})]);
});

test('inherited committed removal keeps its durable decision and recovers only its recorded tree',async()=>{
  const f=await fixture();f.sessions.delete('ses_child');
  const {intent,proof}=await inheritedRemoval(f,'committed');
  await f.runtime.recoverNativeRemovalOwnership(proof);
  expect((await f.runtime.nativeRemoval({directory:f.directory,intentID:intent.id})).state).toBe('committed');
  await f.coordinator.recover({directory:f.directory});expect(f.removed).toEqual(['ses_root']);
  expect(await fs.readFile(path.join(f.directory,'published.txt'),'utf8')).toBe('published bytes');
});


test('concurrent deletes refuse duplicate work and journal finite outcomes',async()=>{
 const records=[];const f=await fixture({recordDiagnostic:row=>records.push(row)});
 const [first,second]=await Promise.allSettled([f.remove(),f.remove()]);
 expect([first,second].filter(result=>result.status==='fulfilled')).toHaveLength(1);
 expect([first,second].filter(result=>result.status==='rejected')).toHaveLength(1);
 expect(f.removed).toEqual(['ses_child','ses_root']);
 expect(records).toContainEqual(expect.objectContaining({event:'session_removal',sessionID:'ses_root',payload:expect.objectContaining({outcome:'completed',intentID:expect.any(String)})}));
});

test('changed inherited preparation cannot be adopted from an older snapshot',async()=>{
 const f=await fixture(),{intent,proof}=await inheritedRemoval(f);
 await f.runtime.prepareNativeRemovalMembers({directory:f.directory,intentID:intent.id,ownerID:'previous-bundle',members:[
  {id:'ses_root',parentID:null,directory:f.directory},{id:'ses_child',parentID:'ses_root',directory:f.directory}]});
 await expect(f.runtime.recoverNativeRemovalOwnership(proof)).rejects.toMatchObject({code:'native_removal_inheritance_invalid'});
 expect((await f.runtime.nativeRemoval({directory:f.directory,intentID:intent.id})).ownerID).toBe('previous-bundle');
});


test('authorization failure journals its code without the exception text',async()=>{
 const records=[],f=await fixture({recordDiagnostic:row=>records.push(row)});f.setAllowed(false);
 await expect(f.remove()).rejects.toMatchObject({code:'grant_revoked'});
 expect(records).toContainEqual({type:'lifecycle',event:'session_removal',sessionID:'ses_root',payload:{stage:'web_authorization',outcome:'failed',code:'grant_revoked'}});
 expect(f.removed).toEqual([]);
});


test('an unresolved native claim stays fenced and is never disposed as idle recovered input',async()=>{
 const f=await fixture();f.setClaimed(true);f.refuseClaimRelease(true);
 await expect(f.remove()).rejects.toMatchObject({code:'native_removal_settlement_uncertain'});
 expect(f.removed).toEqual([]);
 expect((await f.runtime.nativeRemovals({directory:f.directory}))[0].state).toBe('preparing');
});

test('a settled stale claim is released so an archived subagent child and then its parent are removed',async()=>{
 const f=await fixture();f.setClaimed(true);
 await expect(f.removeSession('ses_child')).resolves.toBe(true);
 expect(f.releasedClaims).toEqual(['ses_child']);
 expect(f.stopped[0]).toEqual(['ses_child']);
 await expect(f.remove()).resolves.toBe(true);
 expect(f.removed).toEqual(['ses_child','ses_root']);
 expect(await f.reopen().nativeRemovals({directory:f.directory})).toEqual([]);
});

test('a removal stranded in preparation by a stale claim completes on retry and unblocks its parent',async()=>{
 const f=await fixture();f.setClaimed(true);f.refuseClaimRelease(true);
 await expect(f.removeSession('ses_child')).rejects.toMatchObject({code:'native_removal_settlement_uncertain'});
 await expect(f.remove()).rejects.toMatchObject({code:'native_removal_in_progress'});
 f.refuseClaimRelease(false);
 await expect(f.removeSession('ses_child')).resolves.toBe(true);
 await expect(f.remove()).resolves.toBe(true);
 expect(f.removed).toEqual(['ses_child','ses_root']);
 expect(await f.reopen().nativeRemovals({directory:f.directory})).toEqual([]);
});
