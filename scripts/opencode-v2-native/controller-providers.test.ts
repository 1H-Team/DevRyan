import {expect,test} from 'bun:test';
import {LLMRequest} from '@opencode/ai';
import * as OpenAI from '@opencode/ai/providers/openai';
import {Agent} from '@opencode/core/agent';
import {Location} from '@opencode/core/location';
import {SessionModelRequest} from '@opencode/core/session/model-request';
import {SessionRunnerModel} from '@opencode/core/session/runner/model';
import {SessionSchema} from '@opencode/core/session/schema';
import {Model} from '@opencode/schema/model';
import {Effect,Schema,Scope} from 'effect';
import {createControllerProviders} from '../../packages/web/server/lib/opencode/runtime-host/controller-providers.js';

const directory='/owned/provider-policy';
const location=Schema.decodeUnknownSync(Location.Info)({directory,project:{id:'global',directory,canonical:directory}});
const agent=Schema.decodeUnknownSync(Agent.ID)('build');
const model=OpenAI.responses('gpt-5-fixture');
const input:SessionModelRequest.Input={get session():SessionSchema.Info{throw Error('OpenAI transport policy must not read session data');},agent,
 model:SessionRunnerModel.resolved(model,{capabilities:{tools:true,input:['text'],output:['text']},cost:[],limit:{context:32768,input:16384,output:4096}}),system:[],messages:[]};
const event={sessionID:Schema.decodeUnknownSync(SessionSchema.ID)('ses_policy'),agent,model:Schema.decodeUnknownSync(Model.Ref)({providerID:'openai',id:'gpt-5-fixture'}),system:[],messages:[],options:{},tools:{}};
const webSocket={execute:()=>Effect.die('Physical socket must not execute during preparation')};
const prepared={event,request:new LLMRequest({model,system:[],messages:[],tools:[]}),options:{webSocket,http:(request,handler)=>handler(request)},
 retry:()=>Effect.void,executeTool:()=>Effect.die('Tools must not execute during preparation')} satisfies SessionModelRequest.Prepared<typeof event>;
const inner:SessionModelRequest.Interface={primary:()=>Effect.succeed(prepared),title:()=>Effect.succeed(prepared),compaction:()=>Effect.succeed(prepared),generate:()=>Effect.succeed(prepared)};
const agents:Agent.Interface={get:()=>Effect.die('No agent read'),resolve:()=>Effect.die('No agent read'),select:()=>Effect.die('No agent read'),list:()=>Effect.die('No agent read'),transform:()=>Effect.die('No agent mutation'),reload:()=>Effect.die('No agent reload')};
const create=(policy:(directory:string)=>Effect.Effect<boolean>)=>createControllerProviders({controllerInstanceID:'controller-policy',
 configurationSnapshot:{schema:1,revision:0,sourceStamp:'fixture',digest:'a'.repeat(64),registrationManifestDigest:'b'.repeat(64),locations:[{directory,configuration:{},skills:[],instructions:[],textReferences:[],aliases:[],activePlugins:[],compatibility:{legacy:{},agents:{},commands:{},slim:{},mcp:{}},requiredCatalogs:{agents:[],plugins:[],tools:[],models:[],skills:[],commands:[],mcp:[]}}]},
 origin:{kind:'plugin',id:'devryan.provider-compat',manifestDigest:'b'.repeat(64),capabilities:['provider']},scrubSystem:text=>text,
 integrations:{requiresOpenAiHttp:policy,discoverCopilot:()=>Effect.succeed(undefined),readCatalogSelectionOwned:async()=>{throw Error('No catalog read');}},rpc:async()=>{throw Error('No RPC');},isBound:()=>true,isExecutionReady:()=>true});
const run=<A,E>(effect:Effect.Effect<A,E,Location.Service|Agent.Service|Scope.Scope>)=>Effect.runPromise(Effect.scoped(effect.pipe(Effect.provideService(Location.Service,location),Effect.provideService(Agent.Service,agents))));

test('prepared OpenAI requests follow current SIWC policy for every request kind and retain all other behavior',async()=>{
 let siwc=false,calls=0;
 const providers=create(actualDirectory=>Effect.sync(()=>{expect(actualDirectory).toBe(directory);calls++;return siwc;}));
 await run(Effect.gen(function*(){
  const requests=yield* providers.decorateModelRequests(inner);
  for(const selection of [false,true,false]){
   siwc=selection;
   for(const kind of ['primary','title','compaction','generate'] as const){
    const result=yield* requests[kind](input);
    if(!selection){expect(result).toBe(prepared);expect(result.options.webSocket).toBe(webSocket);continue;}
    expect(result.options.webSocket).toBeUndefined();expect(Object.hasOwn(result.options,'webSocket')).toBe(false);
    expect(result.request).toBe(prepared.request);expect(result.event).toBe(event);expect(result.options.http).toBe(prepared.options.http);
    expect(result.retry).toBe(prepared.retry);expect(result.executeTool).toBe(prepared.executeTool);
   }
  }
 }));
 expect(calls).toBe(12);providers.close();
});

test('prepared HTTP skips selection reads while websocket policy errors fail closed',async()=>{
 const http={...prepared,options:{http:prepared.options.http}};
 let calls=0;
 const providers=create(()=>Effect.sync(()=>{calls++;throw Error('selection unavailable');}));
 await run(Effect.gen(function*(){
  const requests=yield* providers.decorateModelRequests({...inner,title:()=>Effect.succeed(http)});
  expect(yield* requests.title(input)).toBe(http);expect(calls).toBe(0);
  const result=yield* Effect.exit(requests.primary(input));expect(result._tag).toBe('Failure');expect(calls).toBe(1);
 }));providers.close();
});
