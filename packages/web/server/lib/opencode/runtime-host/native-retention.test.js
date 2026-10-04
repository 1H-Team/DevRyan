import {afterEach,expect,test} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {git} from '../../../../../harness-runtime/lib/session-changes-git.js';
import {createSessionMutationRuntime} from '../../../../../harness-runtime/lib/session-mutations.js';
import {createNativeAdmissionOwner} from './native-admission-owner.js';
import {createNativeSessionRemoval} from './native-session-removal.js';
import {createNativeRetention} from './native-retention.js';
const roots=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});
async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'quiet-retention-'));roots.push(root);const directory=path.join(root,'project');await fs.mkdir(directory);await git(directory,['init','--quiet']);await fs.writeFile(path.join(directory,'published.txt'),'published');
 const runtime=createSessionMutationRuntime({directory:path.join(root,'ledger')});
 const members=[{id:'ses_root',parentID:null,directory,time:{created:1,updated:1}},{id:'ses_child',parentID:'ses_root',directory,time:{created:1,updated:1}}];
 const sessions=new Map(members.map(row=>[row.id,row]));let epoch='epoch-a',allowed=true,failAfterTransfer=false;
 const owner=createNativeAdmissionOwner({runtime,directory,ownerID:'bundle',getInstanceID:()=>epoch,getSession:async id=>sessions.get(id),authorizeOperation:async()=>{throw Error('no generic authority');},withSessionLock:async(_id,fn)=>fn()});
 const rpc=(key,input)=>owner.handleRpc(`native.admission.${key}`,input);
 const states=ids=>ids.map(id=>({sessionID:id,exists:sessions.has(id),active:false,claimed:false,inboxIDs:[],pendingIDs:[]}));
 const removal=createNativeSessionRemoval({runtime,admissionOwner:owner,ownerID:'bundle',cancelManaged:async()=>{throw Error('must not cancel managed work');},cancelAndWait:async()=>{throw Error('must not stop work');},
  inspectRemovalOwned:async({sessionID,permit})=>{await rpc('authorize',{operation:'removal.inspect',sessionID,existingPermit:permit});if(failAfterTransfer){failAfterTransfer=false;throw Error('preparation failed');}const rows=[...sessions.values()].filter(row=>sessionID==='ses_root'||row.id===sessionID);return {members:rows.map(({id,parentID,directory})=>({id,parentID,directory})),states:states(rows.length?rows.map(row=>row.id):[sessionID])};},
  removeLeafOwned:async({sessionID,intentID,permit})=>{await rpc('authorize',{operation:'removal.delete',sessionID,input:{intentID},existingPermit:permit});sessions.delete(sessionID);return {removed:true,sessionID};}});
 const retention=createNativeRetention({admissionOwner:owner,ownerID:'bundle',runtime,removal,controller:()=>({call:async request=>{
  if(request.action==='acquire-retention-owned'){await rpc('retentionAcquire',{permit:request.permit,members});return {held:true,members};}
  await rpc('authorize',{operation:'retention.archive',sessionID:request.sessionID,input:{at:request.at},existingPermit:request.permit});await rpc('retentionRecheck',{permit:request.permit,members});return {archived:true,members};
 }})});
 const run=action=>retention.run({directory,sessionID:'ses_root',action,at:100,members,authorize:async()=>{if(!allowed)throw Object.assign(Error('revoked'),{code:'revoked'});}});
 return {directory,runtime,members,sessions,owner,retention,run,deny:()=>{allowed=false;},fail:()=>{failAfterTransfer=true;},replace:async()=>{epoch='epoch-b';await owner.invalidateController();}};
}
test('quiet delete transfers existing hold, removes tree without cancellation, preserves workspace',async()=>{
 const f=await fixture();expect(await f.run('delete')).toBe(true);expect(f.sessions.size).toBe(0);expect(await fs.readFile(path.join(f.directory,'published.txt'),'utf8')).toBe('published');expect(await f.runtime.nativeRemovals({directory:f.directory})).toEqual([]);
});
test('quiet archive releases its exact hold, rejected scope/policy never creates work',async()=>{
 const f=await fixture();expect(await f.run('archive')).toBe(true);expect((await f.runtime.nativeAdmissionState({directory:f.directory,sessionID:'ses_root'})).held).toBe(false);
 f.deny();await expect(f.run('archive')).rejects.toMatchObject({code:'revoked'});expect(f.sessions.size).toBe(2);
 await expect(f.owner.handleRpc('native.admission.authorize',{operation:'retention.acquire',sessionID:'ses_root'})).rejects.toMatchObject({code:'native_retention_capability_required'});
});
test('preparing quiet removal failure abandons decision; crash hold recovery releases without wake',async()=>{
 const f=await fixture();f.fail();await expect(f.run('delete')).rejects.toThrow('preparation failed');expect(await f.runtime.nativeRemovals({directory:f.directory})).toEqual([]);expect((await f.runtime.nativeAdmissionState({directory:f.directory,sessionID:'ses_root'})).held).toBe(false);
 await f.runtime.holdNativeAdmission({directory:f.directory,sessionID:'ses_root',ownerID:'bundle',retentionInstanceID:'epoch-a'});await f.replace();await f.retention.recover({directory:f.directory,instanceID:'epoch-b'});expect((await f.runtime.nativeAdmissionState({directory:f.directory,sessionID:'ses_root'})).held).toBe(false);
});
test('foreign hold and exact tree mutation are refused without deleting',async()=>{
 const f=await fixture();await f.runtime.registerNativeSession({directory:f.directory,sessionID:'ses_root'});await f.runtime.holdNativeAdmission({directory:f.directory,sessionID:'ses_root',ownerID:'foreign'});await expect(f.run('delete')).rejects.toMatchObject({code:'native_session_held'});expect(f.sessions.size).toBe(2);
});

test('replacement while installing quiet hold releases only that exact decision',async()=>{
 const f=await fixture(),hold=f.runtime.holdNativeAdmission;
 f.runtime.holdNativeAdmission=async input=>{const result=await hold(input);await f.replace();return result;};
 await expect(f.run('archive')).rejects.toMatchObject({code:'native_permit_revoked'});
 expect((await f.runtime.nativeAdmissionState({directory:f.directory,sessionID:'ses_root'})).held).toBe(false);expect(f.sessions.size).toBe(2);
});
