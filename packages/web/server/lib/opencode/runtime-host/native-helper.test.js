import {expect,test} from 'bun:test';
import {nativeHelperInput} from './native-helper-contract.js';
import {createNativeHelperOwner} from './native-helper-owner.js';
import {createNativeAdmissionOwner} from './native-admission-owner.js';
import {createControllerHelperText} from './controller-helper-text.ts';
import {runWithRequestPermit} from './native-admission-contract.ts';

const input={directory:'/fixture',agent:'devryan-title',providerID:'fixture',modelID:'chosen',prompt:'exact'};
test('actual helper HTTP permit reconstruction settles cancelled work without accepting foreign or malformed ACKs',async()=>{
 const target={instanceID:'helper-http-roundtrip',url:'http://fixture'};
 let helper,started,released=false,settlement=false;
 const began=new Promise(resolve=>{started=resolve;});
 const admission=createNativeAdmissionOwner({directory:'/fixture',ownerID:'fixture',runtime:{registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision:0,held:false,reverting:false})},
  getSession:async()=>undefined,authorizeOperation:async()=>{},captureWebAuthorization:async()=>async()=>{}});
 const handler=createControllerHelperText({isCurrent:()=>true,rename:async()=>{},generate:async(_input,_permit,signal)=>{
  started();return new Promise((_resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
 },rpc:async(method,params)=>{
  // The original reverse bridge serializes the reconstructed controller permit.
  const decoded=JSON.parse(JSON.stringify({method,params}));
  if(method==='native.helper.assert')return helper.assert(decoded.params);
  const permit=decoded.params.permit;
  for(const changed of [null,[],{...permit,token:'f'.repeat(64)},{...permit,sessionID:'ses_foreign'},{...permit,revision:permit.revision+1},{...permit,extra:true},{token:permit.token,revision:permit.revision}]){
   expect(()=>helper.settled({permit:changed})).toThrow('native_helper_expired');
  }
  settlement=true;return helper.settled(decoded.params);
 }});
 helper=createNativeHelperOwner({admissionOwner:{...admission,withHelperOperation:(request,action)=>admission.withHelperOperation(request,async permit=>{
  expect(Object.keys(permit)).toEqual(['token','sessionID','revision']);
  try{return await action(permit);}finally{released=true;}
 })},current:()=>target,headers:()=>admission.requestHeaders(),settlementTimeoutMs:20,cancellationTimeoutMs:20,fetchImpl:async(url,options)=>{
  const request=new Request(url,options);
  return runWithRequestPermit(request.headers,()=>handler(request));
 }});
 const cancellation=new AbortController();
 const outcome=helper.generate({...input,signal:cancellation.signal}).catch(error=>error);
 try{
  await began;expect(released).toBe(false);cancellation.abort(Error('caller cancelled'));
  expect((await outcome).message).toBe('caller cancelled');expect(settlement).toBe(true);expect(released).toBe(true);
 }finally{await helper.controllerSettled(target.instanceID);await outcome;admission.dispose();}
});
test('helper permits only exact generate/model resolution, with fresh caller and selection checks',async()=>{
 let valid=true;const session={id:'ses_fixture',directory:'/fixture',agent:'build',model:{providerID:'fixture',id:'chosen'}};
 const owner=createNativeAdmissionOwner({directory:'/fixture',ownerID:'fixture',runtime:{registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision:0,held:false,reverting:false})},
  getSession:async()=>session,authorizeOperation:async()=>{},captureWebAuthorization:async()=>async()=>{if(!valid)throw Error('revoked');}});
 await owner.withHelperOperation({...input,sessionID:session.id},async permit=>{
  await owner.assertHelperOperation({...input,sessionID:session.id},permit);
  await owner.withProviderAttempt({directory:'/fixture',sessionID:session.id,kind:'generate',permit},async()=>{});
  await expect(owner.withProviderAttempt({directory:'/fixture',sessionID:session.id,kind:'primary',permit},async()=>{})).rejects.toMatchObject({code:'native_provider_attempt_scope_invalid'});
  await expect(owner.assertHelperOperation({...input,sessionID:session.id,modelID:'foreign'},permit)).rejects.toMatchObject({code:'native_helper_scope_invalid'});
  session.model={providerID:'fixture',id:'changed'};
  await expect(owner.assertHelperOperation({...input,sessionID:session.id},permit)).rejects.toMatchObject({code:'native_helper_scope_revoked'});
  valid=false;await expect(owner.assertHelperOperation({...input,sessionID:session.id},permit)).rejects.toThrow('revoked');
 });owner.dispose();
});
test('helper cancellation does not release admission or enable repair before actual provider settlement',async()=>{
 const permit={token:'a'.repeat(64),sessionID:'ses_helper_fixture',revision:0};let released=false,cancelled=false,finish;
 const cancelledRequest=new AbortController();let helper,started;const began=new Promise(resolve=>{started=resolve;});
 const admissionOwner={withHelperOperation:async(_input,action)=>{try{return await action(permit);}finally{released=true;}},assertHelperOperation:async()=>null};
 const target={url:'http://fixture',killAndWaitForExit:async()=>{throw Error('Unexpected kill');}};
 helper=createNativeHelperOwner({admissionOwner,current:()=>target,headers:()=>({}),fetchImpl:async(url,options)=>{
  if(url.endsWith('/cancel')){cancelled=true;return new Response('{}');}
  return new Promise((_resolve,reject)=>{finish=()=>helper.settled({permit});options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});started();});
 }});
 const work=helper.generate({...input,signal:cancelledRequest.signal});const failure=work.catch(error=>error);
 await began;cancelledRequest.abort(Error('caller cancelled'));await new Promise(done=>setTimeout(done,10));
 expect(cancelled).toBe(true);expect(released).toBe(false);finish();expect((await failure).message).toBe('caller cancelled');expect(released).toBe(true);
});
test('helper rejects unsolicited fields and tool-bearing or unbounded input',()=>{
 for(const changed of [{tools:[]},{agent:'build'},{maxOutputTokens:16385},{prompt:'x'.repeat(262145)},{directory:'/fixture/../other'}])expect(()=>nativeHelperInput({...input,...changed})).toThrow('native_helper_input_invalid');
});
test('detached title permits only exact rename and preserves manual title priority',async()=>{
 let currentTitle='',valid=true;const session=()=>({id:'ses_title',directory:'/fixture',title:currentTitle,agent:'build',model:{providerID:'fixture',id:'chosen'}});
 const owner=createNativeAdmissionOwner({directory:'/fixture',ownerID:'fixture',runtime:{registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision:0,held:false,reverting:false})},getSession:async()=>session(),authorizeOperation:async()=>{},captureTitleHelperAuthorization:async()=>async()=>{if(!valid)throw Error('detached revoked');},captureWebAuthorization:async()=>{throw Error('No request principal');}});
 const request={directory:'/fixture',sessionID:'ses_title',title:'Generated',expectedTitle:''};
 try{await owner.withHelperTitleOperation(request,async permit=>{
  await owner.assertHelperOperation(request,permit);
  await expect(owner.assertHelperOperation({...request,title:'Foreign'},permit)).rejects.toThrow('native_helper_title_scope_invalid');
  currentTitle='Manual';await expect(owner.assertHelperOperation(request,permit)).rejects.toThrow('native_helper_title_conflict');
  currentTitle='';valid=false;await expect(owner.assertHelperOperation(request,permit)).rejects.toThrow('detached revoked');
 });}finally{owner.dispose();}
});
test('native helper preserves upstream rate limit after real settlement',async()=>{
 const permit={token:'b'.repeat(64),sessionID:'ses_helper_status',revision:0};let helper,settled=false;
 const target={url:'http://fixture',killAndWaitForExit:async()=>{throw Error('Unexpected kill');}};
 helper=createNativeHelperOwner({admissionOwner:{withHelperOperation:(_input,action)=>action(permit),assertHelperOperation:async()=>null},current:()=>target,headers:()=>({}),fetchImpl:async url=>{
  if(url.endsWith('/cancel'))return Response.json({});settled=true;helper.settled({permit});return Response.json({code:'native_helper_provider_failed'},{status:429});
 }});
 await expect(helper.generate(input)).rejects.toMatchObject({statusCode:429});expect(settled).toBe(true);
});

test('unsettled helper keeps its real permit, blocks logical retries and leaves unrelated work usable', async () => {
 const permits=new Map();let target={instanceID:'controller-a',url:'http://fixture',killAndWaitForExit:()=>{throw Error('Must not kill controller');}};
 const admission=createNativeAdmissionOwner({directory:'/fixture',ownerID:'fixture',runtime:{registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision:0,held:false,reverting:false})},
  getSession:async()=>undefined,authorizeOperation:async()=>{},captureWebAuthorization:async()=>async()=>{}});
 const requests=[];
 const helper=createNativeHelperOwner({admissionOwner:{...admission,withHelperOperation:(request,action)=>admission.withHelperOperation(request,permit=>{permits.set(request.operationID,permit);return action(permit);})},
  current:()=>target,headers:()=>({}),settlementTimeoutMs:5,cancellationTimeoutMs:5,fetchImpl:async(url,options)=>{
   if(url.endsWith('/cancel'))return Response.json({});
   const request=JSON.parse(options.body);requests.push(request.operationID);
   // Deliberately ignore the HTTP signal: a caller timeout is no settlement proof.
   return new Promise(()=>{});
  }});
 const request={...input,operationID:'same-logical-operation',timeoutMs:5};
 await expect(helper.generate(request)).rejects.toMatchObject({code:'native_helper_unsettled'});
 const permit=permits.get(request.operationID);
 await admission.assertHelperOperation(request,permit);
 await expect(helper.assert({input:request,permit})).rejects.toMatchObject({code:'native_helper_expired'});
 await expect(helper.generate({...request,directory:'/different',modelID:'rotated'})).rejects.toMatchObject({code:'native_helper_operation_pending'});
 // An independent admitted execution still runs while the hung helper is owned.
 const unrelated=await admission.withHelperOperation({...input,operationID:'unrelated',agent:'devryan-commit'}, async other=>
  admission.withProviderAttempt({directory:'/fixture',sessionID:other.sessionID,kind:'generate',permit:other},async()=> 'conversation completed'));
 expect(unrelated).toBe('conversation completed');expect(requests).toEqual(['same-logical-operation']);
 helper.settled({permit});await new Promise(resolve=>setTimeout(resolve,1));
 await expect(admission.assertHelperOperation(request,permit)).rejects.toThrow();
 // A confirmed old-controller exit frees its holds without touching a new owner.
 await expect(helper.generate({...request,operationID:'exit-held'})).rejects.toMatchObject({code:'native_helper_unsettled'});
 target={...target,instanceID:'controller-b'};
 await helper.controllerSettled('controller-a');
 await expect(admission.assertHelperOperation({...request,operationID:'exit-held'},permits.get('exit-held'))).rejects.toThrow();
 admission.dispose();
});

test('four unsettled helpers reject new work without eviction; late ACK and exit release only their own holds', async()=>{
 let counter=0,released=0;const permits=[];const target={instanceID:'bounded',url:'http://fixture'};
 const helper=createNativeHelperOwner({admissionOwner:{withHelperOperation:async(_input,action)=>{
  const permit={token:String(++counter).padStart(64,'0'),sessionID:'ses_bounded',revision:0};permits.push(permit);
  try{return await action(permit);}finally{released++;}
 },assertHelperOperation:async()=>null},current:()=>target,headers:()=>({}),settlementTimeoutMs:2,cancellationTimeoutMs:2,
 fetchImpl:async url=>url.endsWith('/cancel')?Response.json({}):new Promise(()=>{})});
 for(let index=0;index<4;index++)await expect(helper.generate({...input,operationID:`operation-${index}`,timeoutMs:2})).rejects.toMatchObject({code:'native_helper_unsettled'});
 await expect(helper.generate({...input,operationID:'fifth'})).rejects.toMatchObject({code:'native_helper_unsettled'});
 expect(counter).toBe(4);expect(released).toBe(0);
 helper.settled({permit:permits[0]});await new Promise(resolve=>setTimeout(resolve,1));expect(released).toBe(1);
 await expect(helper.generate({...input,operationID:'fifth',timeoutMs:2})).rejects.toMatchObject({code:'native_helper_unsettled'});
 expect(counter).toBe(5);await helper.controllerSettled('other');expect(released).toBe(1);
 await helper.controllerSettled('bounded');expect(released).toBe(5);
});

test('controller exit bounds an in-flight fetch even if the transport ignores abort',async()=>{
 let released=false,started;const began=new Promise(resolve=>{started=resolve;});const target={instanceID:'exit-during-fetch',url:'http://fixture'};
 const helper=createNativeHelperOwner({admissionOwner:{withHelperOperation:async(_input,action)=>{try{return await action({token:'c'.repeat(64),revision:0,sessionID:'ses_exit'});}finally{released=true;}},assertHelperOperation:async()=>null},
 current:()=>target,headers:()=>({}),fetchImpl:async()=>{started();return new Promise(()=>{});}});
 const result=helper.generate(input).catch(error=>error);await began;
 await helper.controllerSettled(target.instanceID);
 expect(await result).toMatchObject({code:'native_helper_controller_exited'});expect(released).toBe(true);
});

test('provider sign-out drains only selected-provider helpers and waits for actual cancellation ACK',async()=>{
 const permits=new Map(),released=new Set(),started=new Set();let cancelSignal;
 const target={instanceID:'signout-helpers',url:'http://fixture'};
 const helper=createNativeHelperOwner({admissionOwner:{withHelperOperation:async(request,action)=>{
  const permit={token:(request.providerID==='openai'?'d':'e').repeat(64),sessionID:'ses_signout_helper',revision:0};permits.set(request.providerID,permit);
  try{return await action(permit);}finally{released.add(request.providerID);}
 },assertHelperOperation:async()=>null},current:()=>target,headers:()=>({}),settlementTimeoutMs:40,cancellationTimeoutMs:40,fetchImpl:async(url,options)=>{
  if(url.endsWith('/cancel')){cancelSignal=options.signal;return Response.json({});}
  const request=JSON.parse(options.body);started.add(request.providerID);return new Promise(()=>{});
 }});
 const openai=helper.generate({...input,providerID:'openai',operationID:'openai'}).catch(error=>error);
 const anthropic=helper.generate({...input,providerID:'anthropic',operationID:'anthropic'}).catch(error=>error);
 while(started.size!==2)await new Promise(resolve=>setTimeout(resolve,1));
 let drained=false;const drain=helper.stopProvider('openai').then(()=>{drained=true;});
 await new Promise(resolve=>setTimeout(resolve,2));
 expect(cancelSignal?.aborted).toBe(false);expect(drained).toBe(false);expect(released.size).toBe(0);
 helper.settled({permit:permits.get('openai')});await drain;
 expect(await openai).toMatchObject({code:'native_helper_provider_signed_out'});
 expect(released).toEqual(new Set(['openai']));
 await helper.controllerSettled(target.instanceID);await anthropic;
});

test('provider sign-out can settle after a late actual ACK and refuses an unacknowledged timeout',async()=>{
 let permit,started,startedCalls=0;const began=new Promise(resolve=>{started=resolve;});const target={instanceID:'signout-late-ack',url:'http://fixture'};
 const helper=createNativeHelperOwner({admissionOwner:{withHelperOperation:async(_request,action)=>action(permit={token:'f'.repeat(64),sessionID:'ses_late_helper',revision:0}),assertHelperOperation:async()=>null},current:()=>target,headers:()=>({}),settlementTimeoutMs:5,cancellationTimeoutMs:20,fetchImpl:async url=>{
  if(url.endsWith('/cancel'))return Response.json({});startedCalls++;started();return new Promise(()=>{});
 }});
 const outcome=helper.generate({...input,providerID:'openai',timeoutMs:2}).catch(error=>error);
 await began;expect(await outcome).toMatchObject({code:'native_helper_unsettled'});
 const stopped=helper.stopProvider('openai');setTimeout(()=>helper.settled({permit}),1);
 await stopped;
 const unknown=helper.generate({...input,providerID:'openai',operationID:'unacknowledged',timeoutMs:2}).catch(error=>error);
 while(startedCalls<2)await new Promise(resolve=>setTimeout(resolve,1));
 await expect(helper.stopProvider('openai')).rejects.toMatchObject({code:'native_helper_unsettled'});
 expect(await unknown).toMatchObject({code:'native_helper_unsettled'});
 await helper.controllerSettled(target.instanceID);
});

test('sign-out before helper admission prevents traffic without requiring a nonexistent provider ACK',async()=>{
 let admit,admitted;const allow=new Promise(resolve=>{admit=resolve;});const waiting=new Promise(resolve=>{admitted=resolve;});let sends=0;
 const target={instanceID:'signout-before-admission',url:'http://fixture'};
 const helper=createNativeHelperOwner({admissionOwner:{withHelperOperation:async(_request,action)=>{admitted();await allow;return action({token:'0'.repeat(64),sessionID:'ses_unadmitted_helper',revision:0});},assertHelperOperation:async()=>null},current:()=>target,headers:()=>({}),settlementTimeoutMs:5,cancellationTimeoutMs:5,fetchImpl:async()=>{sends++;return Response.json({});}});
 const outcome=helper.generate({...input,providerID:'openai'}).catch(error=>error);await waiting;
 const stopped=helper.stopProvider('openai');admit();await stopped;
 expect(await outcome).toMatchObject({code:'native_helper_provider_signed_out'});expect(sends).toBe(0);
});
