import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureQaFixtureFailureSnapshot, qaFixtureFailureUiExpression } from './fixture-failure-snapshot.mjs';

test('failure projection retains queue/config and exact canonical ids without content or credentials',async()=>{
  const secret='must-never-be-retained';
  const sessionID='ses_test',messageID='msg_first',assistantID='msg_answer';
  const rows=[{info:{id:messageID,role:'user',sessionID,time:{created:1}},parts:[{text:secret}]},
    {info:{id:assistantID,role:'assistant',sessionID,parentID:messageID,time:{created:2,completed:3},finish:'stop'},parts:[{text:secret}]}];
  const fixture={origin:'http://127.0.0.1:1',authHeaders:{authorization:secret},getState:()=>({receivedPrompts:[{sessionID,messageID,
    model:{providerID:'fixture',modelID:'fixture-model'},agent:'build',variant:'low',prompt:secret,partTypes:['text']}],
    activePrompts:0,executingSessions:[],eventCounts:{'session.execution.succeeded':1},statusRequestCount:2,messageRequestCounts:{[sessionID]:3},sseConnectionCount:1})};
  let requested;
  const result=await captureQaFixtureFailureSnapshot({fixture,directory:'/private',api:async route=>route.startsWith('/api/session/status')?{}:rows,
    evaluateUi:async()=>({sessionID,stopVisible:true,queues:[{sessionID,id:'queue_1',messageID:'msg_next',content:secret,
      sendConfig:{providerID:'fixture',modelID:'fixture-model',variant:'low',planMode:false}}]}),
    fetchImpl:async(url,options)=>{requested={url,options};return new Response(JSON.stringify({data:[{id:'msg_pending',type:'user',delivery:'steer',payload:{text:secret}}]}));}});
  assert.equal(result.ui.queues[0].messageID,'msg_next');assert.equal(result.ui.queues[0].selection.variant,'low');
  assert.equal(result.sessions[0].canonical.at(-1).id,assistantID);assert.equal(result.sessions[0].canonical.at(-1).completedAt,3);
  assert.equal(result.sessions[0].status.type,'omitted-idle');assert.deepEqual(result.sessions[0].inbox,[{id:'msg_pending',type:'user',delivery:'steer'}]);
  assert.equal(requested.options.headers['x-opencode-directory'],'%2Fprivate');assert.equal(requested.options.headers.authorization,secret);
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('browser failure read only accesses scoped queue storage and emits finite noncontent metadata',()=>{
  const keys=['unrelated-secret','devryan.user.anonymous:message-queue-store'];
  const storage={length:2,key:i=>keys[i],getItem:key=>{assert.equal(key,keys[1]);return JSON.stringify({state:{queuedMessages:{ses_test:[{id:'queue_1',messageId:'msg_1',content:'private prompt',sendConfig:{variant:'low'}}]}}});}};
  const read=new Function('localStorage','location','document',`return ${qaFixtureFailureUiExpression}`);
  const result=read(storage,{href:'http://127.0.0.1:1/?session=ses_test'},{querySelectorAll:()=>[]});
  assert.equal(result.sessionID,'ses_test');assert.equal(result.queues[0].messageID,'msg_1');assert.equal(result.stopVisible,false);
  assert.ok(!JSON.stringify(result).includes('private prompt'));
});
