import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {afterEach,expect,test} from 'vitest';
import {resolveSqliteDriver} from '../db-maintenance-core.js';
import {readRecoveredNativeInputs,createNativeRecoveredInputOwner,recoveredInputHash,nativeInputCancellation} from './native-recovered-input.js';
import {verifyBundleRecoveredInputs} from './bundle-recovered-inputs.js';
import {inspectBundleHarness} from './bundle-harness-integrity.js';
import {nativeShellCompletionFingerprint} from './native-shell-completion.js';
import {assertBundlePendingInput,sha256} from './bundle-migration-inventory.js';
const roots=[];afterEach(async()=>{for(const {root,db} of roots.splice(0)){db.close();await fs.rm(root,{recursive:true,force:true});}});
async function fixture(){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'recovered-input-'))),file=path.join(root,'native.db');await fs.writeFile(file,'');const db=resolveSqliteDriver().open(file);roots.push({root,db});
 db.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY,directory TEXT,parent_id TEXT,agent TEXT,model TEXT,permission TEXT,revert TEXT,time_archived INTEGER);
 CREATE TABLE session_inbox(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,payload TEXT,delivery TEXT,enqueued_seq INTEGER,time_created INTEGER);
 CREATE TABLE session_pending(id TEXT); CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,data TEXT);
 CREATE TABLE event(id TEXT,aggregate_id TEXT,seq INTEGER,created INTEGER,type TEXT,data TEXT);`);
 const sessionID='ses_recovered',messageID='msg_original',directory=root;
 db.prepare('INSERT INTO session_v2 VALUES(?,?,?,?,?,?,?,?)').run(sessionID,directory,null,'build',JSON.stringify({providerID:'devryan-smoke',id:'smoke-write',variant:'default'}),'[]',null,null);
 const add=(id=messageID,text='retained input',seq=1)=>{db.prepare('INSERT INTO session_inbox VALUES(?,?,?,?,?,?,?)').run(id,sessionID,'user',JSON.stringify({text}),'queue',seq,100);};add();
 const message=(id,type,seq,content)=>db.prepare('INSERT INTO session_message VALUES(?,?,?,?,?)').run(id,sessionID,type,seq,JSON.stringify({time:{created:100},...content}));
 const sql={all:(query,params=[])=>db.prepare(query).all(...params)};
 let record={version:1,revision:1,sessionID,directory,anchorID:messageID,providerID:'devryan-smoke',modelID:'smoke-write',agent:'build',variant:'default',tools:{read:true},owner:null,executionGeneration:2,state:'needs_attention',attemptCount:0,guardedIDs:[],createdAt:1,updatedAt:1,cancellationGeneration:1,stepID:null,recoveryID:null};
 const primaryRuntime={readRecord:async()=>structuredClone(record),nativeStartupRecords:async()=>record?[structuredClone(record)]:[],
  adoptRecoveredInput:async input=>{record={...record,revision:record.revision+1,state:input.messageID===record.recoveryID?'recovery_reserved':'observing',instanceID:input.instanceID,owner:input.owner,recoveredInput:{inputID:input.messageID,payloadHash:input.payloadHash,enqueuedSeq:input.enqueuedSeq,delivery:input.delivery,phase:'adopted'}};return structuredClone(record);},
  requestRecoveredInputDiscard:async input=>{record={...record,revision:record.revision+1,recoveredInputDispositions:[...record.recoveredInputDispositions??[],{inputID:input.messageID,payloadHash:input.payloadHash,enqueuedSeq:input.enqueuedSeq,type:input.type,delivery:input.delivery,phase:'requested'}]};},
  settleRecoveredInputDiscard:async input=>{record={...record,revision:record.revision+1,...[record.anchorID,record.recoveryID,record.continuationID].includes(input.messageID)?{state:'cancelled'}:{},recoveredInputDispositions:record.recoveredInputDispositions.map(item=>item.inputID===input.messageID?{...item,phase:'cancelled',eventID:input.eventID,eventSeq:input.eventSeq}:item)};return record;}};
 let revoked=false,calls=0,loseAck=false;
 const owner=(overrides={})=>createNativeRecoveredInputOwner({databasePath:file,primaryRuntime,captureAuthorization:async()=>async()=>{if(revoked)throw Object.assign(new Error('forbidden'),{statusCode:403});},readiness:()=>{},withSessionLock:async(_id,action)=>action(),...overrides,runOwned:async({action,input,recheck})=>{await recheck();calls++;
  if(action==='discard'){db.prepare('DELETE FROM session_inbox WHERE id=?').run(input.messageID);db.prepare('INSERT INTO event VALUES(?,?,?,?,?,?)').run('evt_cancel:recovered-input',sessionID+':recovered-input-cancellation',100,100,'devryan.recovered-input.cancelled@1',JSON.stringify({version:1,sessionID,inboxID:input.messageID,enqueuedSeq:input.enqueuedSeq,type:input.type,delivery:input.delivery,payloadHash:input.payloadHash,instanceID:'fixture-epoch',nativeEvent:{id:'evt_cancel',type:'session.inbox.cancelled',version:1,aggregateID:sessionID,seq:100}}));if(loseAck)throw Object.assign(new Error('ack_lost'),{statusCode:503});}}});
 const scope=snapshot=>({revision:snapshot.revision,messageID:snapshot.inputs[0].messageID,payloadHash:snapshot.inputs[0].payloadHash});
 const write=async()=>{const dir=path.join(root,'harness','provider-recovery');await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,sha256(sessionID)+'.json'),JSON.stringify({version:1,key:sha256(sessionID),record}));};
 return {primaryRuntime,root,file,db,sql,sessionID,messageID,add,message,owner,scope,write,record:()=>record,setRecord:value=>{record=value;},setRevoked:()=>{revoked=true;},loseAck:()=>{loseAck=true;},calls:()=>calls};
}
test('initial queued crash is inspectable, fenced, explicitly same-ID adopted and reconstructed',async()=>{
 const f=await fixture(),owner=f.owner();expect(await owner.install('epoch1')).toEqual([f.sessionID]);const snapshot=await owner.snapshot(f.sessionID);
 expect(snapshot.inputs[0]).toMatchObject({messageID:f.messageID,canResume:true,canDiscard:true,preview:'retained input'});
 expect(await owner.details(f.sessionID,f.scope(snapshot))).toMatchObject({text:'retained input',files:[],agents:[]});
 for(const operation of ['admission.prompt','admission.command','session.compact','inbox.queue','inbox.steer','session.synthetic','execution.wake','store.claim'])expect(()=>owner.assertOperation({sessionID:f.sessionID,operation})).toThrow('native_recovered_input_fenced');
 expect(owner.assertOperation({sessionID:f.sessionID,operation:'session.abort'})).toBeUndefined();await owner.action(f.sessionID,'resume-input',f.scope(snapshot),{owner:null});expect(f.calls()).toBe(1);expect((await owner.snapshot(f.sessionID)).state).toBe('resuming');
 await expect(owner.action(f.sessionID,'resume-input',f.scope(snapshot),{owner:null})).rejects.toMatchObject({statusCode:409});const replacement=f.owner();await replacement.install('epoch2');expect((await replacement.snapshot(f.sessionID)).inputs[0].messageID).toBe(f.messageID);
});
test('details project retained skill and file attachments to the renderer contract',async()=>{
 const f=await fixture(),hashed='devryan-539ddc37a961e3aceadfc7bbb540b8e7';
 f.db.prepare('UPDATE session_inbox SET payload=?').run(JSON.stringify({text:'use /superpowers',
  files:[{data:'aGk=',mime:'text/plain',source:{type:'inline'},name:'note.txt'},{data:'',mime:'image/png',source:{type:'uri',uri:'https://fixture.invalid/a.png'}}],
  skills:[{id:hashed,name:'Superpowers',text:'full reviewed skill body',mention:{start:4,end:16,text:'/superpowers'}}]}));
 const owner=f.owner();await owner.install('epoch');const snapshot=await owner.snapshot(f.sessionID);
 const details=await owner.details(f.sessionID,f.scope(snapshot));
 expect(details.files).toEqual([{uri:'data:text/plain;base64,aGk=',name:'note.txt',mime:'text/plain'},{uri:'https://fixture.invalid/a.png',mime:'image/png'}]);
 expect(details.skills).toEqual([{id:hashed,name:'Superpowers'}]);
});
test('stale hash, revision and revoked principal never dispatch',async()=>{
 const f=await fixture(),owner=f.owner();await owner.install('epoch');const scope=f.scope(await owner.snapshot(f.sessionID));await expect(owner.action(f.sessionID,'resume-input',{...scope,payloadHash:'0'.repeat(64)},{owner:null})).rejects.toMatchObject({statusCode:409});
 f.db.prepare('UPDATE session_inbox SET payload=?').run(JSON.stringify({text:'changed'}));await expect(owner.action(f.sessionID,'resume-input',scope,{owner:null})).rejects.toMatchObject({statusCode:409});const fresh=f.scope(await owner.snapshot(f.sessionID));f.setRevoked();await expect(owner.action(f.sessionID,'resume-input',fresh,{owner:null})).rejects.toMatchObject({statusCode:403});expect(f.calls()).toBe(0);
});
test('competing inputs remain retained and lost cancel ACK reconciles by exact event on replacement',async()=>{
 const f=await fixture();f.add('msg_competitor','other accepted input',2);const owner=f.owner();await owner.install('epoch');const snapshot=await owner.snapshot(f.sessionID);expect(snapshot.inputs).toHaveLength(2);expect(snapshot.inputs.every(item=>!item.canResume&&item.canDiscard)).toBe(true);
 f.loseAck();await expect(owner.action(f.sessionID,'discard-input',f.scope(snapshot),{owner:null})).rejects.toMatchObject({statusCode:503});expect(f.record().recoveredInputDispositions[0].phase).toBe('requested');const replacement=f.owner();await replacement.install('next');expect(f.record().recoveredInputDispositions[0].phase).toBe('cancelled');expect((await replacement.snapshot(f.sessionID)).inputs.map(item=>item.messageID)).toEqual(['msg_competitor']);expect(f.calls()).toBe(1);
});
test('unknown started incomplete work is inspect-only; only typed authoritative completion settles',async()=>{
 const f=await fixture();f.db.prepare('DELETE FROM session_inbox').run();f.message(f.messageID,'user',1,{text:'retained input'});f.message('msg_assistant','assistant',2,{agent:'build',model:{providerID:'devryan-smoke',id:'smoke-write',variant:'default'},content:[]});const owner=f.owner();await owner.install('epoch');expect((await owner.snapshot(f.sessionID)).inputs[0]).toMatchObject({canResume:false,canDiscard:false,reason:'incomplete_assistant'});
 const data={time:{created:100,completed:101},agent:'build',model:{providerID:'devryan-smoke',id:'smoke-write',variant:'default'},content:[],finish:'stop'};f.db.prepare('UPDATE session_message SET data=? WHERE id=?').run(JSON.stringify(data),'msg_assistant');const replacement=f.owner();expect(await replacement.install('next')).toEqual([]);
 f.db.prepare('UPDATE session_message SET data=? WHERE id=?').run(JSON.stringify({...data,time:{created:100,completed:'yes'}}),'msg_assistant');expect(()=>readRecoveredNativeInputs(f.sql,[f.messageID])).toThrow();
});
test('automatic continuation compares encoded payload and refuses a competing batch before publish',async()=>{
 const f=await fixture(),owner=f.owner();await owner.install('epoch');await expect(owner.automatic({sessionID:f.sessionID,messageID:f.messageID,expectedItem:{type:'user',delivery:'queue',payload:{text:'changed'}}},f.record(),async()=>{},async()=>{})).rejects.toMatchObject({statusCode:409});const expectedItem={type:'user',delivery:'queue',payload:{text:'retained input'}};await owner.automatic({sessionID:f.sessionID,messageID:f.messageID,expectedItem},f.record(),async()=>{},async()=>{});const grant=owner.assertOperation({sessionID:f.sessionID,operation:'store.claim'});
 await expect(owner.beforePublish({events:[{type:'session.inbox.delivered',data:{sessionID:f.sessionID,inboxID:f.messageID}}],pending:[{id:f.messageID,sessionID:f.sessionID,payloadHash:recoveredInputHash(expectedItem)},{id:'msg_foreign',sessionID:f.sessionID,payloadHash:recoveredInputHash(expectedItem)}],grant:{recoveredInputGrant:grant}})).rejects.toMatchObject({statusCode:409});
});
test('private bundle proofs are occurrence-scoped and cancellation-pinned; default guard remains strict',async()=>{
 const f=await fixture();await f.write();const proofs=await verifyBundleRecoveredInputs(f.sql,f.root);expect(()=>assertBundlePendingInput(f.sql,proofs)).not.toThrow();expect(()=>assertBundlePendingInput(f.sql)).toThrow('migration_pending_input_unsupported');await expect(inspectBundleHarness(f.root,{sessionIDs:[f.sessionID],messageIDs:[],verifiedContinuations:proofs})).resolves.toBeDefined();
 f.setRecord({...f.record(),foreign:{anchorID:f.messageID}});await f.write();const borrowed=await verifyBundleRecoveredInputs(f.sql,f.root);await expect(inspectBundleHarness(f.root,{sessionIDs:[f.sessionID],messageIDs:[],verifiedContinuations:borrowed})).rejects.toMatchObject({code:'bundle_message_reference_lost'});
 f.setRecord({...f.record(),foreign:undefined});const owner=f.owner();await owner.install('epoch');await owner.action(f.sessionID,'discard-input',f.scope(await owner.snapshot(f.sessionID)),{owner:null});await f.write();const cancelled=await verifyBundleRecoveredInputs(f.sql,f.root);expect(cancelled[0].cancellation.eventID).toBe('evt_cancel');await expect(inspectBundleHarness(f.root,{sessionIDs:[f.sessionID],messageIDs:[],verifiedContinuations:cancelled})).resolves.toBeDefined();f.db.prepare('DELETE FROM event').run();expect(nativeInputCancellation(f.sql,{messageID:f.messageID,sessionID:f.sessionID,enqueuedSeq:1})).toBeNull();expect(()=>assertBundlePendingInput(f.sql,cancelled)).toThrow('migration_pending_input_unsupported');
});

test('settled adoption history and harmless notices do not consume the startup backlog bound',async()=>{
 const f=await fixture(),records=[];for(let index=0;index<140;index++){
  const sessionID='ses_history'+index,userID='msg_history'+index,assistantID='msg_done'+index;
  f.db.prepare('INSERT INTO session_v2 VALUES(?,?,?,?,?,?,?,?)').run(sessionID,f.root,null,'build',null,'[]',null,null);
  for(const [id,type,seq,data] of [[userID,'user',1,{time:{created:1},text:'done'}],[assistantID,'assistant',2,{time:{created:1,completed:2},agent:'build',model:{providerID:'devryan-smoke',id:'smoke-write'},content:[],finish:'stop'}]])f.db.prepare('INSERT INTO session_message VALUES(?,?,?,?,?)').run(id,sessionID,type,seq,JSON.stringify(data));
  records.push({...f.record(),sessionID,anchorID:userID,stepID:assistantID,recoveredInput:{inputID:userID,payloadHash:'a'.repeat(64),enqueuedSeq:1,delivery:'queue',phase:'adopted'}});
  f.message('msg_notice'+index,'synthetic',index+10,{text:'status',metadata:{devryan:{v:1,origin:'interview',statusOnly:true}}});
 }
 f.primaryRuntime.nativeStartupRecords=async()=>[...records,f.record()];const owner=f.owner();expect(await owner.install('epoch')).toEqual([f.sessionID]);expect((await owner.snapshot(f.sessionID)).inputs).toHaveLength(1);
});
test('refresh is scoped to the affected session while unrelated live queues keep working',async()=>{
 const f=await fixture(),owner=f.owner();await owner.install('epoch');f.db.prepare('INSERT INTO session_v2 VALUES(?,?,?,?,?,?,?,?)').run('ses_live',f.root,null,'build',null,'[]',null,null);
 for(let index=0;index<140;index++)f.db.prepare('INSERT INTO session_inbox VALUES(?,?,?,?,?,?,?)').run('msg_live'+index,'ses_live','user',JSON.stringify({text:'normal live input'}),'queue',index+1,100);
 expect((await owner.snapshot(f.sessionID)).inputs[0].messageID).toBe(f.messageID);expect(owner.assertOperation({sessionID:'ses_live',operation:'inbox.steer'})).toBeUndefined();
});
test('restored shell grant compares immutable owner item hash without persisted native events',async()=>{
 const f=await fixture(),text='owned shell result',receipt={token:'receipt-token',jobID:'job_original',command:'owned command',exitCode:0};
 const item={type:'synthetic',delivery:'queue',payload:{text,description:receipt.command,metadata:{source:'shell',jobID:receipt.jobID,shellID:receipt.jobID,state:'completed',exit:0,devryan:{v:1,origin:'native_shell',planMode:false,admission:{v:1,fingerprint:nativeShellCompletionFingerprint({sessionID:f.sessionID,messageID:f.messageID,token:receipt.token,text})}}}}};
 f.db.prepare('UPDATE session_inbox SET type=?,payload=?').run(item.type,JSON.stringify(item.payload));expect(f.db.prepare('SELECT * FROM event').all()).toEqual([]);const owner=f.owner();await owner.install('epoch');
 expect((await owner.snapshot(f.sessionID)).inputs[0].canDiscard).toBe(false);await expect(owner.action(f.sessionID,'discard-input',f.scope(await owner.snapshot(f.sessionID)),{owner:null})).rejects.toMatchObject({statusCode:409});expect(f.calls()).toBe(0);
 await expect(owner.automatic({sessionID:f.sessionID,messageID:f.messageID,shellReceipt:{...receipt,itemDelivery:'queue',itemHash:'0'.repeat(64)}},null,async()=>{},async()=>{})).rejects.toMatchObject({statusCode:409});
 await expect(owner.automatic({sessionID:f.sessionID,messageID:f.messageID,shellReceipt:{...receipt,itemDelivery:'queue',itemHash:recoveredInputHash(item)}},null,async()=>{},async()=>{})).resolves.toBeUndefined();
 const replacement=f.owner();f.db.prepare('DELETE FROM session_inbox').run();f.message(f.messageID,'synthetic',2,item.payload);await replacement.install('next');const promotedItem={...item,delivery:'steer'};
 await expect(replacement.automatic({sessionID:f.sessionID,messageID:f.messageID,shellReceipt:{...receipt,itemDelivery:'steer',itemHash:recoveredInputHash(promotedItem)}},null,async()=>{},async()=>{})).resolves.toBeUndefined();
});
test('cancel PRE publication rechecks fresh principal and old Step cannot consume pending reservation',async()=>{
 const f=await fixture(),owner=f.owner();await owner.install('epoch');const hash=(await owner.snapshot(f.sessionID)).inputs[0].payloadHash;
 await expect(owner.beforePublish({events:[{type:'session.inbox.cancelled',data:{sessionID:f.sessionID,inboxID:f.messageID}}],pending:[{id:f.messageID,sessionID:f.sessionID,payloadHash:hash}],grant:{recoveredInputCancellation:{messageID:f.messageID,payloadHash:hash},reauthorize:async()=>{throw Error('revoked');}}})).rejects.toThrow('revoked');
 const record={...f.record(),stepID:'msg_oldStep',continuationID:f.messageID,nativeContinuation:{messageID:f.messageID}};f.setRecord(record);const item={type:'user',delivery:'queue',payload:{text:'retained input'}};
 await owner.automatic({sessionID:f.sessionID,messageID:f.messageID,expectedItem:item},record,async()=>{},async()=>{});const grant=owner.assertOperation({sessionID:f.sessionID,operation:'store.claim'});f.setRecord({...record,nativeContinuation:undefined});
 await expect(owner.beforePublish({events:[{type:'session.inbox.delivered',data:{sessionID:f.sessionID,inboxID:f.messageID}}],pending:[{id:f.messageID,sessionID:f.sessionID,payloadHash:hash}],grant:{recoveredInputGrant:grant}})).rejects.toMatchObject({statusCode:409});
});
test('discard-only historical guarded reference retains proof and unrelated later events do not expire it',async()=>{
 const f=await fixture();f.add('msg_latest','latest original',2);f.setRecord({...f.record(),anchorID:'msg_latest',guardedIDs:[f.messageID]});const owner=f.owner();await owner.install('epoch');const snapshot=await owner.snapshot(f.sessionID);expect(snapshot.inputs[0].canResume).toBe(false);await owner.action(f.sessionID,'discard-input',f.scope(snapshot),{owner:null});
 expect(f.record().recoveredInputDispositions[0].phase).toBe('cancelled');expect(f.record().state).toBe('needs_attention');
 for(let index=0;index<140;index++)f.db.prepare('INSERT INTO event VALUES(?,?,?,?,?,?)').run('evt_later'+index,f.sessionID,index+200,100,'session.inbox.cancelled',JSON.stringify({sessionID:f.sessionID,inboxID:'msg_other'+index}));
 await f.write();const proofs=await verifyBundleRecoveredInputs(f.sql,f.root);expect(proofs.find(proof=>proof.id===f.messageID).paths).toEqual(['record.guardedIDs.0']);
 await expect(inspectBundleHarness(f.root,{sessionIDs:[f.sessionID],messageIDs:[],verifiedContinuations:proofs})).resolves.toBeDefined();
});

test('cancellation receipts bind accepted row and real event identity, and pin exact receipt bytes',async()=>{
 const f=await fixture(),owner=f.owner();await owner.install('epoch');await owner.action(f.sessionID,'discard-input',f.scope(await owner.snapshot(f.sessionID)),{owner:null});await f.write();
 const input={messageID:f.messageID,sessionID:f.sessionID,...f.record().recoveredInputDispositions[0]};
 const row=f.db.prepare('SELECT * FROM event').get(),data=JSON.parse(row.data),proofs=await verifyBundleRecoveredInputs(f.sql,f.root);
 expect(nativeInputCancellation(f.sql,input)).toMatchObject({eventID:'evt_cancel',seq:100});
 for(const change of [{enqueuedSeq:2},{payloadHash:'0'.repeat(64)},{delivery:'steer'},{type:'synthetic'},{nativeEvent:{...data.nativeEvent,seq:99}},{nativeEvent:{...data.nativeEvent,aggregateID:'ses_foreign'}}]){
  f.db.prepare('UPDATE event SET data=?').run(JSON.stringify({...data,...change}));expect(nativeInputCancellation(f.sql,input)).toBeNull();
 }
 f.db.prepare('UPDATE event SET data=?').run(JSON.stringify({...data,instanceID:'another-live-instance'}));expect(()=>assertBundlePendingInput(f.sql,proofs)).toThrow('migration_pending_input_unsupported');
 f.db.prepare('UPDATE event SET data=?').run(row.data);f.add(f.messageID,'reused ID',101);expect(nativeInputCancellation(f.sql,input)).toBeNull();
});

test('queued and cancelled fallback prompt aliases use only the exact validated owning occurrence',async()=>{
 const f=await fixture(),original=f.record(),execution={providerID:'saved',modelID:'read-only',agent:original.agent,variant:'default'};
 f.message('msg_anchor','user',1,{text:'original request'});f.message('msg_failed','assistant',2,{time:{created:100,completed:101},agent:original.agent,model:{providerID:original.providerID,id:original.modelID,variant:original.variant},content:[],finish:'stop'});
 f.db.prepare('UPDATE session_inbox SET enqueued_seq=? WHERE id=?').run(3,f.messageID);
 f.setRecord({...original,anchorID:'msg_anchor',stepID:'msg_failed',failedID:'msg_failed',requestedAt:100,instanceID:'fixture',recoveryID:f.messageID,attemptCount:1,guardedIDs:[f.messageID],
  nativeFallback:{stepID:'msg_failed',userMessageID:'msg_anchor',tried:['devryan-smoke/smoke-write'],exhaustion:0,execution},recoveryExecution:execution,
  recoveryPrompt:{messageID:f.messageID,agent:original.agent,model:{providerID:execution.providerID,modelID:execution.modelID},variant:execution.variant,parts:[{type:'text',text:'retained input'}],tools:{read:true,'*':false}}});
 await f.write();const canonical=['msg_anchor','msg_failed'],proofs=await verifyBundleRecoveredInputs(f.sql,f.root);
 await expect(inspectBundleHarness(f.root,{sessionIDs:[f.sessionID],messageIDs:canonical,verifiedContinuations:proofs})).resolves.toBeDefined();
 expect(proofs[0].paths).toEqual(['record.recoveryID','record.recoveryPrompt.messageID','record.guardedIDs.0']);
 expect(()=>assertBundlePendingInput(f.sql)).toThrow('migration_pending_input_unsupported');await expect(verifyBundleRecoveredInputs(f.sql,f.root,{cancelledOnly:true})).rejects.toMatchObject({code:'migration_pending_input_unsupported'});
 const valid=structuredClone(f.record());f.setRecord({...valid,recoveryPrompt:{...valid.recoveryPrompt,messageID:'msg_foreign'}});await f.write();await expect(verifyBundleRecoveredInputs(f.sql,f.root)).rejects.toMatchObject({code:'migration_pending_input_unsupported'});
 f.setRecord({...valid,recoveryExecution:undefined});await f.write();const unowned=await verifyBundleRecoveredInputs(f.sql,f.root);await expect(inspectBundleHarness(f.root,{sessionIDs:[f.sessionID],messageIDs:canonical,verifiedContinuations:unowned})).rejects.toMatchObject({code:'bundle_message_reference_lost'});
 f.setRecord({...valid,foreign:{recoveryPrompt:{messageID:f.messageID}}});await f.write();const borrowed=await verifyBundleRecoveredInputs(f.sql,f.root);await expect(inspectBundleHarness(f.root,{sessionIDs:[f.sessionID],messageIDs:canonical,verifiedContinuations:borrowed})).rejects.toMatchObject({code:'bundle_message_reference_lost'});
 f.setRecord(valid);await f.write();const context=path.join(f.root,'harness','context','borrow.json');await fs.mkdir(path.dirname(context),{recursive:true});await fs.writeFile(context,JSON.stringify({sessionID:f.sessionID,recoveryPrompt:{messageID:f.messageID}}));
 await expect(inspectBundleHarness(f.root,{sessionIDs:[f.sessionID],messageIDs:canonical,verifiedContinuations:await verifyBundleRecoveredInputs(f.sql,f.root)})).rejects.toMatchObject({code:'bundle_message_reference_lost'});await fs.rm(context);
 const owner=f.owner();await owner.install('epoch');await owner.action(f.sessionID,'discard-input',f.scope(await owner.snapshot(f.sessionID)),{owner:null});await f.write();
 const cancelled=await verifyBundleRecoveredInputs(f.sql,f.root,{cancelledOnly:true});expect(cancelled[0].cancellation.eventID).toBe('evt_cancel');expect(cancelled[0].paths).toEqual(['record.recoveryID','record.recoveryPrompt.messageID','record.guardedIDs.0']);
 await expect(inspectBundleHarness(f.root,{sessionIDs:[f.sessionID],messageIDs:canonical,verifiedContinuations:cancelled})).resolves.toBeDefined();expect(()=>assertBundlePendingInput(f.sql,cancelled)).not.toThrow();
});

 test('live fallback status proof spans durable adoption, preserves same-ID promotion and expires with its epoch',async()=>{
 const f=await fixture(),original=f.record(),execution={providerID:original.providerID,modelID:original.modelID,agent:original.agent,variant:original.variant};
 f.setRecord({...original,anchorID:'msg_anchor',stepID:'msg_failed',instanceID:'old',attemptCount:1,recoveryID:f.messageID,guardedIDs:[f.messageID],recoveryExecution:execution,
  recoveryPrompt:{messageID:f.messageID,agent:original.agent,model:{providerID:execution.providerID,modelID:execution.modelID},variant:execution.variant,parts:[{type:'text',text:'retained input'}],tools:{read:true,'*':false}}});
 const owner=f.owner();await owner.install('epoch');const scope=f.scope(await owner.snapshot(f.sessionID));
 expect(await owner.isRecoveryDispatchPending(f.record(),{itemHash:scope.payloadHash})).toBe(false);
 const old=f.record();f.setRecord({...old,instanceID:'epoch',state:'recovering'});
 expect(await owner.isRecoveryDispatchPending(f.record(),{itemHash:scope.payloadHash})).toBe(true);
 expect(await owner.isRecoveryDispatchPending(f.record(),{itemHash:'0'.repeat(64)})).toBe(false);
 f.db.prepare('UPDATE session_inbox SET payload=? WHERE id=?').run(JSON.stringify({text:'changed'}),f.messageID);
 expect(await owner.isRecoveryDispatchPending(f.record(),{itemHash:scope.payloadHash})).toBe(false);
 f.db.prepare('UPDATE session_inbox SET payload=? WHERE id=?').run(JSON.stringify({text:'retained input'}),f.messageID);f.setRecord(old);
 const entered=Promise.withResolvers(),gate=Promise.withResolvers(),adopt=f.primaryRuntime.adoptRecoveredInput;
 f.primaryRuntime.adoptRecoveredInput=async input=>{const record=await adopt(input);entered.resolve();await gate.promise;return record;};
 const action=owner.action(f.sessionID,'resume-input',scope,{owner:'fresh'});await entered.promise;
 expect(await owner.isRecoveryDispatchPending(f.record())).toBe(true);expect(f.calls()).toBe(0);
 gate.resolve();await action;expect(f.calls()).toBe(1);
 const adopted=f.record();
 for(const change of [{owner:'foreign'},{tools:{read:false}},{cancellationGeneration:2},{recoveryExecution:{...execution,modelID:'foreign'}}]){
  f.setRecord({...adopted,...change});expect(await owner.isRecoveryDispatchPending(f.record())).toBe(false);
 }
 f.setRecord(adopted);
 f.db.prepare('UPDATE session_v2 SET model=? WHERE id=?').run(JSON.stringify({providerID:execution.providerID,id:'changed',variant:'default'}),f.sessionID);
 expect(await owner.isRecoveryDispatchPending(f.record())).toBe(false);
 f.db.prepare('UPDATE session_v2 SET model=? WHERE id=?').run(JSON.stringify({providerID:execution.providerID,id:execution.modelID,variant:'default'}),f.sessionID);
 f.db.prepare('DELETE FROM session_inbox WHERE id=?').run(f.messageID);f.message(f.messageID,'user',2,{text:'retained input'});
 expect(await owner.isRecoveryDispatchPending(f.record())).toBe(true);
 f.message('msg_idle','idle',3,{outcome:'failed'});expect(await owner.isRecoveryDispatchPending(f.record())).toBe(false);
 f.setRecord({...f.record(),cancellationGeneration:2});expect(await owner.isRecoveryDispatchPending(f.record())).toBe(false);
 const replacement=f.owner();await replacement.install('replacement');expect(await replacement.isRecoveryDispatchPending(f.record(),{itemHash:scope.payloadHash})).toBe(false);
});
 test('failed adoption removes its preinstalled grant and a changed queued payload cannot retain status',async()=>{
 const f=await fixture(),owner=f.owner();await owner.install('epoch');const scope=f.scope(await owner.snapshot(f.sessionID));
 f.primaryRuntime.adoptRecoveredInput=async()=>{throw new Error('write_failed');};
 await expect(owner.action(f.sessionID,'resume-input',scope,{owner:null})).rejects.toThrow('write_failed');
 expect((await owner.snapshot(f.sessionID)).state).toBe('paused');expect(f.calls()).toBe(0);
});
