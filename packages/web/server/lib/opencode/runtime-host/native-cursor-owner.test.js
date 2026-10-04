import {expect,test} from 'vitest';
import {createNativeAdmissionOwner} from './native-admission-owner.js';
import {createNativeCursorOwner} from './native-cursor-owner.js';
import {credentialMutationFingerprint as fingerprint} from './native-credential-mutation-owner.js';
import {parseNativeCommand,encodeNativeProcessMessage,NATIVE_PROCESS_LIMITS} from './native-process-protocol.js';

test('Cursor retains admitted caller after 204, verifies native record scope and waits actual process publication',async()=>{
 const scope={directory:'/fixture/cursor',sessionID:'ses_cursor',userMessageID:'msg_user',assistantMessageID:'msg_assistant',agent:'build',modelID:'composer',variant:'default'};
 let allowed=true,revision=0,lease,tracked=0;const calls=[];
 const runtime={registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision,held:false}),
  leaseForCall:async()=>lease,capturedSessionState:async()=>({captured:true,pending:false,generation:1})};
 const native=createNativeAdmissionOwner({directory:scope.directory,ownerID:'fixture',runtime,
  getSession:async id=>({id,directory:scope.directory,agent:'build',model:{providerID:'cursor-acp',id:'composer',variant:'default'}}),
  authorizeOperation:async()=>{throw Error('unowned');},captureWebAuthorization:async()=>async()=>{if(!allowed)throw Error('revoked');}});
 const accepted={sessionID:scope.sessionID,messageID:scope.userMessageID,fingerprint:'a'.repeat(64),
  metadata:{devryan:{v:1,origin:'human',agent:'build',providerID:'cursor-acp',modelID:'composer',planMode:false,parts:[{kind:'text',length:7}],admission:{v:1,fingerprint:'a'.repeat(64)}}}};
 const request={id:scope.userMessageID,text:'fixture',metadata:accepted.metadata,delivery:'queue'};
 const controller={instanceID:'fixture',call:async command=>{
  const value=parseNativeCommand({...command,protocol:1,id:'record_request'});calls.push(value);
  if(value.action==='cursor-settle-owned'){
   const {action:_action,protocol:_protocol,id:_id,...input}=value;await owner.assertSettlement(input);
   await expect(owner.assertSettlement({...input,assistantMessageID:'msg_other'})).rejects.toMatchObject({code:'native_cursor_settlement_invalid'});return null;
  }
  const {action:_action,protocol:_protocol,id:_id,record,accepted:_accepted,...auth}=value;
  await owner.assertRecord({...auth,recordFingerprint:fingerprint(record)});
  await expect(owner.assertRecord({...auth,recordFingerprint:'0'.repeat(64)})).rejects.toMatchObject({code:'native_cursor_record_scope_invalid'});
  return {messageID:record.info.id};
 }};
 const owner=createNativeCursorOwner({instanceID:'fixture',admissionOwner:native,runtime,controller:()=>controller,isReady:()=>true,abortAndWait:async()=>{},
  onStarted:async(input,recheck)=>{expect(input.userMessageID).toBe(scope.userMessageID);await recheck();tracked++;}});
 const makeRecord=(role,complete=false)=>({info:{id:role==='user'?scope.userMessageID:scope.assistantMessageID,sessionID:scope.sessionID,role,
  ...(role==='assistant'?{parentID:scope.userMessageID}:{}),providerID:'cursor-acp',modelID:scope.modelID,agent:scope.agent,variant:'default',time:{created:1,...complete?{completed:2}:{}}},parts:[]});
 const persist=record=>owner.persist({sessionID:scope.sessionID,directory:scope.directory,record});
 let owned,terminal,resolveProcess;
 const processResult=new Promise(resolve=>{resolveProcess=resolve;});
 try{
  await expect(persist(makeRecord('user'))).rejects.toMatchObject({code:'native_cursor_grant_required'});
  await native.withAcceptedOperation({...accepted,request:{text:'fixture'}},async()=>{
   native.updateAcceptedOperation({metadata:accepted.metadata,request});
   await expect(native.captureCursorAuthorization({...scope,modelID:'foreign'})).rejects.toMatchObject({code:'native_cursor_scope_invalid'});
   owned=await owner.ownedPrompt(scope);
   await owned.run(async()=>{
    await persist(makeRecord('user'));await persist(makeRecord('assistant'));expect(tracked).toBe(1);
    await owner.withExecution({directory:scope.directory,sessionID:scope.sessionID,messageID:scope.userMessageID,assistantMessageID:scope.assistantMessageID},async()=>{
     lease={token:'lease_cursor',generation:1,state:'ready',executionKind:'process',scope:{sessionID:scope.sessionID,userMessageID:scope.userMessageID,messageID:scope.assistantMessageID,callID:`cursor_${scope.assistantMessageID}`}};
     return {lease,result:processResult};
    });
    terminal=persist(makeRecord('assistant',true));return 204;
   });
  });
  await Promise.resolve();expect(calls).toHaveLength(2);
  lease.state='published';resolveProcess({terminated:true,confined:true});await terminal;expect(calls).toHaveLength(3);
  await owned.close();expect(tracked).toBe(1);
  const last=calls.findLast(row=>row.action==='cursor-record-owned'),{record,accepted:_accepted,action:_action,protocol:_protocol,id:_id,...auth}=last;
  await expect(owner.assertRecord({...auth,recordFingerprint:fingerprint(record)})).rejects.toMatchObject({code:'native_cursor_record_scope_invalid'});
  let captured;
  await native.withAcceptedOperation({...accepted,request},async()=>{captured=await native.captureCursorAuthorization(scope);});
  await captured.recheck();allowed=false;await expect(captured.recheck()).rejects.toThrow('revoked');allowed=true;
  revision++;await expect(captured.recheck()).rejects.toMatchObject({code:'native_cursor_scope_revoked'});revision--;
  await native.invalidateController();await expect(captured.recheck()).rejects.toMatchObject({code:'native_permit_revoked'});
 }finally{resolveProcess({terminated:true,confined:true});await terminal?.catch(()=>{});await owned?.close();await owner.close();native.dispose();}
});

test('only private Cursor record commands can carry bounded cumulative transcripts beyond ordinary command limit',()=>{
 const value={protocol:1,id:'record_request',action:'cursor-record-owned',controllerInstanceID:'fixture',directory:'/fixture/cursor',sessionID:'ses_cursor',userMessageID:'msg_user',assistantMessageID:'msg_assistant',agent:'build',modelID:'composer',
  permit:{token:'a'.repeat(64),sessionID:'ses_cursor',revision:0},accepted:{id:'msg_user',text:'hello',metadata:{},delivery:'queue'},
  record:{info:{id:'msg_assistant',parentID:'msg_user',sessionID:'ses_cursor',role:'assistant'},parts:[{id:'prt_long',type:'text',text:'x'.repeat(NATIVE_PROCESS_LIMITS.messageBytes)}]}};
 expect(parseNativeCommand(value)).toEqual(value);expect(encodeNativeProcessMessage(value).length).toBeGreaterThan(NATIVE_PROCESS_LIMITS.messageBytes);
 expect(()=>parseNativeCommand({...value,record:{...value.record,info:{...value.record.info,parentID:'msg_other'}}})).toThrow();
 expect(()=>parseNativeCommand({...value,untrusted:true})).toThrow();
 expect(()=>parseNativeCommand({...value,action:'hold'})).toThrow();
});

test('held Cursor cleanup waits for the real receipt and refuses an unsettled process',async()=>{
 for(const confirmed of [true,false]){
  const scope={directory:'/fixture/cursor',sessionID:'ses_cursor',userMessageID:'msg_user',assistantMessageID:'msg_assistant',agent:'build',modelID:'composer'};
  let held=false,settled=0;
  const lease={token:'cursor_lease',generation:1,state:'ready',executionKind:'process',scope:{sessionID:scope.sessionID,userMessageID:scope.userMessageID,messageID:scope.assistantMessageID,callID:`cursor_${scope.assistantMessageID}`}};
  const process=Promise.withResolvers();
  const owner=createNativeCursorOwner({instanceID:'fixture',isReady:()=>true,
   admissionOwner:{captureCursorAuthorization:async()=>({accepted:{},revision:0,recheck:async()=>{if(held)throw Error('held');}})},
   runtime:{leaseForCall:async()=>lease,capturedSessionState:async()=>({captured:true,pending:false,generation:1})},
   controller:()=>({instanceID:'fixture',call:async({action,...input})=>{
    expect(action).toBe('cursor-settle-owned');await owner.assertSettlement(input);settled++;
   }}),abortAndWait:async()=>{},onStarted:async()=>{},
  });
  const owned=await owner.ownedPrompt(scope);
  await owned.run(()=>owner.withExecution({directory:scope.directory,sessionID:scope.sessionID,messageID:scope.userMessageID,assistantMessageID:scope.assistantMessageID},async()=>({lease,result:process.promise})));
  held=true;
  const cleanup=owned.close();void cleanup.catch(()=>{});
  await Promise.resolve();expect(settled).toBe(0);
  lease.state='cancelled';process.reject(Object.assign(Error('receipt outcome'),{code:confirmed?'execution_cancelled':'termination_unknown'}));
  if(confirmed){await cleanup;expect(settled).toBe(1);}
  else{await expect(cleanup).rejects.toMatchObject({code:'native_cursor_termination_unconfirmed',nativeProcessUnsettled:true});expect(settled).toBe(0);}
  await owner.close();
 }
});

test('Cursor rejected cancellation settles startup and retains uncertainty; concurrent capture cannot replace a grant',async()=>{
 const scope={directory:'/fixture/cursor',sessionID:'ses_cursor',userMessageID:'msg_user',assistantMessageID:'msg_assistant',agent:'build',modelID:'composer'};
 const captured=Promise.withResolvers();let allowed=true;
 const lease={token:'cursor_lease',generation:1,state:'ready',executionKind:'process',scope:{sessionID:scope.sessionID,userMessageID:scope.userMessageID,messageID:scope.assistantMessageID,callID:`cursor_${scope.assistantMessageID}`}};
 const owner=createNativeCursorOwner({instanceID:'fixture',isReady:()=>true,
  admissionOwner:{captureCursorAuthorization:async()=>{await captured.promise;return {accepted:{},revision:0,recheck:async()=>{if(!allowed)throw Error('revoked');}};}},
  runtime:{leaseForCall:async()=>lease,capturedSessionState:async()=>({captured:true,pending:false,generation:1})},
  controller:()=>({instanceID:'fixture',call:async()=>{throw Error('unreachable');}}),abortAndWait:async()=>{},onStarted:async()=>{},
 });
 const first=owner.ownedPrompt(scope),second=owner.ownedPrompt(scope);captured.resolve();
 const owned=await first;await expect(second).rejects.toMatchObject({code:'native_cursor_scope_invalid'});
 await expect(owned.run(()=>owner.withExecution({directory:scope.directory,sessionID:scope.sessionID,messageID:scope.userMessageID,assistantMessageID:scope.assistantMessageID},async()=>{
  allowed=false;return {lease,result:Promise.resolve(),cancel:async()=>{throw Object.assign(Error('unconfirmed'),{nativeProcessUnsettled:true});}};
 }))).rejects.toMatchObject({message:'native_cursor_start_cleanup_failed',nativeProcessUnsettled:true});
 await expect(owned.close()).rejects.toMatchObject({nativeProcessUnsettled:true});
 await owner.close();
});

test('Cursor owner cleanup waits for every grant after another abort fails',async()=>{
 const scope={directory:'/fixture/cursor',sessionID:'ses_first',userMessageID:'msg_user',assistantMessageID:'msg_assistant',agent:'build',modelID:'composer'};
 const secondSettlement=Promise.withResolvers();let finished=false;
 const owner=createNativeCursorOwner({instanceID:'fixture',isReady:()=>true,
  admissionOwner:{captureCursorAuthorization:async()=>({accepted:{},revision:0,recheck:async()=>{}})},
  runtime:{},controller:()=>({instanceID:'fixture',call:async input=>{if(input.sessionID==='ses_second')await secondSettlement.promise;}}),
  abortAndWait:async sessionID=>{if(sessionID==='ses_first')throw Error('abort failed');},onStarted:async()=>{},
 });
 const first=await owner.ownedPrompt(scope),second=await owner.ownedPrompt({...scope,sessionID:'ses_second'});
 const cleanup=owner.close();void cleanup.catch(()=>{});cleanup.finally(()=>{finished=true;}).catch(()=>{});
 await first.close();const remaining=second.close();await Promise.resolve();expect(finished).toBe(false);
 secondSettlement.resolve();await remaining;await expect(cleanup).rejects.toMatchObject({message:'native_cursor_cleanup_failed'});
 expect(finished).toBe(true);
});

test('Cursor selected account changes before process start are refused without executing',async()=>{
 const scope={directory:'/fixture/cursor',sessionID:'ses_cursor',userMessageID:'msg_user',assistantMessageID:'msg_assistant',agent:'build',modelID:'composer'};
 let account='a',started=0,checks=0,lastInput;
 const owner=createNativeCursorOwner({instanceID:'fixture',isReady:()=>true,
  admissionOwner:{captureCursorAuthorization:async()=>({accepted:{},revision:0,recheck:async()=>{checks++;}})},
  runtime:{},controller:()=>({instanceID:'fixture',call:async({action,...input})=>{
   if(action==='cursor-key-owned'){lastInput=input;await owner.assertKey(input);return {key:`synthetic-${account}`,credentialID:`cred_${account}`,expectedFingerprint:account.repeat(64)};}
   if(action==='cursor-settle-owned'){await owner.assertSettlement(input);return null;}
   throw Error('Unexpected private command');
  }}),abortAndWait:async()=>{},onStarted:async()=>{},
 });
 const owned=await owner.ownedPrompt(scope);
 try{
  await owned.run(async()=>{
   expect(await owner.resolveApiKey({kind:'prompt',...scope})).toBe('synthetic-a');
   await expect(owner.assertKey(lastInput)).rejects.toMatchObject({code:'native_cursor_key_scope_invalid'});
   account='b';
   await expect(owner.withExecution({directory:scope.directory,sessionID:scope.sessionID,messageID:scope.userMessageID,assistantMessageID:scope.assistantMessageID},async()=>{
    started++;throw Error('Must not start');
   })).rejects.toMatchObject({code:'native_cursor_credential_changed'});
  });
  expect(started).toBe(0);expect(checks).toBeGreaterThan(4);
 }finally{await owned.close();await owner.close();}
});

test('Cursor readonly keys retain the original grant and refuse scope mismatch, replay and account change',async()=>{
 let account='a',allowed=true,checks=0,lastInput;
 const owner=createNativeCursorOwner({instanceID:'fixture',isReady:()=>true,
  admissionOwner:{},runtime:{},controller:()=>({instanceID:'fixture',call:async({action,...input})=>{
   expect(action).toBe('cursor-readonly-key-owned');lastInput=input;await owner.assertReadOnlyKey(input);
   return {key:`synthetic-${account}`,credentialID:`cred_${account}`,expectedFingerprint:account.repeat(64)};
  }}),abortAndWait:async()=>{},onStarted:async()=>{},
 });
 const scope={kind:'title',directory:'/fixture/cursor',sessionID:'ses_cursor'},captured={revision:2,recheck:async()=>{checks++;if(!allowed)throw Error('original principal revoked');}};
 try{
  await expect(owner.resolveApiKey(scope)).rejects.toMatchObject({code:'native_cursor_readonly_scope_required'});
  await owner.withReadOnly(scope,captured,async()=>{
   expect(await owner.resolveApiKey(scope)).toBe('synthetic-a');
   await expect(owner.assertReadOnlyKey(lastInput)).rejects.toMatchObject({code:'native_cursor_readonly_scope_required'});
   await expect(owner.resolveApiKey({...scope,sessionID:'ses_foreign'})).rejects.toMatchObject({code:'native_cursor_readonly_scope_required'});
   account='b';await expect(owner.beforeReadOnlyExecution()).rejects.toMatchObject({code:'native_cursor_credential_changed'});
  });
  allowed=false;await expect(owner.withReadOnly(scope,captured,async()=>{throw Error('Must not run');})).rejects.toThrow('original principal revoked');
  expect(checks).toBeGreaterThan(5);
 }finally{await owner.close();}
});

test('readonly shutdown cancels accepted handles and waits their confined receipts before closing',async()=>{
 let resolveReceipt,started,cancelled=0,closed=false;
 const ready=new Promise(resolve=>{started=resolve;});
 const receipt=new Promise(resolve=>{resolveReceipt=resolve;});
 const owner=createNativeCursorOwner({instanceID:'fixture',isReady:()=>true,admissionOwner:{},runtime:{},
  controller:()=>({instanceID:'fixture',call:async({action,...input})=>{
   expect(action).toBe('cursor-readonly-key-owned');await owner.assertReadOnlyKey(input);
   return {key:'synthetic',credentialID:'cred_owned',expectedFingerprint:'a'.repeat(64)};
  }}),abortAndWait:async()=>{},onStarted:async()=>{}});
 const work=owner.withReadOnly({kind:'title',directory:'/fixture',sessionID:'ses_owned'},{revision:0,recheck:async()=>{}},async()=>{
  const handle=await owner.withReadOnlyExecution(async()=>({result:receipt,cancel:()=>{cancelled++;}}));started();
  const result=await handle.result;if(result.cancelled)throw Object.assign(Error('Interrupted'),{code:'execution_cancelled'});
 });
 const rejection=expect(work).rejects.toMatchObject({code:'execution_cancelled'});
 try{
  await ready;const first=owner.close();expect(owner.close()).toBe(first);const close=first.then(()=>{closed=true;});
  await new Promise(resolve=>setImmediate(resolve));expect(cancelled).toBe(1);expect(closed).toBe(false);
  resolveReceipt({terminated:true,confined:true,cancelled:true});await rejection;await close;expect(closed).toBe(true);
 }finally{resolveReceipt({terminated:true,confined:true,cancelled:true});await work.catch(()=>{});await owner.close();}
});

test('readonly shutdown reports uncertain termination even when the callback already rejected',async()=>{
 let started;const ready=new Promise(resolve=>{started=resolve;});
 const owner=createNativeCursorOwner({instanceID:'fixture',isReady:()=>true,admissionOwner:{},runtime:{},
  controller:()=>({instanceID:'fixture',call:async({action,...input})=>{
   expect(action).toBe('cursor-readonly-key-owned');await owner.assertReadOnlyKey(input);
   return {key:'synthetic',credentialID:'cred_owned',expectedFingerprint:'a'.repeat(64)};
  }}),abortAndWait:async()=>{},onStarted:async()=>{}});
 let rejectReceipt;const result=new Promise((_resolve,reject)=>{rejectReceipt=reject;});
 const work=owner.withReadOnly({kind:'title',directory:'/fixture',sessionID:'ses_owned'},{revision:0,recheck:async()=>{}},async()=>{
  await owner.withReadOnlyExecution(async()=>({result,cancel:()=>{rejectReceipt(Error('receipt unavailable'));throw Error('cancel uncertain');}}));
  started();await result;
 });
 const workError=expect(work).rejects.toMatchObject({nativeProcessUnsettled:true});
 await ready;const close=owner.close();expect(owner.close()).toBe(close);
 await expect(close).rejects.toMatchObject({message:'native_cursor_cleanup_failed'});await workError;
 await expect(owner.close()).rejects.toMatchObject({message:'native_cursor_cleanup_failed'});
});
