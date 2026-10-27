import assert from 'node:assert/strict';
import {Effect,Fiber,Layer,Logger,Stream,Exit,Cause} from 'effect';
import {TestClock} from 'effect/testing';
import {FetchHttpClient} from 'effect/http';
import {Socket} from 'effect/socket';
import {LLMClient,RequestExecutor} from '@opencode/ai/route';
import {SessionModelTransport} from '@opencode/core/session/model-transport';
import {SessionModelRequest} from '@opencode/core/session/model-request';
import {ModelResolver} from '@opencode/core/model-resolver';
import {Model} from '@opencode/core/model';
import {Provider} from '@opencode/core/provider';
import {Integration} from '@opencode/core/integration';
import {AISDK} from '@opencode/core/aisdk';
import {Npm} from '@opencode/util/npm';
import {PluginHooks} from '@opencode/core/plugin/hooks';

// All credentials, endpoints and traffic belong to this local fixture.
const fixtureKey='devryan-fixture-only-api-key';
const sockets=new Set(),clients=new Set(),requests=[],proof=[];
let received=0,closed=0,stall=false;
const response={id:'fixture_response',object:'response',created_at:0,model:'gpt-5.5',status:'in_progress',output:[]};
const frame=type=>JSON.stringify({type,response});
const server=Bun.serve({hostname:'127.0.0.1',port:0,
 fetch(request,server){
  assert.equal(request.headers.get('authorization'),`Bearer ${fixtureKey}`);
  requests.push({upgrade:request.headers.get('upgrade')==='websocket'});
  if(request.headers.get('upgrade')==='websocket'){
   if(stall)return new Promise(()=>{});
   if(server.upgrade(request))return;
   throw Error('Fixture upgrade failed');
  }
  const done={...response,status:'completed',usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
  return new Response(`data: ${JSON.stringify({type:'response.completed',response:done})}\n\n`,{headers:{'content-type':'text/event-stream'}});
 },websocket:{open(socket){sockets.add(socket);},message(socket){socket.send(frame('response.created'));},close(socket){sockets.delete(socket);closed++;}}});
const url=`http://127.0.0.1:${server.port}/v1`;
const selected={...Model.Info.default('openai','gpt-5.5'),canonical:'openai',package:'@opencode/ai/providers/openai'};
const resolveModel=chunkTimeout=>Effect.gen(function*(){
 const resolver=yield* ModelResolver.Service;
 return yield* resolver.resolveModel(selected);
}).pipe(Effect.provide(ModelResolver.layer.pipe(Layer.provide(Layer.mergeAll(
 Layer.succeed(Provider.Service,{get:()=>Effect.succeed({settings:{baseURL:url,apiKey:fixtureKey,transport:'websocket',...(chunkTimeout===undefined?{}:{chunkTimeout})}})}),
 Layer.succeed(Model.Service,{}),Layer.succeed(Integration.Service,{connection:{active:()=>Effect.succeed(undefined)}}),
 Layer.succeed(AISDK.Service,{}),Layer.succeed(Npm.Service,{})
)))));
const waitFor=async predicate=>{const deadline=Date.now()+5000;while(!predicate()){if(Date.now()>=deadline)throw Error('Fixture physical event did not arrive');await new Promise(resolve=>setTimeout(resolve,1));}};
const clientLayer=LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer.pipe(Layer.provide(FetchHttpClient.layer))));

try{
 for(const scenario of ['connect','default-idle','configured-idle-reset','disabled-idle-stop']){
  stall=scenario==='connect';received=0;const bindings=[],beforeClosed=closed,firstRequest=requests.length;
  const model=await Effect.runPromise(resolveModel(scenario==='configured-idle-reset'?50:scenario==='disabled-idle-stop'?false:undefined));
  assert.equal(model.chunkTimeout,scenario==='configured-idle-reset'?50:scenario==='disabled-idle-stop'?false:undefined);
  assert.equal(model.model.defaults.http.chunkTimeout,scenario==='configured-idle-reset'?50:scenario==='disabled-idle-stop'?false:900000);
  const rawTransport=SessionModelTransport.layer.pipe(Layer.provide(Layer.succeed(Socket.WebSocketConstructor,(target,options)=>{
   assert.ok(target.startsWith(`ws://127.0.0.1:${server.port}/`));
   const socket=new WebSocket(target,options);clients.add(socket);return socket;
  })));
  const transportLayer=Layer.effect(SessionModelTransport.Service,Effect.gen(function*(){
   const inner=yield* SessionModelTransport.Service;
   return {...inner,bind:(id,interceptor,idleTimeout)=>{
    bindings.push({idleTimeout:idleTimeout??null});return inner.bind(id,interceptor,idleTimeout);
   }};
  })).pipe(Layer.provide(rawTransport));
  const sessionID=`ses_websocket_${scenario.replaceAll('-','_')}`;
  const requestLayer=SessionModelRequest.layer.pipe(Layer.provide(Layer.mergeAll(
   transportLayer,
   Layer.succeed(PluginHooks.Service,{has:()=>Effect.succeed(false),trigger:(_domain,name,event)=>Effect.sync(()=>{
    if(name==='experimental.ws.receive')received++;
    return event;
   })})
  )));
  const program=Effect.scoped(Effect.gen(function*(){
   const transport=yield* SessionModelTransport.Service,prepare=yield* SessionModelRequest.Service,llm=yield* LLMClient.Service;
   const prepared=yield* prepare.primary({session:{id:sessionID,projectID:'global',location:{directory:'/fixture'}},agent:'build',model,system:[],messages:[],webSocket:'session'});
   assert.ok(prepared.options.webSocket,'The real SessionModelRequest must select its session WebSocket');
   assert.equal(bindings[0].idleTimeout,model.chunkTimeout??null);
   bindings[0].modelHttpChunkTimeout=model.model.defaults.http.chunkTimeout;
   const fiber=yield* llm.stream(prepared.request,prepared.options).pipe(Stream.runCollect,Effect.forkScoped);
   yield* Effect.promise(()=>waitFor(()=>requests.length>firstRequest));
   if(scenario==='connect'){
    yield* TestClock.adjust(14999);assert.equal(fiber.pollUnsafe(),undefined);assert.equal(requests.length-firstRequest,1);
    yield* TestClock.adjust(1);
    const exit=yield* Fiber.await(fiber);assert.equal(Exit.isSuccess(exit),true);
    assert.deepEqual(requests.slice(firstRequest).map(request=>request.upgrade),[true,false]);
    proof.push({scenario,connectTimeoutMs:15000,fallback:'http',bindings});return;
   }
   yield* Effect.promise(()=>waitFor(()=>received>0));yield* TestClock.adjust(0);
   if(scenario==='default-idle'){
    yield* TestClock.adjust(1799999);assert.equal(fiber.pollUnsafe(),undefined);
    yield* TestClock.adjust(1);
   }else if(scenario==='configured-idle-reset'){
    yield* TestClock.adjust(40);const prior=received;
    for(const socket of sockets)socket.send(frame('response.in_progress'));
    yield* Effect.promise(()=>waitFor(()=>received>prior));yield* TestClock.adjust(0);
    yield* TestClock.adjust(40);assert.equal(fiber.pollUnsafe(),undefined);yield* TestClock.adjust(10);
   }else{
    yield* TestClock.adjust('2 hours');assert.equal(fiber.pollUnsafe(),undefined);
    yield* Fiber.interrupt(fiber);const exit=yield* Fiber.await(fiber);assert.equal(Exit.isFailure(exit)&&Cause.hasInterrupts(exit.cause),true);
    yield* Effect.promise(()=>waitFor(()=>closed>beforeClosed));yield* transport.close(sessionID);
    proof.push({scenario,idleDisabled:true,stopClosedSocket:true,bindings});return;
   }
   const exit=yield* Fiber.await(fiber);assert.equal(Exit.isFailure(exit),true);
   assert.match(String(Cause.squash(exit.cause)),/Timed out waiting for WebSocket data/);
   yield* Effect.promise(()=>waitFor(()=>closed>beforeClosed));
   proof.push({scenario,idleTimeoutMs:scenario==='default-idle'?1800000:50,heartbeatReset:scenario==='configured-idle-reset',bindings});
  })).pipe(Effect.provide(Layer.mergeAll(requestLayer,transportLayer,clientLayer)),Effect.provide(TestClock.layer()),Effect.provide(Logger.layer([],{mergeWithExisting:false})));
  await Effect.runPromise(program);
  for(const socket of clients)socket.close();clients.clear();
 }
 process.stdout.write(JSON.stringify({apiKeySessionWebSocket:true,proof}));
}finally{for(const socket of clients)socket.close();for(const socket of sockets)socket.close();server.stop(true);}
