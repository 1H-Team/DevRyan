import {expect,test} from 'vitest';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createNativeImageGeneration} from './native-image-generation.js';
import {createNativeAdmissionOwner} from './native-admission-owner.js';

test('image requests retain exact lease scope, fresh checks and generation until settlement',async()=>{
 const directory='/fixture/image',sessionID='ses_image',messageID='msg_assistant',callID='call_image',token='lease_image';
 let generation=1,state='ready',allowed=true;
 const runtime={registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision:0,held:false}),
  leaseForCall:async()=>({token,executionKind:'process',state,generation:1,scope:{sessionID,messageID,callID}}),
  capturedSessionState:async()=>({captured:true,pending:false,generation})};
 const owner=createNativeAdmissionOwner({directory,runtime,ownerID:'fixture',getSession:async id=>({id,directory}),authorizeOperation:async()=>{if(!allowed)throw Error('revoked');}});
 const authorization={operation:'tool.execute',sessionID,messageID,input:{toolID:'gpt_imagegen',callID,provenance:{kind:'plugin',id:'opencode-gpt-imagegen',manifestDigest:'a'.repeat(64),capabilities:['write','network']},input:{prompt:'fixture'}}};
 const permit=await owner.handleRpc('native.admission.authorize',authorization);
 const invocation={directory,sessionID,messageID,callID,token,tool:'gpt_imagegen',input:authorization.input.input,authorization,permit};
 try{
  for(const forged of [{callID:'call_other'},{token:'lease_other'},{tool:'write'},{input:{prompt:'changed'}}])await expect(owner.withImageGeneration({...invocation,...forged},async()=>1)).rejects.toThrow();
  await expect(owner.withImageGeneration(invocation,async recheck=>{await recheck();return 42;})).resolves.toBe(42);
  state='published';await expect(owner.withImageGeneration(invocation,async()=>1)).rejects.toMatchObject({code:'native_image_generation_lease_invalid'});state='ready';
  generation=2;await expect(owner.withImageGeneration(invocation,async()=>1)).rejects.toMatchObject({code:'native_image_generation_lease_invalid'});generation=1;
  await expect(owner.withImageGeneration(invocation,async()=>{allowed=false;return 1;})).rejects.toThrow('revoked');
 }finally{owner.dispose();}
});

test('original image transport receives current account per fetch, bounds output and closes revoked response',async()=>{
 const context=new AsyncLocalStorage();let account='a',revoked=false,canceled=0,calls=0;
 const endpoint='https://chatgpt.com/backend-api/codex/responses';
 const originals={withReviewedImagegenOwner:(owner,action)=>context.run(owner,action),callReviewedImagegenResponses:async()=>{
  const response=await context.getStore().fetch(endpoint,{method:'POST',headers:{Authorization:'Bearer stale'},body:'{}'});
  return response.text();
 }};
 const withImageGeneration=(_invocation,action)=>action({access:async()=>({accountId:account,accessToken:account+'-fixture'}),recheck:async()=>{if(revoked)throw Error('revoked');}});
 const generated=createNativeImageGeneration({originals,withImageGeneration,fetchImpl:async(url,init)=>{
  calls++;expect(url).toBe(endpoint);expect(init.redirect).toBe('error');expect(init.signal).toBeInstanceOf(AbortSignal);
  expect(init.headers.get('Authorization')).toBe(`Bearer ${account}-fixture`);expect(init.headers.get('ChatGPT-Account-Id')).toBe(account);
  return new Response('cG5n');
 }});
 const args={prompt:'fixture',quality:'medium',referenceImages:[]};
 expect(await generated({},args)).toEqual({base64:'cG5n'});account='b';expect(await generated({},args)).toEqual({base64:'cG5n'});expect(calls).toBe(2);
 const cancel=new AbortController();cancel.abort();await expect(generated({},args,{signal:cancel.signal})).rejects.toThrow();expect(calls).toBe(2);
 const denied=createNativeImageGeneration({originals,withImageGeneration,fetchImpl:async()=>{revoked=true;return new Response(new ReadableStream({cancel(){canceled++;}}));}});
 await expect(denied({},args)).rejects.toThrow('revoked');expect(canceled).toBe(1);revoked=false;
 const malformed=createNativeImageGeneration({originals,withImageGeneration,fetchImpl:async()=>new Response('not base64')});
 await expect(malformed({},args)).rejects.toMatchObject({code:'native_image_generation_result_invalid'});
 const large=createNativeImageGeneration({originals,withImageGeneration,fetchImpl:async()=>new Response(new Uint8Array(36*1024*1024+1))});
 await expect(large({},args)).rejects.toMatchObject({code:'native_image_generation_response_overflow'});
});
