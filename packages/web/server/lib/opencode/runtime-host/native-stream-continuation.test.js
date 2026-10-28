import {expect,test} from 'vitest';
import {Effect} from 'effect';
import {createNativeStreamContinuation} from './native-stream-continuation.js';
import {OperationPermitRef} from './native-admission-contract.js';

const permit={token:'a'.repeat(64),revision:0,sessionID:'ses_fixture'};
const interrupted='The previous response was interrupted. Continue from where you left off without repeating completed content.';
for(const rejected of ['reserve','bind','missing-permit'])test(`${rejected} ${rejected==='bind'?'remains a defect':'vetoes retry without a defect'}`,async()=>{
 const owner=createNativeStreamContinuation({controllerInstanceID:'fixture',configurationDigest:'d'.repeat(64),rpc:async(_method,payload)=>{
  if(payload.action===rejected)throw Error('refused');return true;
 }});
 const scope={sessionID:'ses_fixture',directory:'/fixture',requestID:'request',execution:{agent:'build',providerID:'fixture',modelID:'model',variant:'default'},
  attempt:{identity:{traceID:'a'.repeat(32),spanID:'b'.repeat(16)},outputStarted:true,outputEventID:'evt_output',assistantMessageID:'msg_assistant'}};
 const prepared={request:{messages:[],tools:[],toolChoice:undefined,generation:undefined,providerOptions:undefined},retry:event=>Effect.sync(()=>{event.decision={retry:true};})};
 const event={decision:{retry:false}};
 const decorated=owner.decorate(scope,prepared);
 const exit=await Effect.runPromise(Effect.exit(decorated.retry(event).pipe(Effect.provideService(OperationPermitRef,rejected==='missing-permit'?undefined:permit))));
 expect(exit._tag).toBe('Success');
 if(rejected!=='bind'){expect(event.decision.retry).toBe(false);return;}
 expect(event.decision.retry).toBe(true);
 const published={id:'evt_synthetic',created:1,type:'session.synthetic',durable:{aggregateID:'ses_fixture',seq:1,version:1},location:{directory:'/fixture'},data:{sessionID:'ses_fixture',text:interrupted}};
 const bind=await Effect.runPromise(Effect.exit(owner.observePublished(published).pipe(Effect.provideService(OperationPermitRef,permit))));
 expect(bind._tag).toBe('Failure');
});
