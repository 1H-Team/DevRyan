import {afterEach,expect,test} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createSessionMutationRuntime} from '../../../../../harness-runtime/lib/session-mutations.js';
import {git} from '../../../../../harness-runtime/lib/session-changes-git.js';
import {createNativeAdmissionOwner} from './native-admission-owner.js';
import {createNativeSessionRemoval} from './native-session-removal.js';

const roots=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});
async function fixture(){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'native-removal-')));roots.push(root);
  const directory=path.join(root,'project'),storage=path.join(root,'ledger');await fs.mkdir(directory);await git(directory,['init','--quiet']);
  await fs.writeFile(path.join(directory,'published.txt'),'published bytes');
  const runtime=createSessionMutationRuntime({directory:storage});
  await runtime.registerNativeSession({directory,sessionID:'ses_root'});
  // The idle child intentionally has no existing ledger row.
  const sessions=new Map([['ses_root',{id:'ses_root',parentID:null,directory}],['ses_child',{id:'ses_child',parentID:'ses_root',directory}]]);
  let allowed=true,failLeaf=false,failPreparation=false,addChild=false;
  const removed=[],stopped=[],cancellations=[];
  const owner=createNativeAdmissionOwner({runtime,directory,ownerID:'owned-bundle',getSession:async id=>sessions.get(id),
    authorizeOperation:async()=>{throw new Error('Generic policy cannot delete');},withSessionLock:async(_id,action)=>action(),
    captureWebAuthorization:async()=>async()=>{if(!allowed)throw Object.assign(new Error('grant_revoked'),{code:'grant_revoked'});}});
  const rpc=(method,input)=>owner.handleRpc(`native.admission.${method}`,input);
  const inspectRemovalOwned=async({sessionID,permit})=>{
    await rpc('authorize',{operation:'removal.inspect',sessionID,existingPermit:permit});
    const ids=new Set([sessionID]);for(let changed=true;changed;){changed=false;for(const row of sessions.values())if(ids.has(row.parentID)&&!ids.has(row.id)){ids.add(row.id);changed=true;}}
    return {members:[...sessions.values()].filter(row=>ids.has(row.id)),states:[...ids].map(id=>({sessionID:id,exists:sessions.has(id),active:false,claimed:false,
      inboxIDs:sessions.has(id)?[`inbox_${id}`]:[],pendingIDs:sessions.has(id)?[`pending_${id}`]:[]}))};
  };
  const coordinator=createNativeSessionRemoval({runtime,admissionOwner:owner,ownerID:'owned-bundle',inspectRemovalOwned,
    removeLeafOwned:async({intentID,sessionID,permit})=>{
      await rpc('authorize',{operation:'removal.delete',sessionID,input:{intentID},existingPermit:permit});
      if(sessions.has(sessionID)){sessions.delete(sessionID);removed.push(sessionID);}
      if(failLeaf){failLeaf=false;throw new Error('lost delete acknowledgement');}
      return {removed:true,sessionID};
    },
    cancelAndWait:async({sessions:ids})=>{
      expect(ids.every(id=>sessions.has(id))).toBe(true);stopped.push([...ids]);
      return {terminated:true,sessions:ids};
    },
    cancelManaged:async input=>{
      cancellations.push(structuredClone(input));
      if(input.phase==='fence'){
        if(addChild){addChild=false;sessions.set('ses_racing',{id:'ses_racing',parentID:'ses_root',directory});}
        return {fenced:true,sessions:input.sessions};
      }
      if(failPreparation){failPreparation=false;allowed=false;}
      return {settled:true,sessions:input.sessions};
    }});
  const remove=()=>owner.withWebOperation({operation:'sessions.remove',method:'DELETE',path:'/api/session/ses_root',directory},()=>coordinator.remove({sessionID:'ses_root',directory}));
  return {directory,runtime,owner,coordinator,remove,sessions,removed,stopped,cancellations,
    setAllowed:value=>{allowed=value;},failLeaf:()=>{failLeaf=true;},revokeDuringPreparation:()=>{failPreparation=true;},addRacingChild:()=>{addChild=true;},
    reopen:()=>createSessionMutationRuntime({directory:storage})};
}

test('exact held subtree deletion registers idle children, disposes pending IDs and preserves published files',async()=>{
  const f=await fixture();await expect(f.remove()).resolves.toBe(true);
  expect(f.removed).toEqual(['ses_child','ses_root']);
  expect(await fs.readFile(path.join(f.directory,'published.txt'),'utf8')).toBe('published bytes');
  expect(await f.reopen().nativeRemovals({directory:f.directory})).toEqual([]);
  await expect(f.runtime.assertAdmission({directory:f.directory,sessionID:'ses_child'})).rejects.toMatchObject({code:'native_session_held'});
  expect((await f.runtime.nativeAdmissionState({directory:f.directory,sessionID:'ses_child'})).held).toBe(true);
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
