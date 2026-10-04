import {expect,test} from 'vitest';
import {createNativeAdmissionOwner} from './native-admission-owner.js';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function fixture({admit=async()=>{},uncertain=async()=>{},observeAcceptedUser,observeAcceptedUserGap,verifyQueuedPrimaryIdle,readQueuedPrimaryRecord,captureQueuedPrimaryAdmission}={}){
 const directory='/fixture/command-admission',sessionID='ses_command',messageID='msg_command';
 const definition={template:'Reviewed $ARGUMENTS',agent:'orchestrator',model:{providerID:'fixture',model:'saved'}};
 const session={id:sessionID,directory,agent:'orchestrator',model:{providerID:'fixture',id:'saved'}};
 let allowed=true,read=async()=>structuredClone(session),captureOwner='original',captures=0;
 const owner=createNativeAdmissionOwner({verifyQueuedPrimaryIdle,readQueuedPrimaryRecord,captureQueuedPrimaryAdmission,directory,ownerID:'bundle',observeAcceptedUser,observeAcceptedUserGap,reviewedConfiguration:{commands:{reviewed:definition},agents:{orchestrator:{mode:'primary'}}},
  runtime:{registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision:0,held:false})},getSession:()=>read(),authorizeOperation:async()=>{throw Error('unowned');},
  captureWebAuthorization:async()=>async()=>{if(!allowed)throw Object.assign(Error('revoked'),{code:'revoked'});},
  captureCommandPromptAdmission:async input=>{expect(input).toEqual({directory,sessionID});captures++;const original=captureOwner;return {admit:(receipt,recheck)=>admit(receipt,recheck,original),uncertain};}});
 const rpc=(method,input)=>owner.handleRpc(`native.admission.${method}`,input);
 const command=(action,delivery='steer')=>owner.withWebOperation({operation:'commands.execute',method:'POST',path:`/api/session/${sessionID}/command`,directory,body:{name:'reviewed',text:'original',delivery}},async()=>{
  const permit=JSON.parse(owner.requestHeaders()['x-devryan-native-permit']);
  const derivation=await rpc('beginCommand',{permit,sessionID,name:'reviewed',definition,model:{providerID:'fixture',id:'saved'},invocation:{sessionID,prompt:{text:'original'},delivery}});
  await rpc('authorize',{operation:'session.prompt',sessionID,existingPermit:permit,derivation,input:{id:messageID,sessionID,text:'Reviewed original',delivery}});
  const metadata=await rpc('sealPrompt',{permit,input:{sessionID,messageID,prompt:{text:'Hook prefix\nReviewed original'},delivery}});
  const item={id:messageID,sessionID,type:'user',delivery,payload:{text:'Hook prefix\nReviewed original',metadata}};
  return action({permit,item,verify:phase=>rpc('verifyAccepted',{permit,accepted:{item,phase}})});
 });
 return {owner,command,session,rpc,setAllowed:value=>{allowed=value;},setRead:value=>{read=value;},setCaptureOwner:value=>{captureOwner=value;},captures:()=>captures};
}

test('sealed command reserves once before publication with original owner and actual default selection',async()=>{
 const receipts=[],owners=[],uncertain=[];
 const f=fixture({admit:async(receipt,recheck,owner)=>{await recheck();receipts.push(receipt);owners.push(owner);},uncertain:async receipt=>{uncertain.push(receipt);}});
 try{await f.command(async({item,verify})=>{
  f.setCaptureOwner('later caller');
  await Promise.all([verify('preflight'),verify('preflight')]);
  expect(receipts).toHaveLength(1);expect(owners).toEqual(['original']);
  expect(receipts[0]).toEqual({sessionID:item.sessionID,messageID:item.id,directory:f.session.directory,
   execution:{agent:'orchestrator',providerID:'fixture',modelID:'saved',variant:'default'},
   body:{messageID:item.id,agent:'orchestrator',model:{providerID:'fixture',modelID:'saved'},variant:'default',parts:[{type:'text',text:'Reviewed original'}]}});
  await verify('committed');await verify('committed');expect(receipts).toHaveLength(1);
 });expect(f.captures()).toBe(1);expect(uncertain).toEqual([]);}finally{f.owner.dispose();}
});

test('caller revocation during canonical or admission reads refuses effects and binds uncertainty to this receipt',async()=>{
 for(const stage of ['canonical','admission']){
  const entered=deferred(),release=deferred(),receipts=[],uncertain=[];
  const f=fixture({admit:async(receipt,recheck)=>{entered.resolve();await release.promise;await recheck();receipts.push(receipt);},uncertain:async receipt=>{uncertain.push(receipt);}});
  let woke=false;
  try{const work=f.command(async({verify})=>{
   if(stage==='canonical')f.setRead(async()=>{entered.resolve();await release.promise;return structuredClone(f.session);});
   await verify('preflight');woke=true;
  });const failed=expect(work).rejects.toMatchObject({code:'revoked'});
   await entered.promise;f.setAllowed(false);release.resolve();await failed;
   expect(woke).toBe(false);expect(receipts).toEqual([]);expect(uncertain.map(row=>row.messageID)).toEqual(stage==='admission'?['msg_command']:[]);
  }finally{release.resolve();f.owner.dispose();}
 }
});

test('lost publication ACK and changed committed tuple mark only the exact attempted command uncertain',async()=>{
 for(const stage of ['publication','selection']){
  const uncertain=[];const f=fixture({uncertain:async receipt=>{uncertain.push(receipt);}});
  try{await expect(f.command(async({verify})=>{await verify('preflight');
   if(stage==='publication')throw Object.assign(Error('lost_ack'),{code:'lost_ack'});
   f.session.model={providerID:'fixture',id:'changed'};await verify('committed');
  })).rejects.toMatchObject({code:stage==='publication'?'lost_ack':'native_command_selection_unreviewed'});
   expect(uncertain.map(row=>[row.sessionID,row.messageID,row.execution.modelID])).toEqual([['ses_command','msg_command','saved']]);
  }finally{f.owner.dispose();}
 }
});

test('committed observations preserve explicit variant presence without leaking prompt data or creating command defaults',async()=>{
 const observations=[];const f=fixture({observeAcceptedUser:async row=>{observations.push(row);}});
 try{
  await f.command(async({verify})=>{await verify('preflight');expect(observations).toEqual([]);await verify('committed');await verify('committed');});
  expect(observations).toHaveLength(1);
  expect(observations[0].intent).toEqual({source:'command-definition',agent:'orchestrator',model:{providerID:'fixture',modelID:'saved'},variantPresent:false});
  expect(observations[0].execution.variant).toBe('default');
  for(const variant of [undefined,null,'']){
   const messageID=`msg_prompt${observations.length}`,fingerprint='a'.repeat(64),metadata={devryan:{admission:{fingerprint}}};
   const intent={agent:'orchestrator',model:{providerID:'fixture',modelID:'saved'},...(variant===undefined?{}:{variant})};
   await f.owner.withAcceptedOperation({sessionID:f.session.id,messageID,fingerprint,metadata,intent,request:{text:'private prompt bytes'}},async()=>{
    const permit=JSON.parse(f.owner.requestHeaders()['x-devryan-native-permit']);
    const sealed=await f.rpc('sealPrompt',{permit,input:{sessionID:f.session.id,messageID,prompt:{text:'private prompt bytes'}}});
    const item={id:messageID,sessionID:f.session.id,type:'user',payload:{text:'private prompt bytes',metadata:sealed}};
    await f.rpc('verifyAccepted',{permit,accepted:{item,phase:'preflight'}});
    await f.rpc('verifyAccepted',{permit,accepted:{item,phase:'committed'}});
    await f.rpc('verifyAccepted',{permit,accepted:{item,phase:'committed'}});
   });
   expect(observations.at(-1).intent).toEqual({source:'prompt',agent:'orchestrator',model:{providerID:'fixture',modelID:'saved'},variantPresent:variant!==undefined,...(variant===undefined?{}:{variant})});
  }
  expect(observations).toHaveLength(4);expect(JSON.stringify(observations)).not.toContain('private prompt bytes');expect(JSON.stringify(observations)).not.toContain('Reviewed original');
 }finally{f.owner.dispose();}
});

test('optional evidence failures report one finite gap while original authority checks remain strict',async()=>{
 const gaps=[];let observed=0;
 const f=fixture({observeAcceptedUser:async()=>{observed++;throw Error('Private evidence failure');},observeAcceptedUserGap:async gap=>{gaps.push(gap);}});
 try{await f.command(async({item,verify})=>{
  await verify('preflight');await verify('committed');await verify('committed');
  expect(observed).toBe(1);expect(gaps).toEqual([{code:'native_observation_gap',phase:'accepted',sessionID:item.sessionID,messageID:item.id,directory:f.session.directory}]);
  f.setAllowed(false);await expect(verify('committed')).rejects.toMatchObject({code:'revoked'});
 });}finally{f.owner.dispose();}
});


test('a failed optional gap sink cannot turn missing evidence into an admission refusal',async()=>{
 const f=fixture({observeAcceptedUser:async()=>{throw Error('Evidence unavailable');},observeAcceptedUserGap:()=>{throw Error('Gap sink unavailable');}});
 try{await f.command(async({verify})=>{await verify('preflight');await verify('committed');});}finally{f.owner.dispose();}
});


test('queued commands check authoritative idle before selection and keep steer unchanged',async()=>{
 let checks=0,selected=0,busy=true;
 const f=fixture({verifyQueuedPrimaryIdle:async input=>{
  checks++;expect(input.messageID).toBeUndefined();
  await f.rpc('authorize',{operation:'queued.input.inspect',sessionID:f.session.id,existingPermit:input.permit});
  if(busy)throw Object.assign(Error('busy'),{code:'native_queued_input_blocked'});
 }});
 try{
  await expect(f.owner.withCommandSelection({sessionID:f.session.id,delivery:'queue'},async()=>{selected++;})).rejects.toMatchObject({code:'native_queued_input_blocked'});
  expect(selected).toBe(0);busy=false;
  await f.owner.withCommandSelection({sessionID:f.session.id,delivery:'queue'},async()=>{selected++;});
  await f.owner.withCommandSelection({sessionID:f.session.id,delivery:'steer'},async()=>{selected++;});
  expect(checks).toBe(2);expect(selected).toBe(2);
 }finally{f.owner.dispose();}
});

test('sealed queued command admits its exact primary only after enqueue and runs once',async()=>{
 let calls=0,current=null;
 const f=fixture({captureQueuedPrimaryAdmission:async()=>async()=>{},readQueuedPrimaryRecord:async()=>current,
  admit:async(receipt,recheck,owner)=>{await recheck();expect(owner).toBe('original');calls++;current={...receipt.execution,executionGeneration:2,directory:receipt.directory,anchorID:receipt.messageID,state:'observing'};}});
 try{await f.command(async({item,verify})=>{
  const input={sessionID:item.sessionID,messageID:item.id,directory:f.session.directory,item:{type:item.type,delivery:item.delivery,payload:item.payload}};
  await Promise.all([verify('preflight'),verify('preflight')]);
  expect(calls).toBe(0);expect(current).toBeNull();
  expect(item.payload.metadata.devryan.origin).toBe('native');expect(item.payload.metadata.devryan.command.name).toBe('reviewed');
  await expect(f.rpc('queuedAdmissionCommitted',{...input,item:{...input.item,payload:{...input.item.payload,text:'changed'}}})).rejects.toMatchObject({code:'native_queued_admission_unverified'});
  await Promise.all([f.rpc('queuedAdmissionCommitted',input),f.rpc('queuedAdmissionCommitted',input)]);
  await f.rpc('queuedDeliveryAuthorized',{...input,execution:{agent:'orchestrator',providerID:'fixture',modelID:'saved',variant:'default'}});
  await verify('committed');await verify('committed');expect(calls).toBe(1);
 },'queue');}finally{f.owner.dispose();}
});

test('queued command callback rejection retains prior primary and exact cancellation guard',async()=>{
 for(const mode of ['reject','cancel']){
  let calls=0,allowed=true,current={anchorID:'msg_old',state:'observing'};
  const f=fixture({captureQueuedPrimaryAdmission:async()=>async()=>{if(!allowed)throw Object.assign(Error('Stop'),{code:'provider_recovery_fenced'});},
   readQueuedPrimaryRecord:async()=>current,admit:async(_receipt,recheck)=>{calls++;if(mode==='reject')throw Object.assign(Error('Refused'),{code:'callback_refused'});await recheck();current={anchorID:'msg_wrong'};}});
  try{await f.command(async({item,verify})=>{
   await verify('preflight');expect(calls).toBe(0);
   if(mode==='cancel')allowed=false;
   const input={sessionID:item.sessionID,messageID:item.id,directory:f.session.directory,item:{type:item.type,delivery:item.delivery,payload:item.payload}};
   await expect(f.rpc('queuedAdmissionCommitted',input)).rejects.toMatchObject({code:mode==='reject'?'callback_refused':'provider_recovery_fenced'});
   await expect(f.rpc('queuedDeliveryAuthorized',input)).rejects.toThrow();
   expect(current).toEqual({anchorID:'msg_old',state:'observing'});
  },'queue');}finally{f.owner.dispose();}
 }
});
