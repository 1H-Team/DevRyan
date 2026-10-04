import {afterEach,expect,test} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {git} from '../../../../../harness-runtime/lib/session-changes-git.js';
import {openChangeStore,changeKey} from '../../../../../harness-runtime/lib/session-changes-store.js';
import {inspectBundleHarness} from './bundle-harness-integrity.js';

const roots=[];
afterEach(async()=>Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true}))));
async function fixture({state='committed',acked=false,stage=true}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bundle-removal-'));roots.push(root);
  const directory=path.join(root,'project'), web=path.join(root,'web');
  const storage=path.join(web,'harness','session-mutations',changeKey(directory)), gitDirectory=path.join(storage,'git');
  await fs.mkdir(storage,{recursive:true});await git(storage,['init','--bare','--quiet',gitDirectory]);
  const db=await openChangeStore(storage,gitDirectory),id='10000000-0000-4000-8000-000000000001';
  const member={id:'ses_removed',parentID:null,directory,generation:0};
  const intent={id,directory,rootSessionID:member.id,ownerID:'candidate',state,members:[member],removed:acked?[member.id]:[],
    dispositions:stage?[{sessionID:member.id,inboxIDs:['msg_disposed'],pendingIDs:[]}]:[]};
  const session={...member,pending:null,nativeAdmission:{revision:1,holds:[{id:'hold',ownerID:`native-removal:${id}`,removalID:id}],continuations:[]},
    ...(acked?{nativeRemoved:id}:{})};
  db.set('meta.json',{version:1,directory,sequence:1});
  db.set(`sessions/${changeKey(member.id)}.json`,session);
  db.set(`native-removals/${changeKey(id)}.json`,intent);
  db.set('operations/history.json',{scope:{sessionID:member.id,messageID:'msg_removed_history'}});
  await db.commit();
  return {web,db,intent,session,member,verify:options=>inspectBundleHarness(web,{sessionIDs:[],messageIDs:[],...options}),
    save:async()=>{db.set(`sessions/${changeKey(member.id)}.json`,session);db.set(`native-removals/${changeKey(id)}.json`,intent);await db.commit();}};
}
test.each([{state:'committed',acked:false},{state:'committed',acked:true},{state:'completed',acked:true}])(
  'resume accepts exact durable $state removal with ACK=$acked',async options=>{
    const f=await fixture(options);
    expect((await f.verify()).sessionReferences).toEqual(['ses_removed']);
    expect((await f.verify()).messageReferences).toEqual(['msg_removed_history']);
  });
test.each([{state:'preparing',acked:false},{state:'committed',acked:false,stage:false}])(
  'missing native session remains corruption before committed staged disposal: $state/$stage',async options=>{
    const f=await fixture(options);await expect(f.verify()).rejects.toMatchObject({code:'bundle_session_reference_lost'});
  });
test.each(['tombstone-without-ack','ack-without-tombstone','wrong-hold','wrong-generation','missing-member','completed-without-ack'])(
  'inconsistent removal proof refuses: %s',async defect=>{
    const f=await fixture({acked:true});
    if(defect==='tombstone-without-ack')f.intent.removed=[];
    if(defect==='ack-without-tombstone')delete f.session.nativeRemoved;
    if(defect==='wrong-hold')f.session.nativeAdmission.holds[0].ownerID='other';
    if(defect==='wrong-generation')f.session.generation++;
    if(defect==='missing-member')f.intent.members=[];
    if(defect==='completed-without-ack'){f.intent.state='completed';f.intent.removed=[];delete f.session.nativeRemoved;}
    await f.save();await expect(f.verify()).rejects.toMatchObject({code:'bundle_native_removal_invalid'});
  });
test('ACKed tombstone cannot authorize a native session that still exists',async()=>{
  const f=await fixture({acked:true});await expect(f.verify({sessionIDs:['ses_removed']})).rejects.toMatchObject({code:'bundle_native_removal_invalid'});
});
test('a valid removed member never exempts unrelated session or unscoped message references',async()=>{
  const f=await fixture();f.db.set('operations/unrelated.json',{scope:{sessionID:'ses_unknown'}});await f.db.commit();
  await expect(f.verify()).rejects.toMatchObject({code:'bundle_session_reference_lost'});
  f.db.remove('operations/unrelated.json');f.db.set('operations/unrelated-message.json',{messageID:'msg_unknown'});await f.db.commit();
  await expect(f.verify()).rejects.toMatchObject({code:'bundle_message_reference_lost'});
});
test('a shared missing message referenced by a live session still refuses',async()=>{
  const f=await fixture();f.db.set('operations/live.json',{scope:{sessionID:'ses_live',messageID:'msg_removed_history'}});await f.db.commit();
  await expect(f.verify({sessionIDs:['ses_live']})).rejects.toMatchObject({code:'bundle_message_reference_lost'});
});
test('staged message disposal cannot excuse a reference belonging to another live session',async()=>{
  const f=await fixture();f.db.set('operations/live.json',{scope:{sessionID:'ses_live',messageID:'msg_disposed'}});await f.db.commit();
  await expect(f.verify({sessionIDs:['ses_live']})).rejects.toMatchObject({code:'bundle_message_reference_lost'});
});
test('an absent parent with a still-present sealed child cannot be an owned leaf deletion',async()=>{
  const f=await fixture(), child={id:'ses_live_child',parentID:f.member.id,directory:f.member.directory,generation:0};
  f.intent.members.push(child);
  f.db.set(`sessions/${changeKey(child.id)}.json`,{...child,pending:null,nativeAdmission:structuredClone(f.session.nativeAdmission)});
  await f.save();
  await expect(f.verify({sessionIDs:[child.id]})).rejects.toMatchObject({code:'bundle_native_removal_invalid'});
});

test('queued shell notification uses only its exact immutable settled lease occurrence; discard has no cross-owner exception',async()=>{
 const f=await fixture(),directory=f.member.directory,sessionID='ses_shell',messageID='msg_notification',token='20000000-0000-4000-8000-000000000002';
 const storage=path.join(f.web,'harness','session-mutations',changeKey(directory)),viewDirectory=path.join(storage,'views',token,'worktree');
 await fs.mkdir(path.dirname(viewDirectory),{recursive:true});await fs.writeFile(path.join(path.dirname(viewDirectory),'termination.json'),JSON.stringify({terminated:true,confined:true,exitCode:0,cancelled:false}));
 const lease={token,directory,state:'published',executionKind:'process',generation:0,viewDirectory,scope:{sessionID,userMessageID:'msg_source',messageID:'msg_assistant',callID:'call_shell'},nativeShellJob:{jobID:'job_shell',command:'echo owned',notificationID:messageID,itemHash:'a'.repeat(64),itemDelivery:'steer'}};
 const leaseKey=`leases/${token}.json`;f.db.set(`sessions/${changeKey(sessionID)}.json`,{id:sessionID,directory,generation:0,pending:null});f.db.set(leaseKey,lease);await f.db.commit();
 const proof={id:messageID,sessionID,directory,itemProof:{type:'synthetic',delivery:'steer',hash:'a'.repeat(64)},inboxSha256:'b'.repeat(64),sessionSha256:'c'.repeat(64),sourceSha256:'d'.repeat(64)};
 const verify=proofs=>inspectBundleHarness(f.web,{sessionIDs:[sessionID],messageIDs:['msg_source','msg_assistant'],verifiedContinuations:proofs});
 await expect(verify([])).rejects.toMatchObject({code:'bundle_message_reference_lost'});await expect(verify([proof])).resolves.toBeDefined();
 for(const itemProof of [{...proof.itemProof,hash:'0'.repeat(64)},{...proof.itemProof,delivery:'queue'}])await expect(verify([{...proof,itemProof}])).rejects.toMatchObject({code:'bundle_message_reference_lost'});
 f.db.set(leaseKey,{...lease,generation:1});await f.db.commit();await expect(verify([proof])).rejects.toMatchObject({code:'bundle_message_reference_lost'});
 for(const changed of [{...lease,directory:undefined},{...lease,directory:path.join(directory,'foreign'),scope:{...lease.scope,directory}}]){
  f.db.set(leaseKey,changed);await f.db.commit();await expect(verify([proof])).rejects.toMatchObject({code:'bundle_message_reference_lost'});
 }
 f.db.set(leaseKey,{...lease,nativeShellJob:{...lease.nativeShellJob,deliveredID:'msg_foreign'}});await f.db.commit();await expect(verify([proof])).rejects.toMatchObject({code:'bundle_message_reference_lost'});
 f.db.set(leaseKey,{...lease,nativeShellJob:{...lease.nativeShellJob,deliveredID:messageID}});await f.db.commit();await expect(verify([proof])).resolves.toBeDefined();
 f.db.set(leaseKey,lease);await f.db.commit();await expect(inspectBundleHarness(f.web,{relocate:true,projectMap:[{sourceDirectory:directory,targetDirectory:directory}],sessionIDs:[sessionID],messageIDs:['msg_source','msg_assistant'],verifiedContinuations:[proof]})).rejects.toMatchObject({code:'bundle_message_reference_lost'});
 f.db.set(leaseKey,{...lease,extra:{notificationID:messageID}});await f.db.commit();await expect(verify([proof])).rejects.toMatchObject({code:'bundle_message_reference_lost'});
});
