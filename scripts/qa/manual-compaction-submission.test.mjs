import assert from 'node:assert/strict';
import test from 'node:test';
import { QA_COMPACTION_COMPOSER, qaManualCompactionKey, observeQaManualCompactionRequest,
  readQaManualCompactionQueueMode, withQaManualCompactionSubmission } from './manual-compaction-submission.mjs';

const origin='http://127.0.0.1:3101';
const sessionID='ses_manual123';
const url=`${origin}/api/session/${sessionID}/summarize`;
class FakeCdp {
  listeners=new Map();
  evaluations=[];
  focused=true;
  on(method,listener) {
    const list=this.listeners.get(method)??new Set();list.add(listener);this.listeners.set(method,list);
    return ()=>list.delete(listener);
  }
  emit(method,event) {for(const listener of this.listeners.get(method)??[])listener(event);}
  async send(method,params) {
    assert.equal(method,'Runtime.evaluate');this.evaluations.push(params.expression);
    return {result:{value:params.expression==='location.origin'?origin:this.focused}};
  }
  count() {return [...this.listeners.values()].reduce((total,list)=>total+list.size,0);}
}
const request=(cdp,overrides={})=>cdp.emit('Network.requestWillBeSent',{
  requestId:'42.1',timestamp:1,request:{method:'POST',url,headers:{Authorization:'secret'},postData:'secret'},...overrides});
const response=(cdp,status=200,overrides={})=>cdp.emit('Network.responseReceived',{
  requestId:'42.1',timestamp:2,response:{url,status,headers:{'Set-Cookie':'secret'},statusText:'secret'},...overrides});
const setup=(timeout=1000)=>{
  const cdp=new FakeCdp(),receipt={};
  const observer=observeQaManualCompactionRequest({cdp,receipt,origin,sessionID,deadline:Date.now()+timeout});
  return {cdp,receipt,observer};
};
const driver=cdp=>({
  events:[],
  async waitExpression(label,expression) {this.events.push({kind:'wait',label,expression});return true;},
  async type(text,selector) {this.events.push({kind:'type',text,selector});},
  async key(key,options) {this.events.push({kind:'key',key,options});request(cdp);response(cdp);},
});

test('submission key matches each actual queue preference and rejects an absent preference',()=>{
  assert.equal(qaManualCompactionKey(true).modifiers,2);
  assert.equal(qaManualCompactionKey(false).modifiers,0);
  assert.throws(()=>qaManualCompactionKey(undefined),/actual queue mode/);
});

test('queue preference observation reads mounted control without changing it',async()=>{
  const cdp=new FakeCdp(),clicks=[];
  const ui={click:async target=>clicks.push(target),waitExpression:async label=>label.startsWith('authoritative')?{enabled:true,checked:'true',pressed:'true'}:true};
  const observed=await readQaManualCompactionQueueMode({cdp,ui});
  assert.equal(observed.enabled,true);assert.equal(observed.source,'rendered-settings-control');assert.equal(observed.origin,origin);
  assert.deepEqual(clicks,[{label:'Settings'},{selector:'[data-settings-view] button',text:'Appearance'},{selector:'[data-settings-view] button',label:'Back'}]);
});

test('collector excludes pre-arm traffic, other methods, origins, sessions and response identities',async()=>{
  const {cdp,receipt,observer}=setup();
  try {
    request(cdp);observer.arm();
    for(const requestValue of [{method:'GET',url},{method:'POST',url:url.replace('3101','3102')},
      {method:'POST',url:url.replace(sessionID,'ses_other')},{method:'POST',url:url+'/extra'}])request(cdp,{request:requestValue});
    response(cdp,200,{requestId:'different'});
    assert.equal(receipt.matchingRequestCount,0);
    request(cdp,{request:{method:'POST',url:url+'?directory=private',headers:{secret:'secret'},postData:'secret'}});
    response(cdp);await observer.waitForAcknowledgement();
    assert.equal(receipt.matchingRequestCount,1);assert.equal(receipt.outcome,'http-accepted');
    assert.deepEqual(Object.keys(receipt.requests[0]).sort(),['method','observedAt','path','requestId','response','timestamp']);
    assert.deepEqual(Object.keys(receipt.requests[0].response).sort(),['observedAt','status','timestamp']);
    assert.doesNotMatch(JSON.stringify(receipt),/secret|private|headers|postData|statusText/);
  } finally {observer.close();}
  assert.equal(cdp.count(),0);
});

test('an HTTP rejection is evidence of submission failure, not a native boundary',async()=>{
  const {cdp,receipt,observer}=setup();
  try {
    observer.arm();request(cdp);response(cdp,404);
    await assert.rejects(observer.waitForAcknowledgement(),/summarize-http-rejected/);
    assert.equal(receipt.requests[0].response.status,404);assert.equal(receipt.outcome,'failed');
  } finally {observer.close();}
});

test('network failure remains sticky even when a later response arrives',async()=>{
  const {cdp,receipt,observer}=setup();
  try {
    observer.arm();request(cdp);
    cdp.emit('Network.loadingFailed',{requestId:'unrelated',errorText:'secret'});
    cdp.emit('Network.loadingFailed',{requestId:'42.1',timestamp:3,errorText:'sensitive body',canceled:true,blockedReason:'secret'});
    response(cdp);
    await assert.rejects(observer.waitForAcknowledgement(),/summarize-network-failed/);
    assert.deepEqual(receipt.requests[0].failure,{observedAt:receipt.requests[0].failure.observedAt,timestamp:3,canceled:true,code:'network-failure'});
    assert.doesNotMatch(JSON.stringify(receipt),/sensitive|secret|blockedReason/);
  } finally {observer.close();}
});

test('a loading failure after HTTP acceptance still fails the active observation',async()=>{
  const {cdp,receipt,observer}=setup();
  try {
    observer.arm();request(cdp);response(cdp);await observer.waitForAcknowledgement();
    cdp.emit('Network.loadingFailed',{requestId:'42.1',errorText:'net::ERR_ABORTED'});
    assert.throws(observer.assertHealthy,/summarize-network-failed/);
    assert.equal(receipt.requests[0].failure.code,'net::ERR_ABORTED');
  } finally {observer.close();}
});

test('duplicate summarize requests fail and retained request metadata is bounded',async()=>{
  const {cdp,receipt,observer}=setup();
  try {
    observer.arm();for(let index=0;index<100;index++)request(cdp,{requestId:`42.${index}`});
    assert.equal(receipt.requests.length,2);assert.equal(receipt.matchingRequestCount,3);
    await assert.rejects(observer.waitForAcknowledgement(),/duplicate-summarize-request/);
  } finally {observer.close();}
});

test('response URL must preserve the exact origin and session',async()=>{
  const {cdp,observer}=setup();
  try {
    observer.arm();request(cdp);response(cdp,200,{response:{url:url.replace('3101','3102'),status:200}});
    await assert.rejects(observer.waitForAcknowledgement(),/response-origin-or-session-mismatch/);
  } finally {observer.close();}
});

for(const submitted of [false,true])test(`absolute deadline classifies ${submitted?'pending response':'missing request'} and releases the waiter`,async()=>{
  const {cdp,receipt,observer}=setup(20);
  try {
    observer.arm();if(submitted)request(cdp);
    await assert.rejects(observer.waitForAcknowledgement(),submitted?/summarize-response-unobserved-at-deadline/:/summarize-request-unobserved-at-request-deadline/);
    if(!submitted)assert.ok(receipt.requestDeadline<=receipt.requestFailureObservedAt);
    assert.equal(receipt.outcome,'failed');
  } finally {observer.close();}
  assert.equal(cdp.count(),0);
});

test('request observation gets 30 seconds from arm while a matched request keeps the original response deadline',async context=>{
  context.mock.timers.enable({apis:['Date','setTimeout'],now:1_000_000});
  const missing=setup(120_000),matched=setup(120_000),capped=setup(50_000);
  try {
    context.mock.timers.tick(25_000);
    missing.observer.arm();matched.observer.arm();capped.observer.arm();
    assert.equal(missing.receipt.requestArmedAt,1_025_000);
    assert.equal(missing.receipt.requestDeadline,1_055_000);
    assert.equal(capped.receipt.requestDeadline,1_050_000,'The request budget must not extend the cell deadline');
    request(matched.cdp);
    context.mock.timers.tick(29_999);
    missing.observer.assertHealthy();matched.observer.assertHealthy();
    await assert.rejects(capped.observer.waitForAcknowledgement(),/summarize-request-unobserved-at-request-deadline/);
    context.mock.timers.tick(1);
    await assert.rejects(missing.observer.waitForAcknowledgement(),/summarize-request-unobserved-at-request-deadline/);
    assert.equal(missing.receipt.requestFailureObservedAt,1_055_000);
    matched.observer.assertHealthy();
    assert.equal(matched.receipt.outcome,'request-observed','The first matching request must clear only its request timer');
    context.mock.timers.tick(64_999);
    matched.observer.assertHealthy();
    context.mock.timers.tick(1);
    await assert.rejects(matched.observer.waitForAcknowledgement(),/summarize-response-unobserved-at-deadline/);
  } finally {
    for(const {cdp,observer} of [missing,matched,capped]) {observer.close();assert.equal(cdp.count(),0);}
    context.mock.timers.reset();
  }
});

test('closing an unfinished observation settles its waiter and unsubscribes idempotently',async()=>{
  const {cdp,receipt,observer}=setup();observer.arm();const waiting=observer.waitForAcknowledgement();
  observer.close();observer.close();
  await assert.rejects(waiting,/submission-observation-interrupted/);assert.equal(cdp.count(),0);
  request(cdp);assert.equal(receipt.matchingRequestCount,0);
});

for(const enabled of [true,false])test(`helper types the completed command and sends exactly once for queue ${enabled}`,async()=>{
  const cdp=new FakeCdp(),ui=driver(cdp),receipt={},persisted=[];
  const result=await withQaManualCompactionSubmission({cdp,ui,origin,sessionID,queueModeEnabled:enabled,
    deadline:Date.now()+1000,receipt,persist:async()=>persisted.push(structuredClone(receipt)),
    beforeKey:async()=>ui.events.push({kind:'activity-transition'})},async observer=>{observer.assertHealthy();return 'native-observation';});
  assert.equal(result,'native-observation');
  assert.deepEqual(ui.events.filter(event=>event.kind==='type'),[{kind:'type',text:'/compact ',selector:QA_COMPACTION_COMPOSER}]);
  assert.deepEqual(ui.events.filter(event=>event.kind==='key'),[{kind:'key',key:'Enter',options:qaManualCompactionKey(enabled)}]);
  assert.ok(ui.events.findIndex(event=>event.kind==='activity-transition')<ui.events.findIndex(event=>event.kind==='key'));
  assert.equal(receipt.outcome,'http-accepted');assert.equal(cdp.count(),0);
  assert.equal(persisted.length,1);assert.ok(persisted[0].closedAt);
});

test('native observation begins without awaiting HTTP acknowledgment',async()=>{
  const cdp=new FakeCdp(),ui=driver(cdp),receipt={};
  ui.key=async()=>{request(cdp);};
  await withQaManualCompactionSubmission({cdp,ui,origin,sessionID,queueModeEnabled:true,deadline:Date.now()+1000,receipt},async()=>{
    assert.equal(receipt.outcome,'request-observed');receipt.nativeObservedAt=Date.now();response(cdp);return true;
  });
  assert.ok(receipt.nativeObservedAt<=receipt.requests[0].response.observedAt);
});

test('a lost composer focus fails before any submission and persists cleanup',async()=>{
  const cdp=new FakeCdp(),ui=driver(cdp),receipt={};cdp.focused=false;let persisted=false;
  await assert.rejects(withQaManualCompactionSubmission({cdp,ui,origin,sessionID,queueModeEnabled:true,deadline:Date.now()+1000,receipt,
    persist:async()=>{persisted=true;}},async()=>{throw new Error('must not observe');}),/lost its exact focused composer/);
  assert.equal(ui.events.filter(event=>event.kind==='key').length,0);assert.equal(receipt.failure,'submission-not-attempted');
  assert.equal(cdp.count(),0);assert.equal(persisted,true);
});

test('a boundary failure preserves the accepted HTTP receipt without retry',async()=>{
  const cdp=new FakeCdp(),ui=driver(cdp),receipt={};
  await assert.rejects(withQaManualCompactionSubmission({cdp,ui,origin,sessionID,queueModeEnabled:true,deadline:Date.now()+1000,receipt},
    async()=>{throw new Error('native boundary absent');}),/native boundary absent/);
  assert.equal(receipt.outcome,'http-accepted');assert.equal(receipt.attemptError,'submission-or-boundary-observation-failed');
  assert.equal(ui.events.filter(event=>event.kind==='key').length,1);assert.equal(cdp.count(),0);
});
