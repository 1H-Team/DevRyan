import {expect,it} from 'vitest';
import {createNativeAdmissionOwner} from './native-admission-owner.js';
import {buildV2PromptContent} from '../v2/admission.js';
import {recoveredInputHash} from './native-recovered-input-hash.js';

const scope={sessionID:'ses_root',directory:'/fixture/project',messageID:'msg_todo'};
const prompt={messageID:scope.messageID,agent:'orchestrator',model:{providerID:'fixture',modelID:'m1'},variant:'default',
 tools:{},objectiveID:'msg_original',parts:[{type:'text',synthetic:true,text:'Continue the existing open TODO.'}]};
it('recovery dispatch binds the frozen fallback, original file bytes and deny-all read-only rules',async()=>{
 const recovery={...prompt,objectiveID:undefined,model:{providerID:'fallback',modelID:'m2'},tools:{'*':false,read:true},
  parts:[{type:'text',text:'Original request'},{type:'file',mime:'image/png',filename:'input.png',url:'data:image/png;base64,UE5H'}]};
 let live=true;const acceptedItems=[];
 const owner=createNativeAdmissionOwner({directory:scope.directory,ownerID:'fixture',runtime:{registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision:0,held:false})},
  getSession:async id=>({id,directory:scope.directory}),authorizeOperation:async()=>{throw Error('must use captured recovery');},
  bindNativeRecoveryDispatchInput:input=>acceptedItems.push(input),
  verifyPrimaryRecoveryDispatch:async()=>({record:{sessionID:scope.sessionID,directory:scope.directory,recoveryID:scope.messageID},prompt:recovery,recheck:async()=>{if(!live)throw Error('revoked');}})});
 const content=buildV2PromptContent(recovery.parts),accepted={sessionID:scope.sessionID,messageID:scope.messageID,fingerprint:'a'.repeat(64),intent:recovery,
  request:{text:content.text},metadata:{devryan:{parts:content.segments}}};
 const run=action=>owner.withPrimaryRecoveryDispatch(scope,()=>owner.withAcceptedOperation(accepted,action));
 const effect=async(operation,body,action)=>owner.withWebOperation({operation,method:operation==='setPermissions'?'PATCH':'POST',path:`/api/session/${scope.sessionID}${operation==='switchModel'?'/model':''}`,body},async()=>{
  const permit=JSON.parse(owner.requestHeaders()['x-devryan-native-permit']);return owner.handleRpc('native.admission.authorize',{operation:action,sessionID:scope.sessionID,input:{sessionID:scope.sessionID,...body},existingPermit:permit});});
 try{
  await run(async()=>{
   await expect(effect('switchModel',{model:{id:'m2',providerID:'fallback',variant:'default'}},'session.switchModel')).resolves.toMatchObject({sessionID:scope.sessionID});
   await expect(effect('switchModel',{model:{id:'wrong',providerID:'fallback',variant:'default'}},'session.switchModel')).rejects.toMatchObject({code:'native_primary_recovery_selection_changed'});
   await expect(effect('setPermissions',{permissions:[{action:'*',resource:'*',effect:'deny'},{action:'read',resource:'*',effect:'allow'}]},'session.setPermissions')).resolves.toMatchObject({sessionID:scope.sessionID});
   await expect(effect('setPermissions',{permissions:[{action:'*',resource:'*',effect:'deny'},{action:'edit',resource:'*',effect:'allow'}]},'session.setPermissions')).rejects.toMatchObject({code:'native_primary_recovery_permissions_changed'});
   const metadata={devryan:{admission:{fingerprint:accepted.fingerprint},agent:recovery.agent,providerID:'fallback',modelID:'m2',variant:'default'}};
   owner.updateAcceptedOperation({metadata,request:{text:content.text,files:content.files}});
   const permit=JSON.parse(owner.requestHeaders()['x-devryan-native-permit']);
   const item={id:scope.messageID,sessionID:scope.sessionID,type:'user',delivery:'queue',payload:{text:content.text,
    files:[{data:'UE5H',mime:'image/png',source:{type:'inline'},name:'input.png'}],metadata}};
   await owner.handleRpc('native.admission.verifyAccepted',{permit,accepted:{phase:'preflight',item}});expect(acceptedItems).toHaveLength(0);
   await owner.handleRpc('native.admission.verifyAccepted',{permit,accepted:{phase:'committed',item}});
   expect(acceptedItems).toEqual([{sessionID:scope.sessionID,messageID:scope.messageID,itemHash:recoveredInputHash({type:item.type,delivery:item.delivery,payload:item.payload})}]);
   expect(()=>owner.updateAcceptedOperation({metadata,request:{text:content.text,files:[{uri:'data:image/png;base64,Rk9SR0VE'}]}})).toThrow('native_primary_continuation_payload_changed');
  });
  await expect(owner.withPrimaryRecoveryDispatch(scope,()=>owner.withAcceptedOperation({...accepted,intent:{...recovery,tools:{'*':true}}},async()=>{}))).rejects.toMatchObject({code:'native_primary_continuation_payload_changed'});
  live=false;await expect(run(async()=>{})).rejects.toThrow('revoked');
 }finally{owner.dispose();}
});
function fixture(){
 let allowed=true,held=false,checks=0,pause;
 const recheck=async()=>{checks++;await pause?.();if(!allowed)throw Object.assign(Error('revoked'),{code:'revoked'});};
 const owner=createNativeAdmissionOwner({directory:scope.directory,ownerID:'owned-bundle',
  runtime:{registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision:held?1:0,held,reverting:false})},
  getSession:async id=>({id,directory:scope.directory}),withSessionLock:(_id,action)=>action(),
  authorizeOperation:async()=>{throw Error('generic authority must not grant this continuation');},
  captureWebAuthorization:async()=>{throw Error('a background delivery must preserve its original grant');},
  verifyPrimaryContinuationDispatch:async input=>{if(JSON.stringify(input)!==JSON.stringify(scope))throw Error('scope mismatch');
   return {record:{sessionID:scope.sessionID,directory:scope.directory,continuationID:scope.messageID},prompt,recheck};}});
 const accepted={sessionID:scope.sessionID,messageID:scope.messageID,fingerprint:'a'.repeat(64),
  metadata:{devryan:{objectiveID:prompt.objectiveID,parts:prompt.parts.map(part=>({kind:'synthetic',length:part.text.length}))}},
  request:{text:prompt.parts[0].text}};
 return {owner,accepted,revoke:()=>{allowed=false;},hold:()=>{held=true;},pause:value=>{pause=value;},checks:()=>checks};
}
it('binds a private original objective to accepted prompt transport and forbids selection changes',async()=>{
 const f=fixture();
 await f.owner.withPrimaryContinuationDispatch(scope,()=>f.owner.withAcceptedOperation(f.accepted,async()=>{
  const permit=JSON.parse(f.owner.requestHeaders()['x-devryan-native-permit']);
  await expect(f.owner.handleRpc('native.admission.authorize',{operation:'inbox.reconcile',sessionID:scope.sessionID,messageID:scope.messageID,existingPermit:permit})).resolves.toEqual(permit);
  await expect(f.owner.handleRpc('native.admission.authorize',{operation:'session.switchAgent',sessionID:scope.sessionID,input:{agent:'builder'},existingPermit:permit})).rejects.toMatchObject({code:'native_primary_continuation_selection_changed'});
  f.revoke();
  await expect(f.owner.handleRpc('native.admission.recheck',{permit,request:{operation:'inbox.reconcile',sessionID:scope.sessionID,messageID:scope.messageID}})).rejects.toMatchObject({code:'revoked'});
 }));
 expect(f.checks()).toBeGreaterThan(4);f.owner.dispose();
});
it('refuses forged scope and changed text/segments before issuing any accepted capability',async()=>{
 const f=fixture();
 await expect(f.owner.withPrimaryContinuationDispatch({...scope,sessionID:'ses_wrong'},async()=>{})).rejects.toThrow('scope mismatch');
 for(const accepted of [{...f.accepted,request:{text:'different'}},{...f.accepted,messageID:'msg_other'},
  {...f.accepted,metadata:{devryan:{objectiveID:'msg_forged',parts:f.accepted.metadata.devryan.parts}}},
  {...f.accepted,metadata:{devryan:{...f.accepted.metadata.devryan,parts:[{kind:'text',length:prompt.parts[0].text.length}]}}}]){
  await expect(f.owner.withPrimaryContinuationDispatch(scope,()=>f.owner.withAcceptedOperation(accepted,async()=>{})))
   .rejects.toMatchObject({code:'native_primary_continuation_payload_changed'});
 }
 f.owner.dispose();
});
it('reconciliation grants only the exact real user input and does not expose a public issuance route',async()=>{
 const f=fixture();
 await expect(f.owner.handleRpc('native.admission.authorize',{operation:'primary.continue',sessionID:scope.sessionID,messageID:scope.messageID}))
  .rejects.toMatchObject({code:'native_primary_continuation_capability_required'});
 await f.owner.withPrimaryContinuationOperation(scope,async permit=>{
  await expect(f.owner.handleRpc('native.admission.authorize',{operation:'primary.continue',sessionID:scope.sessionID,messageID:scope.messageID,existingPermit:permit})).resolves.toEqual(permit);
  await expect(f.owner.handleRpc('native.admission.authorize',{operation:'primary.continue',sessionID:scope.sessionID,messageID:'msg_wrong',existingPermit:permit})).rejects.toMatchObject({code:'native_permit_lineage_mismatch'});
  await expect(f.owner.handleRpc('native.admission.recheck',{permit,request:{operation:'session.synthetic',sessionID:scope.sessionID}})).rejects.toMatchObject({code:'native_permit_operation_mismatch'});
 });
 f.hold();await expect(f.owner.withPrimaryContinuationOperation(scope,async()=>{})).rejects.toMatchObject({code:'native_primary_continuation_fenced'});
 f.owner.dispose();
});
it('refuses a controller replacement while original canonical authority is awaiting',async()=>{
 const f=fixture();let release,started;
 const waiting=new Promise(resolve=>{started=resolve;});
 f.pause(()=>{started();return new Promise(resolve=>{release=resolve;});});
 const work=f.owner.withPrimaryContinuationDispatch(scope,async()=>{throw Error('effect must not execute');});
 await waiting;await f.owner.invalidateController();release();
 await expect(work).rejects.toMatchObject({code:'native_permit_revoked'});f.owner.dispose();
});

it('TODO metadata derives only from the exact live todowrite call and preserves unrelated metadata',async()=>{
 const items=[{id:'one',content:'Verify the real change',status:'pending',priority:'high'}];
 const metadata={custom:{retained:true},devryan:{archive:{sessionID:scope.sessionID,at:null},todo:{sessionID:scope.sessionID,items:[],rev:4}}};
 let allowed=true,locks=0,metadataDirectory=scope.directory;
 const owner=createNativeAdmissionOwner({directory:scope.directory,ownerID:'bundle',
  runtime:{registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision:0,held:false})},getSession:async id=>({id,directory:scope.directory}),
  readSessionMetadata:async({sessionID})=>({id:sessionID,directory:metadataDirectory,metadata}),
  withSessionLock:async(_id,action)=>{locks++;return action();},authorizeOperation:async()=>{if(!allowed)throw Object.assign(Error('revoked'),{code:'revoked'});}});
 const authorization={operation:'tool.execute',sessionID:scope.sessionID,messageID:'msg_step',input:{toolID:'todowrite',callID:'call_todo',
  provenance:{kind:'plugin',id:'devryan.harness-context',manifestDigest:'b'.repeat(64),capabilities:['control']},input:{todos:items}}};
 const permit=await owner.handleRpc('native.admission.authorize',authorization);
 const invocation={permit,authorization,directory:scope.directory,sessionID:scope.sessionID,messageID:'msg_step',callID:'call_todo',tool:'todowrite',input:{todos:items}};
 const expected={...metadata,devryan:{...metadata.devryan,todo:{sessionID:scope.sessionID,items,rev:5}}};
 await owner.withPermit(invocation,()=>owner.withNativeTodoWrite({invocation,metadata:expected},()=>
  owner.withWebOperation({operation:'setMetadata',method:'PATCH',path:`/api/session/${scope.sessionID}`,body:{metadata:expected}},async()=>{
   const child=JSON.parse(owner.requestHeaders()['x-devryan-native-permit']);
   await expect(owner.handleRpc('native.admission.authorize',{operation:'session.setMetadata',sessionID:scope.sessionID,
    input:{sessionID:scope.sessionID,metadata:expected},existingPermit:child})).resolves.toEqual(child);
   await expect(owner.handleRpc('native.admission.authorize',{operation:'session.rename',sessionID:scope.sessionID,input:{title:'injected'},existingPermit:child}))
    .rejects.toMatchObject({code:'native_permit_operation_mismatch'});
  })));
 expect(locks).toBe(1);
 await expect(owner.withNativeTodoWrite({invocation,metadata:{...expected,custom:{retained:false}}},async()=>{})).rejects.toMatchObject({code:'native_todo_metadata_changed'});
 await expect(owner.withNativeTodoWrite({invocation,metadata:expected},()=>owner.withWebOperation({operation:'setMetadata',method:'PATCH',path:`/api/session/${scope.sessionID}`,body:{metadata}},async()=>{}))).rejects.toMatchObject({code:'native_todo_metadata_changed'});
 metadataDirectory='/foreign';await expect(owner.withNativeTodoWrite({invocation,metadata:expected},async()=>{})).rejects.toMatchObject({code:'native_todo_metadata_scope_invalid'});metadataDirectory=scope.directory;
 allowed=false;await expect(owner.withNativeTodoWrite({invocation,metadata:expected},async()=>{})).rejects.toMatchObject({code:'revoked'});
 owner.dispose();
});
it('compaction context retains only its exact active runner grant across async anchor reads',async()=>{
 let held=false;
 const owner=createNativeAdmissionOwner({directory:scope.directory,ownerID:'bundle',runtime:{registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision:held?1:0,held})},
  getSession:async id=>({id,directory:scope.directory}),authorizeOperation:async()=>{}});
 const permit=await owner.handleRpc('native.admission.authorize',{operation:'runner.drain',sessionID:scope.sessionID});
 const input={permit,directory:scope.directory,sessionID:scope.sessionID,phase:'compaction'};
 const recheck=await owner.captureContextAuthorization(input);await recheck();
 await expect(owner.captureContextAuthorization({...input,directory:'/other'})).rejects.toMatchObject({code:'native_context_scope_invalid'});
 await expect(owner.captureContextAuthorization({...input,phase:'context'})).rejects.toMatchObject({code:'native_context_scope_invalid'});
 held=true;await expect(recheck()).rejects.toMatchObject({code:'native_permit_revoked'});held=false;
 await owner.invalidateController();await expect(recheck()).rejects.toMatchObject({code:'native_permit_invalid'});owner.dispose();
});

it('read-only native session hooks retain their exact active session and cannot manufacture a prompt grant',async()=>{
 let allowed=true,revision=0;
 const owner=createNativeAdmissionOwner({directory:scope.directory,ownerID:'bundle',runtime:{registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision,held:false})},
  getSession:async id=>({id,directory:scope.directory}),authorizeOperation:async()=>{if(!allowed)throw Object.assign(new Error('revoked'),{code:'revoked'});}});
 const permit=await owner.handleRpc('native.admission.authorize',{operation:'runner.drain',sessionID:scope.sessionID});
 const input={permit,directory:scope.directory,sessionID:scope.sessionID,phase:'context'};
 const recheck=await owner.captureSessionHookAuthorization(input);await recheck();
 for(const phase of ['context','compaction','retry','model.request'])await expect(owner.captureSessionHookAuthorization({...input,phase})).resolves.toBeTypeOf('function');
 for(const changes of [{directory:'/foreign'},{sessionID:'ses_foreign'},{phase:'prompt',messageID:'msg_injected'},{phase:'mutation'}])await expect(owner.captureSessionHookAuthorization({...input,...changes})).rejects.toMatchObject({code:'native_hook_scope_invalid'});
 allowed=false;await expect(recheck()).rejects.toMatchObject({code:'revoked'});allowed=true;
 revision=1;await expect(recheck()).rejects.toMatchObject({code:'native_permit_revoked'});revision=0;
 await owner.invalidateController();await expect(recheck()).rejects.toMatchObject({code:'native_permit_invalid'});owner.dispose();
});
