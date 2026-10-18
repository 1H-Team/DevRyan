import {expect,test} from 'bun:test';
import {nativeHelperInput,nativeHelperTitleInput} from './native-helper-contract.js';
import {createNativeManagedTitleOwner} from './native-managed-title-owner.js';
import {createNativeHelperOwner} from './native-helper-owner.js';
import {createNativeAdmissionOwner} from './native-admission-owner.js';
import {createNativeObservationOwner} from './native-observation-owner.js';
import {createControllerHelperText} from './controller-helper-text.ts';
import {runWithRequestPermit} from './native-admission-contract.ts';
import {createNativeAuthorization} from './native-authorization.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const input={directory:'/fixture',agent:'devryan-title',providerID:'fixture',modelID:'chosen',selectionMode:'configured',selectionRevision:'fixture',prompt:'exact'};
for(const captured of [null,{}, {selection:{providerID:'fixture',modelID:'chosen',revision:'fixture'}}, {selection:{providerID:'fixture',modelID:'chosen'},recheck:async()=>{}}])test('helper admission refuses incomplete captured selection authority',async()=>{
 const owner=createNativeAdmissionOwner({directory:'/fixture',ownerID:'fixture',runtime:{registerNativeSession:async()=>{}},getSession:async()=>undefined,
  authorizeOperation:async()=>{},captureWebAuthorization:async()=>async()=>{},captureHelperSelection:async()=>captured});
 try{await expect(owner.withHelperOperation(input,()=>{throw Error('Unreviewed helper ran');})).rejects.toMatchObject({code:'native_helper_selection_unavailable',status:503});}
 finally{owner.dispose();}
});
test('real helper admission enriches observations only from captured selection, preserves active fallback and fences revoked or injected proof',async()=>{
 const session={id:'ses_helper_observed',directory:'/fixture',agent:'orchestrator',model:{providerID:'primary',id:'chat',variant:'high'}};
 const revision='4f460d83-389a-42a5-93cb-23cd7c5dbd64';let allowed=true;
 const records=[];
 const admission=createNativeAdmissionOwner({directory:session.directory,ownerID:'fixture',runtime:{registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision:0,held:false,reverting:false})},
  getSession:async()=>session,authorizeOperation:async()=>{},captureWebAuthorization:async()=>async()=>{},
  captureHelperSelection:async request=>({selection:request.selectionMode==='active'?{providerID:'primary',modelID:'chat',revision:'active-session'}
    :{providerID:'helper',modelID:'saved',revision},recheck:async()=>{if(!allowed)throw Object.assign(Error('revoked'),{code:'native_helper_selection_changed'});}})});
 const observer=createNativeObservationOwner({instanceID:'controller_helper',snapshot:{digest:'a'.repeat(64),locations:[{directory:session.directory}]},controller:()=>({instanceID:'controller_helper'}),
  isReady:()=>true,admissionOwner:admission,openCodeClient:{sessions:{message:async()=>undefined}},recordDiagnostic:row=>records.push(row)});
 const common={schema:1,controllerInstanceID:'controller_helper',configurationDigest:'a'.repeat(64),sessionID:session.id,directory:session.directory};
 const prepared={...common,stage:'model-prepared',requestID:'request_helper',kind:'generate',execution:{agent:'devryan-commit',providerID:'helper',modelID:'saved',variant:null},
  options:{},hookOptions:{},modelLimits:{context:1000,input:null,output:100},toolCount:0};
 const physical={...common,stage:'physical',requestID:'request_helper',kind:'generate',transport:'http',wireOptions:{},ordinal:1,attempt:null,toolCount:0,wireToolCount:0};
 const request={directory:session.directory,sessionID:session.id,agent:'devryan-commit',providerID:'helper',modelID:'saved',selectionMode:'configured',selectionRevision:revision,prompt:'private input'};
 try{
  await admission.withHelperOperation(request,async permit=>{
   const rpc=observation=>observer.handleRpc('native.observation',{controllerInstanceID:common.controllerInstanceID,permit,observation});
   await rpc(prepared);await rpc(physical);
   expect(records.map(row=>row.payload.helperSelectionRevision)).toEqual([revision,revision]);
   expect(records.every(row=>row.payload.helperSelectionMode==='configured')).toBe(true);
   await admission.withHelperOperation({...request,agent:'devryan-pr'},async other=>{
    await expect(observer.handleRpc('native.observation',{controllerInstanceID:common.controllerInstanceID,permit:other,observation:physical})).rejects.toMatchObject({code:'native_observation_helper_request_invalid'});
   });
   await expect(rpc({...physical,requestID:'unknown_request'})).rejects.toMatchObject({code:'native_observation_helper_request_invalid'});
   await expect(rpc({...physical,toolCount:1})).rejects.toMatchObject({code:'native_observation_helper_request_invalid'});
   for(const changed of [{helperSelectionRevision:revision,helperSelectionMode:'configured'}, {execution:{...prepared.execution,modelID:'foreign'}}, {execution:{...prepared.execution,variant:'high'}}])
    await expect(rpc({...prepared,...changed})).rejects.toMatchObject({code:changed.helperSelectionRevision?'native_observation_invalid':'native_observation_helper_invalid'});
   allowed=false;await expect(rpc(physical)).rejects.toMatchObject({code:'native_helper_selection_changed'});allowed=true;
  });
  await admission.withHelperOperation({...request,providerID:'primary',modelID:'chat',selectionMode:'active',selectionRevision:'active-session'},async permit=>{
   await observer.handleRpc('native.observation',{controllerInstanceID:common.controllerInstanceID,permit,observation:{...prepared,requestID:'request_active',execution:{agent:'devryan-commit',providerID:'primary',modelID:'chat',variant:null}}});
   expect(records.at(-1).payload).toMatchObject({helperSelectionMode:'active',helperSelectionRevision:'active-session',execution:{providerID:'primary',modelID:'chat',variant:null}});
  });
  expect(session.model).toEqual({providerID:'primary',id:'chat',variant:'high'});
  expect(JSON.stringify(records)).not.toContain('private input');expect(JSON.stringify(records)).not.toContain('token');
 }finally{admission.dispose();}
 const legacy=createNativeAdmissionOwner({directory:session.directory,ownerID:'legacy',runtime:{registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision:0,held:false,reverting:false})},
  getSession:async()=>session,authorizeOperation:async()=>{},captureWebAuthorization:async()=>async()=>{}});
 try{await expect(legacy.withHelperOperation(request,()=>{throw Error('Unreviewed helper ran');})).rejects.toMatchObject({code:'native_helper_selection_unavailable',status:503});}finally{legacy.dispose();}
});
for(const agent of ['devryan-title','devryan-commit','devryan-pr','devryan-notify'])test(`${agent} dispatches the saved helper model with Default reasoning through real admission and controller settlement`,async()=>{
 const session={id:'ses_selected',directory:'/fixture',agent:'orchestrator',model:{providerID:'primary',id:'chat',variant:'high'}};
 const selected={providerID:'helper',modelID:'selected',revision:'saved'};
 let helper,dispatches=0,providerEffects=0,selectionChecks=0,selectionCurrent=true;
 const admission=createNativeAdmissionOwner({directory:session.directory,ownerID:'fixture',runtime:{registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision:0,held:false,reverting:false})},
  getSession:async()=>session,authorizeOperation:async()=>{},captureWebAuthorization:async()=>async()=>{},captureTitleHelperAuthorization:async()=>async()=>{},
  captureHelperSelection:async()=>({selection:selected,recheck:async()=>{selectionChecks++;if(!selectionCurrent)throw Object.assign(Error('native_helper_selection_changed'),{code:'native_helper_selection_changed'});}})});
 const request={directory:session.directory,sessionID:session.id,agent,providerID:selected.providerID,modelID:selected.modelID,selectionMode:'configured',selectionRevision:selected.revision,prompt:'exact helper input'};
 const handler=createControllerHelperText({isCurrent:()=>true,rename:async()=>{throw Error('No rename');},rpc:async(method,params)=>method==='native.helper.assert'?helper.assert(JSON.parse(JSON.stringify(params))):helper.settled(JSON.parse(JSON.stringify(params))),
  generate:async(actual,permit,signal,recheck)=>admission.withProviderAttempt({directory:session.directory,sessionID:session.id,kind:'generate',permit},async()=>{
   await recheck();signal.throwIfAborted();providerEffects++;
   expect(actual).toMatchObject(request);expect(Object.hasOwn(actual,'variant')).toBe(false);expect(Object.hasOwn(actual,'reasoning')).toBe(false);expect(Object.hasOwn(actual,'reasoning_effort')).toBe(false);
   return {text:'Selected helper output'};
  })});
 const target={instanceID:`selected-${agent}`,url:'http://fixture'};
 helper=createNativeHelperOwner({admissionOwner:admission,current:()=>target,headers:()=>admission.requestHeaders(),fetchImpl:async(url,options)=>{
  dispatches++;const actual=new Request(url,options);return runWithRequestPermit(actual.headers,()=>handler(actual));
 }});
 try{
  expect(await helper.generate(request)).toEqual({text:'Selected helper output'});expect(dispatches).toBe(1);expect(providerEffects).toBe(1);expect(selectionChecks).toBeGreaterThan(1);
  expect(session.model).toEqual({providerID:'primary',id:'chat',variant:'high'});
  for(const foreign of [{variant:'high'},{modelID:'foreign'},{selectionRevision:'previous'}])await expect(helper.generate({...request,...foreign})).rejects.toMatchObject({code:'native_helper_selection_changed'});
  selectionCurrent=false;await expect(helper.generate(request)).rejects.toMatchObject({code:'native_helper_selection_changed'});
  expect(dispatches).toBe(1);expect(providerEffects).toBe(1);
 }finally{await helper.controllerSettled(target.instanceID);admission.dispose();}
});
test('title source identity rejects coercible values before admission',()=>{
 const request={directory:'/fixture',sessionID:'ses_title',title:'Generated',expectedTitle:'Initial'};
 for(const sourceMessageID of [['msg_valid'],{toString:()=> 'msg_valid'},1,null])expect(()=>nativeHelperTitleInput({...request,sourceMessageID})).toThrow('native_helper_input_invalid');
 for(const sessionID of [['ses_valid'],{toString:()=> 'ses_valid'},1,null]){expect(()=>nativeHelperTitleInput({...request,sessionID})).toThrow('native_helper_input_invalid');expect(()=>nativeHelperInput({...input,sessionID})).toThrow('native_helper_input_invalid');}
 expect(nativeHelperTitleInput({...request,sourceMessageID:'msg_valid'}).sourceMessageID).toBe('msg_valid');
});
test('native rename accepts only the exact private title permit under the real generic authorization policy',async()=>{
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'devryan-title-admission-')));
 let allowed=true,revision=0,currentTitle='Initial';
 const session=()=>({id:'ses_title_owned',directory,title:currentTitle,agent:'build',model:{providerID:'fixture',id:'chosen'}});
 const authorization=createNativeAuthorization({locations:[{directory}],manifest:{inputs:{nativeRegistrations:[],reviewedPlugins:[]}},
  getRequestPrincipal:()=>undefined,getMultiUserRuntime:()=>({enabled:true,resolveSessionPlanContext:async()=>allowed?{directory}:null})});
 const owner=createNativeAdmissionOwner({directory,ownerID:'fixture',runtime:{registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision,held:false,reverting:false})},getSession:async()=>session(),...authorization});
 const request={operation:'session.rename',sessionID:'ses_title_owned',input:{sessionID:'ses_title_owned',title:'Generated'}};
 let retained;
 try{
  await expect(owner.handleRpc('native.admission.authorize',request)).rejects.toMatchObject({code:'native_owned_operation_required'});
  await owner.withHelperTitleOperation({directory,sessionID:request.sessionID,title:'Generated',expectedTitle:'Initial'},async permit=>{
   retained=permit;
   expect(await owner.handleRpc('native.admission.authorize',{...request,existingPermit:permit})).toEqual(permit);
   await expect(owner.handleRpc('native.admission.authorize',{...request,input:{...request.input,title:'Foreign'},existingPermit:permit})).rejects.toMatchObject({code:'native_helper_title_scope_invalid'});
   currentTitle='Manual';await expect(owner.handleRpc('native.admission.authorize',{...request,existingPermit:permit})).rejects.toMatchObject({code:'native_helper_title_conflict'});
   currentTitle='Initial';revision++;await expect(owner.handleRpc('native.admission.authorize',{...request,existingPermit:permit})).rejects.toMatchObject({code:'native_helper_title_conflict'});revision--;
   allowed=false;await expect(owner.handleRpc('native.admission.authorize',{...request,existingPermit:permit})).rejects.toMatchObject({code:'native_session_access_revoked'});allowed=true;
  });
  await expect(owner.handleRpc('native.admission.authorize',{...request,existingPermit:retained})).rejects.toMatchObject({code:'native_permit_invalid'});
 }finally{owner.dispose();await fs.rm(directory,{recursive:true,force:true});}
});
test('actual helper HTTP permit reconstruction settles cancelled work without accepting foreign or malformed ACKs',async()=>{
 const target={instanceID:'helper-http-roundtrip',url:'http://fixture'};
 let helper,started,released=false,settlement=false;
 const began=new Promise(resolve=>{started=resolve;});
 const admission=createNativeAdmissionOwner({directory:'/fixture',ownerID:'fixture',runtime:{registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision:0,held:false,reverting:false})},
  getSession:async()=>undefined,authorizeOperation:async()=>{},captureWebAuthorization:async()=>async()=>{},captureHelperSelection:async()=>({selection:{providerID:'fixture',modelID:'chosen',revision:'fixture'},recheck:async()=>{}})});
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
  getSession:async()=>session,authorizeOperation:async()=>{},captureWebAuthorization:async()=>async()=>{if(!valid)throw Error('revoked');},captureHelperSelection:async()=>({selection:{providerID:'fixture',modelID:'chosen',revision:'fixture'},recheck:async()=>{}})});
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
  getSession:async()=>undefined,authorizeOperation:async()=>{},captureWebAuthorization:async()=>async()=>{},captureHelperSelection:async()=>({selection:{providerID:'fixture',modelID:'chosen',revision:'fixture'},recheck:async()=>{}})});
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
 fetchImpl:async url=>{if(url.endsWith('/cancel'))return Response.json({});throw Error('Dispatched transport failed without ACK');}});
 for(let index=0;index<4;index++)await expect(helper.generate({...input,operationID:`operation-${index}`,timeoutMs:1000})).rejects.toMatchObject({code:'native_helper_unsettled'});
 await expect(helper.generate({...input,operationID:'fifth'})).rejects.toMatchObject({code:'native_helper_unsettled'});
 expect(counter).toBe(4);expect(released).toBe(0);
 helper.settled({permit:permits[0]});await new Promise(resolve=>setTimeout(resolve,1));expect(released).toBe(1);
 await expect(helper.generate({...input,operationID:'fifth',timeoutMs:1000})).rejects.toMatchObject({code:'native_helper_unsettled'});
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

test('expired admission cannot dispatch a late model request and retains the owner until admission settles', async () => {
 let release, completed=false;
 const admissionWait=new Promise(resolve=>{release=resolve;});
 const traffic=[];
 const helper=createNativeHelperOwner({admissionOwner:{withHelperOperation:async(_input,action)=>{
  try{await admissionWait;return await action({token:'a'.repeat(64),revision:0,sessionID:'ses_delayed'});}finally{completed=true;}
 },assertHelperOperation:async()=>{}},current:()=>({instanceID:'late',url:'http://fixture'}),headers:()=>({}),fetchImpl:async url=>{traffic.push(url);return Response.json({text:'late'});}});
 const failed=helper.generate({...input,timeoutMs:5}).catch(error=>error);
 expect(await failed).toMatchObject({code:'native_helper_unsettled'});
 expect(completed).toBe(false);expect(traffic).toEqual([]);
 release();await new Promise(resolve=>setTimeout(resolve,1));
 expect(completed).toBe(true);expect(traffic).toEqual([]);
});

test('helper admission binds configured revision while preserving primary selection and purpose',async()=>{
 const session={id:'ses_selected',directory:'/fixture',agent:'orchestrator',model:{providerID:'primary',id:'chat',variant:'high'}};
 let valid=true;
 const owner=createNativeAdmissionOwner({directory:'/fixture',ownerID:'fixture',runtime:{registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision:0,held:false,reverting:false})},getSession:async()=>session,authorizeOperation:async()=>{},
  captureTitleHelperAuthorization:async()=>async()=>{},captureHelperSelection:async request=>{
   expect(request.agent).toBe('devryan-title');return {selection:{providerID:'helper',modelID:'flash',revision:'saved'},recheck:async()=>{if(!valid)throw Object.assign(Error('native_helper_selection_changed'),{code:'native_helper_selection_changed'});}};
  }});
 const request={...input,sessionID:session.id,providerID:'helper',modelID:'flash',selectionMode:'configured',selectionRevision:'saved'};
 await owner.withHelperOperation(request,async permit=>{
  await owner.assertHelperOperation(request,permit);expect(session.model).toEqual({providerID:'primary',id:'chat',variant:'high'});
  await expect(owner.assertHelperOperation({...request,agent:'devryan-pr'},permit)).rejects.toMatchObject({code:'native_helper_scope_invalid'});
  valid=false;await expect(owner.assertHelperOperation(request,permit)).rejects.toMatchObject({code:'native_helper_selection_changed'});
 });owner.dispose();
});

test('paused title cycle requires canonical accepted human origin and fresh owner authorization',async()=>{
 const session={id:'ses_title_input',directory:'/fixture',model:{providerID:'primary',id:'chat'}};
 let allowed=true,origin='human';
 const request={directory:'/fixture',sessionID:session.id,messageID:'msg_new'};
 const owner=createNativeAdmissionOwner({directory:'/fixture',ownerID:'fixture',runtime:{registerNativeSession:async()=>{}},getSession:async()=>session,authorizeOperation:async()=>{},
  captureTitleHelperAuthorization:async()=>async()=>{if(!allowed)throw Error('native_session_access_revoked');},
  captureAcceptedHumanTitleInput:async ({messageID})=>({recheck:async()=>{if(messageID!=='msg_new')throw Object.assign(Error('Stale accepted source'),{code:'native_managed_title_source_invalid'});}}),
  readUserMessage:async()=>({id:'msg_new',type:'user',sessionID:session.id,directory:'/fixture',metadata:{devryan:{v:1,origin}}})});
 try{
  expect(await owner.verifyTitleAcceptedInput(request)).toBe(true);
  for(const candidate of ['native','helper','command']){origin=candidate;expect(await owner.verifyTitleAcceptedInput(request)).toBe(false);}
  origin='human';expect(await owner.verifyTitleAcceptedInput({...request,messageID:'msg_wrong'})).toBe(false);
  allowed=false;await expect(owner.verifyTitleAcceptedInput(request)).rejects.toThrow('native_session_access_revoked');
 }finally{owner.dispose();}
});

test('actual native latest-human verifier rejects historical root A after B despite same-ID route replay',async()=>{
 const session={id:'ses_title_root',directory:'/fixture',model:{providerID:'primary',id:'chat'}};
 const human=id=>({id,type:'user',sessionID:session.id,directory:'/fixture',text:'Accepted source',metadata:{devryan:{v:1,origin:'human',admission:{v:1,fingerprint:'a'.repeat(64)}}}});
 const users=new Map([['msg_A',human('msg_A')],['msg_B',human('msg_B')]]);let latest='msg_A',allowed=true,generation=1,holdFinal=false,checks=0,entered,release;
 const began=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 const sourceOwner=createNativeManagedTitleOwner({readConfiguration:()=>({controllerInstanceID:'controller_original',configurationDigest:'b'.repeat(64)}),
  readSession:async()=>structuredClone(session),readPrimary:async()=>({anchorID:latest,objectiveID:latest,cancellationGeneration:generation,state:'observing'}),
  readState:async()=>({revision:0,held:false,reverting:false}),readCaptured:async()=>({captured:true,pending:false,generation:1}),
  captureAuthorization:async()=>async()=>{if(!allowed)throw Error('native_session_access_revoked');},
  readUsers:async()=>[...users.keys()].filter(id=>id==='msg_A'||latest==='msg_B').map(id=>({info:{id,role:'user'},parts:[]})),readUser:async({messageID})=>structuredClone(users.get(messageID))});
 const owner=createNativeAdmissionOwner({directory:'/fixture',ownerID:'fixture',runtime:{registerNativeSession:async()=>{}},getSession:async()=>session,authorizeOperation:async()=>{},
  captureTitleHelperAuthorization:async()=>async()=>{if(!allowed)throw Error('native_session_access_revoked');if(holdFinal&&++checks===3){entered();await gate;}},readUserMessage:async({messageID})=>structuredClone(users.get(messageID)),
  captureAcceptedHumanTitleInput:input=>sourceOwner.captureHuman(input)});
 const input={directory:'/fixture',sessionID:session.id,messageID:'msg_A'};
 try{
  expect(await owner.verifyTitleAcceptedInput(input)).toBe(true);
  holdFinal=true;const checking=owner.verifyTitleAcceptedInput(input);await began;latest='msg_B';generation++;release();expect(await checking).toBe(false);holdFinal=false;
  expect(await owner.verifyTitleAcceptedInput({...input,messageID:'msg_B'})).toBe(true);
  for(let replay=0;replay<3;replay++)expect(await owner.verifyTitleAcceptedInput(input)).toBe(false);
  allowed=false;await expect(owner.verifyTitleAcceptedInput({...input,messageID:'msg_B'})).rejects.toThrow('native_session_access_revoked');
 }finally{release();owner.dispose();}
});


function finalizationFixture(callbacks={}) {
 const common={schema:1,controllerInstanceID:'controller_final',configurationDigest:'a'.repeat(64),sessionID:'ses_final',directory:'/fixture'};
 const permit={token:'private_permit',revision:0,sessionID:common.sessionID},attempt={traceID:'trace_final',spanID:'span_final'};
 let current=true,allowed=true,primary={state:'running',activeUserID:'msg_user',cancellationGeneration:0};
 const emitted=[],retired=[];
 const assistant={info:{id:'msg_assistant',sessionID:common.sessionID,role:'assistant',parentID:'msg_user',agent:'build',providerID:'fixture',modelID:'model'},turnOwnership:{source:'native-sequence',userMessageID:'msg_user'}};
 const owner=createNativeObservationOwner({instanceID:common.controllerInstanceID,snapshot:{digest:common.configurationDigest,locations:[{directory:common.directory}]},
  controller:()=>({instanceID:current?common.controllerInstanceID:'retired'}),isReady:()=>current,
  admissionOwner:{withProviderAttempt:async(_input,action)=>{const recheck=async()=>{if(!allowed)throw Error('revoked');};await recheck();return action(recheck);}},
  openCodeClient:{sessions:{message:async()=>assistant}},readPrimaryRecord:async()=>({...primary}),recordDiagnostic:()=>true,
  onPresentationProgress:event=>{emitted.push(event);},onPresentationOwnerRetired:ownerID=>retired.push(ownerID),...callbacks});
 const observe=observation=>owner.handleRpc('native.observation',{controllerInstanceID:common.controllerInstanceID,permit,observation});
 const physical=(requestID='request_final')=>observe({...common,stage:'physical',requestID,kind:'primary',transport:'http',wireOptions:{},ordinal:1,attempt,toolCount:0,wireToolCount:0});
 const prepare=async()=>{await physical();await observe({...common,stage:'step-link',eventID:'step_final',sequence:1,created:1,assistantMessageID:assistant.info.id,
  execution:{agent:'build',providerID:'fixture',modelID:'model',variant:null},attempt});};
 const send=(patch={})=>owner.handleRpc('native.presentation',{controllerInstanceID:common.controllerInstanceID,permit,
  observation:{...common,requestID:'request_final',assistantMessageID:assistant.info.id,stepID:'step_final',attempt,phase:'finalizing',progress:0,sequence:1,...patch}});
 return {owner,emitted,retired,prepare,physical,send,assistant,set allowed(value){allowed=value;},set primary(value){primary=value;},set current(value){current=value;}};
}
test('native presentation requires exact actual physical/step/canonical ownership, monotonic movement and fresh grant',async()=>{
 const f=finalizationFixture();await expect(f.send()).rejects.toMatchObject({code:'native_presentation_expired'});await f.prepare();
 await f.send();expect(f.emitted).toHaveLength(1);expect(f.emitted[0]).toMatchObject({provider:'native',ownerID:'native:controller_final',objectiveID:'msg_user',assistantID:'msg_assistant',stepID:'step_final',attemptID:'trace_final:span_final',phase:'finalizing',progress:0});
 expect(JSON.stringify(f.emitted)).not.toContain('private_permit');
 await expect(f.send()).rejects.toMatchObject({code:'native_presentation_expired'});
 await f.send({sequence:2,progress:1});expect(f.emitted.at(-1).progress).toBe(1);
 f.allowed=false;await expect(f.send({sequence:3,progress:2})).rejects.toThrow('revoked');f.allowed=true;
 f.primary={state:'cancelled',activeUserID:'msg_user',cancellationGeneration:1};await expect(f.send({sequence:4,progress:2})).rejects.toMatchObject({code:'native_presentation_expired'});
 await f.send({sequence:5,progress:2,phase:'cleared'});expect(f.emitted.at(-1).phase).toBe('cleared');
});
test('new physical model work and controller retirement clear display without changing any runtime authority',async()=>{
 const f=finalizationFixture();await f.prepare();await f.send();await f.physical('request_new');expect(f.emitted.at(-1).phase).toBe('cleared');
 await expect(f.send({sequence:2})).rejects.toMatchObject({code:'native_presentation_expired'});
 f.owner.retire();f.owner.retire();expect(f.retired).toEqual(['native:controller_final']);
 await expect(f.send({sequence:3})).rejects.toMatchObject({code:'native_presentation_invalid'});
});
test('native presentation refuses absent native identity and modelsupplied alternate fields',async()=>{
 const f=finalizationFixture();await f.prepare();
 for(const patch of [{attempt:null},{stepID:null},{provider:'cursor'},{userMessageID:'msg_foreign'},{progress:-1},{sequence:NaN}])await expect(f.send(patch)).rejects.toMatchObject({code:'native_presentation_invalid'});
 f.assistant.info.parentID='msg_new_human';await expect(f.send()).rejects.toMatchObject({code:'native_presentation_expired'});expect(f.emitted).toEqual([]);
});

test('concurrent native sessions stamp the public owner sequence after each awaited identity validation',async()=>{
 const instanceID='concurrent_controller',digest='b'.repeat(64),permit={token:'private_concurrent',revision:0};
 const emitted=[];let pauseA=false,release,entered;const held=new Promise(resolve=>{release=resolve;}),reading=new Promise(resolve=>{entered=resolve;});
 const owner=createNativeObservationOwner({instanceID,snapshot:{digest,locations:[{directory:'/fixture'}]},controller:()=>({instanceID}),isReady:()=>true,
  admissionOwner:{withProviderAttempt:async(_input,action)=>action(async()=>{})},recordDiagnostic:()=>true,readPrimaryRecord:async()=>null,
  onPresentationProgress:input=>emitted.push(input),openCodeClient:{sessions:{message:async(sessionID,assistantID)=>{
   if(pauseA&&sessionID==='ses_A'){entered();await held;}
   return {info:{id:assistantID,sessionID,role:'assistant',parentID:'msg_user_'+sessionID,agent:'build',providerID:'fixture',modelID:'model'},turnOwnership:{source:'native-sequence',userMessageID:'msg_user_'+sessionID}};
  }}}});
 const observations={};
 for(const sessionID of ['ses_A','ses_B']){
  const common={schema:1,controllerInstanceID:instanceID,configurationDigest:digest,sessionID,directory:'/fixture'},attempt={traceID:'trace_'+sessionID,spanID:'span_'+sessionID};
  await owner.handleRpc('native.observation',{controllerInstanceID:instanceID,permit,observation:{...common,stage:'physical',requestID:'request_'+sessionID,kind:'primary',transport:'http',wireOptions:{},ordinal:1,attempt}});
  await owner.handleRpc('native.observation',{controllerInstanceID:instanceID,permit,observation:{...common,stage:'step-link',eventID:'step_'+sessionID,sequence:1,created:1,assistantMessageID:'msg_'+sessionID,execution:{agent:'build',providerID:'fixture',modelID:'model',variant:null},attempt}});
  observations[sessionID]={...common,requestID:'request_'+sessionID,stepID:'step_'+sessionID,assistantMessageID:'msg_'+sessionID,attempt,phase:'finalizing',progress:0,sequence:sessionID==='ses_A'?1:2};
 }
 pauseA=true;const first=owner.handleRpc('native.presentation',{controllerInstanceID:instanceID,permit,observation:observations.ses_A});await reading;
 await owner.handleRpc('native.presentation',{controllerInstanceID:instanceID,permit,observation:observations.ses_B});release();await first;
 expect(emitted.map(input=>[input.sessionID,input.sequence])).toEqual([['ses_B',1],['ses_A',2]]);
});

test('optional asynchronous native presentation observers cannot reject publication or retirement',async()=>{
 const called=[];const f=finalizationFixture({onPresentationProgress:async input=>{called.push(input.phase);throw Error('display unavailable');},
  onPresentationOwnerRetired:async()=>{called.push('retired');throw Error('retirement observer unavailable');}});
 await f.prepare();await f.send();f.owner.retire();await new Promise(resolve=>setTimeout(resolve,0));
 expect(called).toEqual(['finalizing','cleared','retired']);
});
test('invalidated physical request releases its per-session input watermark and refuses old callbacks',async()=>{
 const f=finalizationFixture();await f.prepare();await f.send({sequence:100});
 await f.physical('request_new');await expect(f.send({sequence:101})).rejects.toMatchObject({code:'native_presentation_expired'});
 await f.send({requestID:'request_new',sequence:1});expect(f.emitted.at(-1)).toMatchObject({phase:'finalizing',progress:0});
 f.owner.observeAcceptedUser({sessionID:'ses_final',directory:'/fixture',messageID:'msg_new',created:2});
 await expect(f.send({requestID:'request_new',sequence:2})).rejects.toMatchObject({code:'native_presentation_expired'});
 await f.physical('request_after_human');await f.send({requestID:'request_after_human',sequence:1});
 expect(f.emitted.at(-1).phase).toBe('finalizing');f.owner.retire();
});
