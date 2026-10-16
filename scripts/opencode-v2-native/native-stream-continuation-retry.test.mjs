import {expect,test} from 'bun:test';
import {Effect} from 'effect';
import {createNativeStreamContinuation} from '../../packages/web/server/lib/opencode/runtime-host/native-stream-continuation.ts';

// Actual constructor retry decoration, without a provider or physical request.
// The graph's missing-attempt scenario separately qualifies physical send count.
for(const outputStarted of [false,true])test(`missing attempt ${outputStarted?'after':'before'} output ${outputStarted?'vetoes':'preserves'} a native retry proposal`,async()=>{
  let proposals=0,rpcCalls=0;
  const owner=createNativeStreamContinuation({controllerInstanceID:'fixture',configurationDigest:'d'.repeat(64),rpc:async()=>{rpcCalls++;throw Error('No physical continuation authority');}});
  const scope={sessionID:'ses_fixture',directory:'/fixture',requestID:'request',execution:{agent:'build',providerID:'fixture',modelID:'model',variant:'default'},outputStarted};
  const prepared={request:{},retry:event=>Effect.sync(()=>{proposals++;event.decision={retry:true};})};
  // The real SDK supplies the full preparation, but retry reads only these two
  // fields. No request, Step, permit or output observation is manufactured.
  const decorated=owner.decorate(scope,prepared);
  const event={decision:{retry:false}};
  await Effect.runPromise(decorated.retry(event));
  expect(proposals).toBe(1);expect(event.decision.retry).toBe(!outputStarted);expect(rpcCalls).toBe(0);
});
