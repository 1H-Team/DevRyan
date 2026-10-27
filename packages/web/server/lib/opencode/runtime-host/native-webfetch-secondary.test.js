import {expect,test} from 'vitest';
import {createNativeAdmissionOwner} from './native-admission-owner.js';

test('secondary generation retains the exact live Slim control call and cannot become another operation',async()=>{
 const directory='/fixture/webfetch',sessionID='ses_webfetch',messageID='msg_assistant',callID='call_fetch';
 let allowed=true,revision=0,generation=1,state='ready';
 const runtime={registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision,held:false}),
  leaseForCall:async()=>({executionKind:'control',preparation:'none',state,generation:1,scope:{messageID}}),
  capturedSessionState:async()=>({captured:true,pending:false,generation})};
 const owner=createNativeAdmissionOwner({directory,runtime,ownerID:'fixture',getSession:async id=>({id,directory}),
  authorizeOperation:async()=>{if(!allowed)throw Error('revoked');}});
 const request={operation:'tool.execute',sessionID,messageID,input:{toolID:'webfetch',callID,
  provenance:{kind:'plugin',id:'devryan.slim',manifestDigest:'a'.repeat(64),capabilities:['network']},input:{url:'https://fixture.invalid'}}};
 const parent=await owner.handleRpc('native.admission.authorize',request);
 const input={permit:parent,directory,sessionID,messageID,callID,model:{providerID:'fixture',modelID:'summary'},prompt:'Summarize the received page.'};
 let child;
 try{
  for(const changes of [{callID:'call_other'},{directory:'/foreign'},{messageID:'msg_foreign'},{sessionID:'ses_foreign'}])
   await expect(owner.beginWebfetchSecondary({...input,...changes})).rejects.toMatchObject({code:'native_webfetch_secondary_scope_invalid'});
  generation=2;await expect(owner.beginWebfetchSecondary(input)).rejects.toMatchObject({code:'native_webfetch_secondary_lease_invalid'});generation=1;
  state='published';await expect(owner.beginWebfetchSecondary(input)).rejects.toMatchObject({code:'native_webfetch_secondary_lease_invalid'});state='ready';
  child=await owner.beginWebfetchSecondary(input);
  const attempt={directory,sessionID,kind:'generate',permit:child};
  await expect(owner.withProviderAttempt(attempt,async()=>42)).resolves.toBe(42);
  const resolution={directory,sessionID,permit:child};
  await expect(owner.withProviderResolution(resolution,async recheck=>{await recheck();return 42;})).resolves.toBe(42);
  await expect(owner.withProviderAttempt({...attempt,kind:'primary'},async()=>42)).rejects.toMatchObject({code:'native_provider_attempt_scope_invalid'});
  await expect(owner.handleRpc('native.admission.recheck',{permit:child,request:{operation:'session.prompt',sessionID}})).rejects.toMatchObject({code:'native_webfetch_secondary_scope_invalid'});
  const check=await owner.captureSessionHookAuthorization({permit:child,directory,sessionID,phase:'model.request'});await check();
  revision=1;await expect(check()).rejects.toMatchObject({code:'native_permit_revoked'});
  await expect(owner.withProviderResolution(resolution,async()=>42)).rejects.toMatchObject({code:'native_permit_revoked'});revision=0;
  allowed=false;await expect(owner.withProviderAttempt(attempt,async()=>42)).rejects.toThrow('revoked');allowed=true;
  await owner.handleRpc('native.admission.release',parent);
  await expect(owner.withProviderResolution(resolution,async()=>42)).rejects.toMatchObject({code:'native_permit_invalid'});
  await expect(owner.withProviderAttempt(attempt,async()=>42)).rejects.toMatchObject({code:'native_permit_invalid'});
  await expect(owner.endWebfetchSecondary(child)).resolves.toBeNull();
  await expect(owner.withProviderAttempt(attempt,async()=>42)).rejects.toMatchObject({code:'native_permit_invalid'});
 }finally{owner.dispose();}
});
