import {afterEach,expect,test} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {git} from '../../../../../harness-runtime/lib/session-changes-git.js';
import {openChangeStore,changeKey} from '../../../../../harness-runtime/lib/session-changes-store.js';
import {BUNDLE_REFERENCE_FIELDS,PER_FILE_RECORD,inspectBundleHarness} from './bundle-harness-integrity.js';
import {createSessionMutationRuntime} from '../../../../../harness-runtime/lib/session-mutations.js';
import {sha256} from './bundle-migration-inventory.js';
import {createNativeProjectLocations} from './native-project-locations.js';

const roots=[];
afterEach(async()=>Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true}))));
async function fixture({state='committed',acked=false,stage=true}={}) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'bundle-removal-')));roots.push(root);
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
test('clone preserves the exact registered external project without changing its immutable baseline map',async()=>{
  const f=await fixture(), baseline=path.join(path.dirname(f.web),'original-empty-workspace');
  await fs.mkdir(baseline);await fs.mkdir(f.member.directory);
  const projectMap=[{sourceDirectory:baseline,targetDirectory:baseline,mode:'identity'}];
  const context={kind:'task',sessionID:f.member.id,directory:f.member.directory,model:'saved/model'};
  const contextRoot=path.join(f.web,'harness','context');await fs.mkdir(contextRoot,{recursive:true});
  const contextFile=path.join(contextRoot,`task_${sha256(`${f.member.id}:${f.member.directory}`)}.json`);
  await fs.writeFile(contextFile,JSON.stringify(context));
  await fs.writeFile(path.join(f.web,'settings.json'),JSON.stringify({projects:[{id:'external-qa-project',path:f.member.directory}]}));
  const before=await f.verify();
  const relocated=await f.verify({relocate:true,projectMap});
  expect(relocated.sessionReferences).toEqual(before.sessionReferences);
  expect(relocated.messageReferences).toEqual(before.messageReferences);
  expect(await f.db.get('meta.json')).toMatchObject({directory:f.member.directory});
  expect(JSON.parse(await fs.readFile(contextFile,'utf8'))).toEqual(context);
  expect(projectMap).toEqual([{sourceDirectory:baseline,targetDirectory:baseline,mode:'identity'}]);
});

test('native stream history retains every objective and predecessor reference through migration inspection',async()=>{
 const f=await fixture({state:'completed',acked:true});
 const directory=path.join(f.web,'harness','provider-stream');await fs.mkdir(directory,{recursive:true});
 const ids=['msg_objective','msg_source','msg_previous','msg_synthetic','msg_successor'];
 await fs.writeFile(path.join(directory,'history.json'),JSON.stringify({sessionID:'ses_live',directory:f.member.directory,
  objectiveID:ids[0],receipts:[{anchorID:ids[0],objectiveID:ids[0],sourceUserMessageID:ids[1],previousStepID:ids[2],
   userMessageID:ids[3],assistantMessageID:ids[4]}]}));
 await expect(f.verify({sessionIDs:['ses_live'],messageIDs:ids})).resolves.toBeDefined();
 for(const missing of ids) await expect(f.verify({sessionIDs:['ses_live'],messageIDs:ids.filter(id=>id!==missing)}))
  .rejects.toMatchObject({code:'bundle_message_reference_lost'});
});
test('cold resume and clone preserve a removed registered project history without granting its executable location',async()=>{
  const f=await fixture(),baseline=path.join(path.dirname(f.web),'baseline');
  await fs.mkdir(baseline);await fs.mkdir(f.member.directory);
  const projectMap=[{sourceDirectory:baseline,targetDirectory:baseline,mode:'identity'}],projects=[{path:f.member.directory}];
  await fs.writeFile(path.join(f.web,'settings.json'),JSON.stringify({projects}));
  const context={kind:'task',sessionID:f.member.id,directory:f.member.directory},contextRoot=path.join(f.web,'harness','context');
  await fs.mkdir(contextRoot,{recursive:true});const contextFile=path.join(contextRoot,`task_${sha256(`${f.member.id}:${f.member.directory}`)}.json`);
  await fs.writeFile(contextFile,JSON.stringify(context));
  const before=await f.verify();await f.verify({relocate:true,projectMap});
  await fs.rm(f.member.directory,{recursive:true});
  const preservedRefs={checkpointID:'checkpoint',refs:before.refs};
  expect((await f.verify({projectMap,preservedRefs})).sessionReferences).toEqual(before.sessionReferences);
  await f.verify({relocate:true,projectMap,preservedRefs});
  expect(await f.db.get('meta.json')).toMatchObject({directory:f.member.directory});
  expect(JSON.parse(await fs.readFile(contextFile,'utf8'))).toEqual(context);
  const launch={webDataDirectory:f.web,webConfigDirectory:f.web,opencodeConfigDirectory:f.web,global:{tmp:f.web,home:f.web}};
  const locations=createNativeProjectLocations({baseLocations:[{directory:baseline,readRoots:[baseline],protectedRoots:[f.web]}],launch,getRegisteredProjects:async()=>projects});
  expect((await locations()).map(row=>row.directory)).toEqual([baseline]);
  await fs.writeFile(path.join(f.web,'settings.json'),JSON.stringify({projects:[]}));
  await expect(f.verify({projectMap,preservedRefs})).rejects.toMatchObject({code:'bundle_harness_directory_unmapped'});
  await fs.writeFile(path.join(f.web,'settings.json'),JSON.stringify({projects}));await fs.symlink(baseline,f.member.directory);
  await expect(f.verify({projectMap,preservedRefs})).rejects.toMatchObject({code:'bundle_harness_registered_project_invalid'});
});
test.each(['sibling','parent','protected','symlink'])('registered project identity cannot authorize an unmapped %s scope',async kind=>{
  const f=await fixture(),root=path.dirname(f.web),baseline=path.join(root,'baseline');await fs.mkdir(baseline);
  let registered=f.member.directory;
  if(kind==='sibling'){registered=registered+'-sibling';await fs.mkdir(registered);}
  if(kind==='parent')registered=root;
  if(kind==='protected')registered=f.web;
  if(kind==='symlink'){registered=registered+'-alias';await fs.symlink(f.member.directory,registered);}
  await fs.writeFile(path.join(f.web,'settings.json'),JSON.stringify({projects:[{path:registered}]}));
  await expect(f.verify({relocate:true,projectMap:[{sourceDirectory:baseline,targetDirectory:baseline,mode:'identity'}]}))
    .rejects.toMatchObject({code:kind==='protected'||kind==='symlink'?'bundle_harness_registered_project_invalid':'bundle_harness_directory_unmapped'});
});
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
    // A completed removal that no longer proves its session is reported, and the session it cannot excuse is lost.
    await f.save();await expect(f.verify()).rejects.toMatchObject({code:defect==='completed-without-ack'?'bundle_session_reference_lost':'bundle_native_removal_invalid'});
  });
test('a removed child session without a recorded directory is valid; a foreign directory is not',async()=>{
  const f=await fixture({acked:true});delete f.session.directory;await f.save();
  expect((await f.verify()).sessionReferences).toEqual(['ses_removed']);
  f.session.directory='/elsewhere';await f.save();await expect(f.verify()).rejects.toMatchObject({code:'bundle_native_removal_invalid'});
});
test.each([{messageID:'msg_gone_assistant'},{sessionID:'ses_gone',messageID:'msg_gone_assistant'}])(
  'a cancelled-call marker whose message or session is gone is reported, not refused: %o',async marker=>{
    const f=await fixture({acked:true});f.db.set('cancelled-calls/marker.json',marker);await f.db.commit();
    const result=await f.verify();
    expect(result.findings.map(row=>[row.code,row.key])).toEqual([
      ...marker.sessionID?[['bundle_session_reference_lost','cancelled-calls/marker.json']]:[],
      ['bundle_message_reference_lost','cancelled-calls/marker.json']]);
    expect(result.messageReferences).toEqual(['msg_removed_history']);
    // The same lost message on a record that is not a marker still refuses.
    f.db.set('operations/other.json',{messageID:'msg_gone_assistant'});await f.db.commit();
    await expect(f.verify()).rejects.toMatchObject({code:'bundle_message_reference_lost'});
  });
test('a finished task whose child session was removed is history, a lost reference is reported, an unfinished one still refuses',async()=>{
  const f=await fixture({acked:true}), ledger=path.join(f.web,'orchestration','ledger.json');
  const save=tasks=>fs.mkdir(path.dirname(ledger),{recursive:true}).then(()=>fs.writeFile(ledger,JSON.stringify({tasks})));
  // Cursor child results name `<user>_assistant` messages that only the removed child session held.
  const task={taskId:'dvr_task_1',status:'completed',childSessionId:'ses_removed',rootSessionId:'ses_removed',
    canonicalRefs:[{id:'msg_child_assistant',type:'message'},{id:'call-1',messageId:'msg_child_assistant',type:'tool'}]};
  await save([task]);
  expect((await f.verify()).findings).toEqual([]);
  await save([{...task,childSessionId:'ses_gone'}]);
  expect((await f.verify()).findings.map(row=>[row.code,row.ledger,row.key])).toEqual([
    ['bundle_session_reference_lost','orchestratio','tasks/dvr_task_1'],['bundle_message_reference_lost','orchestratio','tasks/dvr_task_1']]);
  await save([{...task,status:'queued',childSessionId:'ses_gone'}]);
  await expect(f.verify()).rejects.toMatchObject({code:'bundle_session_reference_lost'});
  await save([{...task,status:'queued'}]);
  expect((await f.verify()).findings).toEqual([]);
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

test('an unsettled lease or pending lease cleanup refuses as bundle_execution_unsettled',async()=>{
 const f=await fixture({state:'completed',acked:true}),token='30000000-0000-4000-8000-000000000003',key=`leases/${token}.json`;
 const lease={token,directory:f.member.directory,generation:0,preparation:'none',executionKind:'control',
  scope:{sessionID:'ses_control',userMessageID:'msg_user',messageID:'msg_assistant',callID:'call_control'}};
 const verify=()=>f.verify({sessionIDs:['ses_control'],messageIDs:['msg_user','msg_assistant']});
 for(const state of [{state:'preparing'},{state:'ready'},{state:'cancelled',cleanupPending:true},{state:'published',cleanupPending:true}]){
  f.db.set(key,{...lease,...state});await f.db.commit();await expect(verify()).rejects.toMatchObject({code:'bundle_execution_unsettled'});
 }
 f.db.set(key,{...lease,state:'cancelled',cleanupPending:false,cleaned:true});await f.db.commit();await expect(verify()).resolves.toBeDefined();
});

test('a ledger whose key listing exceeds 1 MiB inspects and relocates without buffering the listing',async()=>{
 const f=await fixture({state:'completed',acked:true});let names=0;
 const listingLimitBytes=32*1024,count=150,storeOptions={listingLimitBytes};
 for(let i=0;i<count;i++){const key=`files/${String(i).padStart(6,'0')}${'a'.repeat(250)}/x.json`;names+=key.length+1;f.db.set(key,{i});}
 await f.db.commit();expect(names).toBeGreaterThan(listingLimitBytes);
 expect((await f.verify({storeOptions})).sessionReferences).toEqual(['ses_removed']);
 const directory=f.member.directory,key=`files/${String(count-1).padStart(6,'0')}${'a'.repeat(250)}/x.json`;
 await f.verify({storeOptions,relocate:true,checkpointID:'checkpoint',projectMap:[{sourceDirectory:directory,targetDirectory:directory}]});
 const storage=path.join(f.web,'harness','session-mutations',changeKey(directory)),after=await openChangeStore(storage,path.join(storage,'git'));
 expect(await after.get(key)).toEqual({i:count-1});expect(await after.get('meta.json')).toMatchObject({directory});
},60_000);

test('settled evidence that names a deleted session is history; unsettled evidence still refuses',async()=>{
 const f=await fixture({acked:true}),records=path.join(f.web,'harness','evidence','records');
 await fs.mkdir(records,{recursive:true});
 const save=record=>fs.writeFile(path.join(records,'run.json'),JSON.stringify(record));
 await save({status:'complete',sessionID:'ses_gone',messageID:'msg_gone'});
 expect((await f.verify()).findings.map(row=>[row.code,row.ledger])).toEqual([['bundle_session_reference_lost','evidence'],['bundle_message_reference_lost','evidence']]);
 await save({status:'running',sessionID:'ses_gone',messageID:'msg_gone'});
 await expect(f.verify()).rejects.toMatchObject({code:'bundle_session_reference_lost'});
});

test('a cancelled shell run reports its undelivered notice instead of refusing launch',async()=>{
 const f=await fixture(),directory=f.member.directory,sessionID='ses_shell',token='40000000-0000-4000-8000-000000000004';
 const key=`leases/${token}.json`,scope={sessionID,userMessageID:'msg_source',messageID:'msg_assistant',callID:'call_shell'};
 const lease={token,directory,state:'cancelled',executionKind:'control',generation:0,preparation:'none',cleanupPending:false,cleaned:true,scope,
  nativeShellJob:{jobID:'job_shell',command:'npx vite',notificationID:'msg_never_delivered'}};
 f.db.set(`sessions/${changeKey(sessionID)}.json`,{id:sessionID,directory,generation:0,pending:null});f.db.set(key,lease);await f.db.commit();
 const verify=()=>inspectBundleHarness(f.web,{sessionIDs:[sessionID],messageIDs:['msg_source','msg_assistant']});
 expect((await verify()).findings.map(row=>row.code)).toContain('bundle_shell_notice_undelivered');
 // Once delivered, the notice is a real message and must exist.
 f.db.set(key,{...lease,nativeShellJob:{...lease.nativeShellJob,deliveredID:'msg_never_delivered'}});await f.db.commit();
 await expect(verify()).rejects.toMatchObject({code:'bundle_message_reference_lost'});
 // Accepted into an archived session's inbox, it never becomes a message;
 // a clone drops that row, so the lease reports it instead of refusing.
 const archived=()=>inspectBundleHarness(f.web,{sessionIDs:[sessionID],messageIDs:['msg_source','msg_assistant'],archivedSessionIDs:[sessionID]});
 expect((await archived()).findings.map(row=>row.code)).toContain('bundle_shell_notice_undelivered');
 f.db.set(key,{...lease,nativeShellJob:{...lease.nativeShellJob,deliveredID:'msg_other'}});await f.db.commit();
 await expect(archived()).rejects.toMatchObject({code:'bundle_message_reference_lost'});
 // A published (not cancelled) run without a verified queued notice still refuses.
 f.db.set(key,{...lease,state:'published'});await f.db.commit();
 await expect(verify()).rejects.toMatchObject({code:'bundle_message_reference_lost'});
});

test('per-file ledger records, which startup inspection does not read, never carry a session or message reference',async()=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'bundle-per-file-')));roots.push(root);
  const directory=path.join(root,'project'),web=path.join(root,'web');
  await fs.mkdir(path.join(directory,'src'),{recursive:true});await git(directory,['init','--quiet']);
  for(let index=0;index<8;index+=1)await fs.writeFile(path.join(directory,'src',`f${index}.txt`),`line ${index}\n`);
  const runtime=createSessionMutationRuntime({directory:path.join(web,'harness','session-mutations')});
  const edit=async(sessionID,userMessageID,callID,change)=>{
    const lease=await runtime.begin({directory,sessionID,userMessageID,messageID:`${userMessageID}-assistant`,callID});
    await runtime.claimLease({directory,token:lease.token,kind:'process'});
    await change(lease.viewDirectory);
    await fs.writeFile(path.join(path.dirname(lease.viewDirectory),'termination.json'),JSON.stringify({terminated:true,confined:true,exitCode:0,cancelled:false}),{flag:'wx',mode:0o600});
    await runtime.finish({directory,token:lease.token});
    await runtime.cleanupLease({directory,token:lease.token});
  };
  await edit('ses_a','msg_a1','call_a1',view=>fs.appendFile(path.join(view,'src','f0.txt'),'edited\n'));
  await edit('ses_b','msg_b1','call_b1',async view=>{await fs.rm(path.join(view,'src','f1.txt'));await fs.writeFile(path.join(view,'src','new.txt'),'new\n');});
  const revert=await runtime.prepareRevert({directory,sessionID:'ses_a',messageID:'msg_a1'});
  await runtime.settleRevert({directory,transactionID:revert.id,commit:true});
  await runtime.drain();
  const storage=path.join(web,'harness','session-mutations',changeKey(await fs.realpath(directory)));
  const db=await openChangeStore(storage,path.join(storage,'git')),fields=new Set(BUNDLE_REFERENCE_FIELDS);
  const named=(value,route)=>{
    if(Array.isArray(value))return value.flatMap((item,index)=>named(item,`${route}.${index}`));
    if(!value||typeof value!=='object')return [];
    return Object.entries(value).flatMap(([key,item])=>[...(fields.has(key)?[`${route}.${key}`]:[]),...named(item,`${route}.${key}`)]);
  };
  let perFile=0;const found=[];
  for await(const {key,value} of db.records()){if(!PER_FILE_RECORD.test(key))continue;perFile+=1;found.push(...named(value,key));}
  expect(perFile).toBeGreaterThan(20);
  expect(found).toEqual([]);
  // The skipped records change nothing the inspection reports.
  const inspected=await inspectBundleHarness(web,{});
  expect(inspected.sessionReferences).toEqual(expect.arrayContaining(['ses_a','ses_b']));
});

test('only the exact committed empty revert and a later persisted user prove a clipped prompt',async()=>{
  const f=await fixture({state:'completed',acked:true});
  const id='ses_live',oldID='msg_old',nextID='msg_next',txID='10000000-0000-4000-8000-000000000012';
  const oldKey=`prompts/${changeKey(`${id}\0${oldID}`)}.json`,nextKey=`prompts/${changeKey(`${id}\0${nextID}`)}.json`;
  const txKey=`transactions/${changeKey(txID)}.json`;
  const old={sessionID:id,messageID:oldID,sequence:1,origins:{},fingerprint:'a'.repeat(64),candidateHash:'b'.repeat(64),reverted:true};
  const next={sessionID:id,messageID:nextID,sequence:3,origins:{},fingerprint:'c'.repeat(64),candidateHash:'d'.repeat(64)};
  const tx={id:txID,rootSessionID:id,boundarySequence:1,state:'committed',phase:'committed',scope:'tree',members:[id],
    targets:[{id,targetMessageID:oldID}],redo:false,boundaries:[{id,revert:null}],
    result:{files:[],sessions:[{id,targetMessageID:oldID}],redoAvailable:true}};
  f.db.set(`sessions/${changeKey(id)}.json`,{id,directory:f.member.directory,parentID:null});
  f.db.set(oldKey,old);f.db.set(nextKey,next);f.db.set(txKey,tx);await f.db.commit();
  const nativeUsers=[{id:nextID,sessionID:id,fingerprint:next.fingerprint}];
  const verify=options=>f.verify({sessionIDs:[id],messageIDs:[nextID],nativeUsers,...options});
  await expect(verify()).resolves.toBeDefined();
  for(const users of [[],[{...nativeUsers[0],sessionID:'ses_foreign'}],[{...nativeUsers[0],fingerprint:'0'.repeat(64)}]])
    await expect(verify({nativeUsers:users})).rejects.toMatchObject({code:'bundle_message_reference_lost'});
  for(const modified of [{...tx,boundarySequence:2},{...tx,redo:true},{...tx,state:'cancelled'},
    {...tx,result:{...tx.result,files:[{path:'x'}]}},{...tx,boundaries:[{id,revert:{messageID:'msg_other'}}]}]){
    f.db.set(txKey,modified);await f.db.commit();await expect(verify()).rejects.toMatchObject({code:'bundle_message_reference_lost'});
  }
  f.db.set(txKey,tx);f.db.set(oldKey,{...old,reverted:false});await f.db.commit();
  await expect(verify()).rejects.toMatchObject({code:'bundle_message_reference_lost'});
  f.db.set(oldKey,old);f.db.set(nextKey,{...next,provisional:true});await f.db.commit();
  await expect(verify()).rejects.toMatchObject({code:'bundle_harness_record_invalid'});
  f.db.set(nextKey,next);f.db.set('operations/foreign.json',{scope:{sessionID:id,messageID:oldID}});await f.db.commit();
  await expect(verify()).rejects.toMatchObject({code:'bundle_message_reference_lost'});
});

test('completed native discard excuses only its exact prompt and payload in its owning session',async()=>{
 const f=await fixture({state:'completed',acked:true}),id='ses_live',messageID='msg_discarded';
 const key=`prompts/${changeKey(`${id}\0${messageID}`)}.json`,sessionKey=`sessions/${changeKey(id)}.json`;
 const prompt={sessionID:id,messageID,sequence:2,origins:{},fingerprint:'a'.repeat(64),candidateHash:'b'.repeat(64)};
 f.db.set(sessionKey,{id,directory:f.member.directory,parentID:null,generation:0,pending:null});f.db.set(key,prompt);await f.db.commit();
 const proof={id:messageID,sessionID:id,directory:f.member.directory,payloadHash:prompt.candidateHash};
 const verify=verifiedCancellations=>f.verify({sessionIDs:[id],messageIDs:[],verifiedCancellations});
 await expect(verify([proof])).resolves.toBeDefined();
 for(const bad of [[],[{...proof,sessionID:'ses_foreign'}],[{...proof,directory:'/elsewhere'}],[{...proof,payloadHash:'0'.repeat(64)}]])
  await expect(verify(bad)).rejects.toMatchObject({code:'bundle_message_reference_lost'});
 f.db.set('operations/foreign.json',{scope:{sessionID:id,messageID}});await f.db.commit();
 await expect(verify([proof])).rejects.toMatchObject({code:'bundle_message_reference_lost'});
});

test('clipped edited turn requires the exact committed operation, call and published lease',async()=>{
 const f=await fixture({state:'completed',acked:true}),id='ses_edit',user='msg_edit',assistant='msg_writer',next='msg_after',call='call_write';
 const txID='10000000-0000-4000-8000-000000000042',opID='10000000-0000-4000-8000-000000000043',token='10000000-0000-4000-8000-000000000044';
 const promptKey=`prompts/${changeKey(`${id}\0${user}`)}.json`,nextKey=`prompts/${changeKey(`${id}\0${next}`)}.json`;
 const txKey=`transactions/${changeKey(txID)}.json`,opKey=`operations/${changeKey(opID)}.json`,leaseKey=`leases/${changeKey(token)}.json`,callKey=`calls/${changeKey(`${id}\0${call}`)}.json`;
 const scope={sessionID:id,userMessageID:user,messageID:assistant,callID:call};
 const old={sessionID:id,messageID:user,sequence:2,origins:{},fingerprint:'a'.repeat(64),candidateHash:'b'.repeat(64),reverted:true};
 const newer={sessionID:id,messageID:next,sequence:5,origins:{},fingerprint:'c'.repeat(64),candidateHash:'d'.repeat(64)};
 const tx={id:txID,rootSessionID:id,boundarySequence:2,state:'committed',phase:'committed',scope:'tree',members:[id],targets:[{id,targetMessageID:user}],redo:false,boundaries:[{id,revert:null}],result:{files:[{path:'edit',status:'modified'}],sessions:[{id,targetMessageID:user}],redoAvailable:true}};
 const op={id:opID,scope,sequence:3,promptSequence:2,active:false,files:['file']};
 const lease={token,scope,promptSequence:2,state:'published',cleanupPending:false,result:{operationID:opID,sequence:3}};
 const pointer={token,effect:{tool:'devryan_task',effect:'control'},effectScope:scope};
 f.db.set(`sessions/${changeKey(id)}.json`,{id,directory:f.member.directory,parentID:null});
 f.db.set(promptKey,old);f.db.set(nextKey,newer);f.db.set(txKey,tx);f.db.set(opKey,op);f.db.set(leaseKey,lease);f.db.set(callKey,pointer);
 await f.db.setList(`transactions/${txID}/operations`,[opID]);await f.db.commit();
 const verify=()=>f.verify({sessionIDs:[id],messageIDs:[next],nativeUsers:[{id:next,sessionID:id,fingerprint:newer.fingerprint}]});
 await expect(verify()).resolves.toBeDefined();
 const child='ses_child',childUser='msg_child',childAssistant='msg_child_assistant',childCall='call_child',childOpID='10000000-0000-4000-8000-000000000045',childToken='10000000-0000-4000-8000-000000000046';
 const childScope={sessionID:child,userMessageID:childUser,messageID:childAssistant,callID:childCall};
 const childOp={id:childOpID,scope:childScope,sequence:5,promptSequence:4,origins:{[id]:2},active:false,files:['child-file']};
 const childLease={token:childToken,scope:childScope,promptSequence:4,state:'published',cleanupPending:false,result:{operationID:childOpID,sequence:5}};
 const targets=[...tx.targets,{id:child,targetMessageID:childUser}],tree={...tx,members:[id,child],targets,boundaries:[...tx.boundaries,{id:child,revert:null}],result:{...tx.result,sessions:targets}};
 const childSessionKey=`sessions/${changeKey(child)}.json`,childOpKey=`operations/${changeKey(childOpID)}.json`;
 f.db.set(childSessionKey,{id:child,directory:f.member.directory,parentID:id});
 f.db.set(`prompts/${changeKey(`${child}\0${childUser}`)}.json`,{sessionID:child,messageID:childUser,sequence:4,origins:{[id]:2},fingerprint:'e'.repeat(64),candidateHash:'f'.repeat(64),reverted:true});
 f.db.set(childOpKey,childOp);f.db.set(`leases/${changeKey(childToken)}.json`,childLease);f.db.set(`calls/${changeKey(`${child}\0${childCall}`)}.json`,{token:childToken});
 f.db.set(txKey,tree);await f.db.setList(`transactions/${txID}/operations`,[opID,childOpID]);await f.db.commit();
 const verifyTree=()=>f.verify({sessionIDs:[id,child],messageIDs:[next,childUser,childAssistant],nativeUsers:[{id:next,sessionID:id,fingerprint:newer.fingerprint}]});
 await expect(verifyTree()).resolves.toBeDefined();
 f.db.set(childSessionKey,{id:child,directory:f.member.directory,parentID:'ses_foreign'});await f.db.commit();await expect(verifyTree()).rejects.toMatchObject({code:'bundle_message_reference_lost'});
 f.db.set(childSessionKey,{id:child,directory:f.member.directory,parentID:id});f.db.set(childOpKey,{...childOp,origins:{[id]:1}});await f.db.commit();await expect(verifyTree()).rejects.toMatchObject({code:'bundle_message_reference_lost'});
 f.db.set(childOpKey,childOp);f.db.set(txKey,tx);await f.db.setList(`transactions/${txID}/operations`,[opID]);await f.db.commit();
 f.db.remove(childSessionKey);f.db.remove(childOpKey);f.db.remove(`prompts/${changeKey(`${child}\0${childUser}`)}.json`);f.db.remove(`leases/${changeKey(childToken)}.json`);f.db.remove(`calls/${changeKey(`${child}\0${childCall}`)}.json`);await f.db.commit();
 for(const [key,bad] of [[opKey,{...op,active:true}],[opKey,{...op,scope:{...scope,userMessageID:'msg_foreign'}}],
  [leaseKey,{...lease,state:'cancelled'}],[leaseKey,{...lease,result:{operationID:'other',sequence:3}}],
  [callKey,{token:'foreign'}],[callKey,{...pointer,effectScope:{...scope,messageID:'msg_foreign'}}],[txKey,{...tx,state:'cancelled'}]]){
  f.db.set(key,bad);await f.db.commit();await expect(verify()).rejects.toMatchObject({code:'bundle_message_reference_lost'});
  f.db.set(key,key===opKey?op:key===leaseKey?lease:key===callKey?pointer:tx);await f.db.commit();
 }
 f.db.set('operations/unrelated.json',{scope:{sessionID:id,messageID:assistant}});await f.db.commit();
 await expect(verify()).rejects.toMatchObject({code:'bundle_message_reference_lost'});
});
