import {expect,test} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';

test('native Tool.Called permission rescue binds the real running assistant and expires with its location',async()=>{
 const repository=path.resolve(import.meta.dirname,'../..');
 const base=path.join(repository,'.cache/v2-validation');await fs.mkdir(base,{recursive:true});
 const root=await fs.mkdtemp(path.join(base,'tool-read-permission-'));
 const home=path.join(root,'home'),tmp=path.join(home,'tmp'),directory=path.join(root,'project');
 await Promise.all([tmp,path.join(directory,'.git')].map(value=>fs.mkdir(value,{recursive:true})));
 await fs.writeFile(path.join(tmp,'package.json'),'{"type":"commonjs"}\n');
 await fs.writeFile(path.join(directory,'owned.txt'),'Actual native rescue content\n');
 const host=new URL('../../packages/web/server/lib/opencode/runtime-host/',import.meta.url).href;
 const sdk=new URL('../../packages/web/node_modules/@opencode/sdk/dist/effect/index.js',import.meta.url).href;
 let child:ReturnType<typeof Bun.spawn>|undefined;
 try{
 const source=`
 import assert from 'node:assert/strict';
 import {Effect,Layer,Logger,Cause} from 'effect';
 import {Global} from '@opencode/util/global';
 import {Bus} from '@opencode/core/bus';
 import {Tool} from '@opencode/core/tool';
 import {SessionMessage} from '@opencode/core/session/message';
 import {SessionStore} from '@opencode/core/session/store';
 import {SessionExecution} from '@opencode/core/session/execution';
 import {LocationActivity} from '@opencode/core/location-activity';
 import {LocationServiceMap} from '@opencode/core/location-service-map';
 import {Plugin} from '@opencode/core/plugin';
 import {makeGlobalNode} from '@opencode/util/effect/app-node';
 import {createLLMEventPublisher} from '@opencode/core/session/runner/publish-llm-event';
 const {OpenCode}=await import(${JSON.stringify(sdk)});
 const {createAdmissionGates}=await import(${JSON.stringify(host+'admission-gates.ts')});
 const {configurationOverrides}=await import(${JSON.stringify(host+'configuration.ts')});
 const {createReviewedNativePluginRegistry}=await import(${JSON.stringify(host+'native-plugin-registry.ts')});
 const directory=process.env.DEVRYAN_GRAPH_DIRECTORY,target=directory+'/owned.txt';
 const assertions=new Map(),evaluations=[],requests=[];let variant={},retained,store,map,bus;
 const bridge={awaitReady:async()=>{},authorize:async r=>{requests.push(r);return {token:'d'.repeat(64),revision:0,sessionID:r.sessionID};},recheck:async()=>{},release:async()=>{},sealPrompt:async()=>({}),verifyAccepted:async()=>{},registerShellJob:async()=>{},sealSynthetic:async()=>({}),deferContinuation:async()=>{},hold:async()=>{},releaseHold:async()=>{},isHeld:async()=>false};
 const gates=createAdmissionGates({bridge,nativePlugins:createReviewedNativePluginRegistry('c'.repeat(64)),
 sessionHooks:(inner,location,owners)=>{assertions.set(location.directory,owners.assertToolRead);return {...inner,trigger:(domain,name,event)=>{if(domain==='permission'&&name==='evaluate')evaluations.push(event);return inner.trigger(domain,name,event);}};},
 executeOwned:invocation=>Effect.gen(function*(){
  const event={...invocation.nativeContext,tool:invocation.toolID,...variant};
  const rescue=assertions.get(invocation.location.directory)(event,target);
  const context=yield* Effect.context();retained=rescue.pipe(Effect.provideContext(context));
  yield* rescue;return yield* invocation.executeNative();
 })});await gates.controls.openStartup();
 const overrides=[...configurationOverrides({}),Global.node.replace(Global.layerWith({home:process.env.HOME,config:process.env.XDG_CONFIG_HOME,data:process.env.XDG_DATA_HOME,state:process.env.XDG_STATE_HOME,cache:process.env.XDG_CACHE_HOME,tmp:process.env.TMPDIR,bin:process.env.HOME+'/bin',log:process.env.HOME+'/log',repos:process.env.HOME+'/repos'})),...gates.overrides,
 LocationActivity.node.replace(makeGlobalNode({service:LocationActivity.Service,deps:[Bus.node,SessionExecution.node,LocationServiceMap.node,SessionStore.node],layer:Layer.effect(LocationActivity.Service,Effect.gen(function*(){bus=yield* Bus.Service;store=yield* SessionStore.Service;map=yield* LocationServiceMap.Service;return yield* LocationActivity.Service;})).pipe(Layer.provide(LocationActivity.layer()))}))];
 const reject=Effect.fn(function*(action,code){const exit=yield* Effect.exit(action);assert.equal(exit._tag,'Failure');assert.match(String(Cause.squash(exit.cause)),new RegExp(code));});
 await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
  const api=yield* OpenCode.create({database:{path:':memory:'},config:{project:false},models:{fetch:false,snapshot:false},fs:{filewatcher:false,fff:false},events:{persist:false}},{overrides});
  const session=yield* api.sessions.create({location:{directory},permissions:[{action:'read',resource:'*',effect:'allow'}]});
  const foreign=yield* api.sessions.create({location:{directory},permissions:[{action:'read',resource:'*',effect:'allow'}]});
  yield* api.agent.list({location:{directory}});
  const at=action=>action.pipe(Effect.provide(LocationServiceMap.Service.get({directory})),Effect.provideService(LocationServiceMap.Service,map));
  const tool=yield* at(Effect.gen(function*(){yield* (yield* Plugin.Service).awaitActivation;return (yield* (yield* Tool.Service).list()).find(tool=>tool.id==='read');}));assert.ok(tool);
  const messageID=SessionMessage.ID.create(),callID='call_native_rescue';
  const publisher=createLLMEventPublisher(bus,{sessionID:session.id,agent:'build',model:{providerID:'opencode',id:'fixture'},providerMetadataKey:'fixture',started:Date.now(),assistantMessageID:messageID});
  yield* publisher.publish({type:'tool-call',id:callID,name:'read',input:{path:target}});
  const actual=yield* store.message(messageID);assert.equal(actual.message.type,'assistant');assert.equal(actual.message.time.completed,undefined);
  assert.ok(actual.message.content.some(part=>part.type==='tool'&&part.id===callID&&part.name==='read'&&part.state.status==='running'));
  const event={sessionID:session.id,messageID,id:callID,tool:'read',agent:'build'};
  const execute=()=>tool.execute({path:target},{...event,progress:()=>Effect.void});
  yield* reject(assertions.get(directory)(event,target),'native_tool_hook_scope_invalid');
  const result=yield* execute();assert.match(JSON.stringify(result),/Actual native rescue content/);
  assert.ok(evaluations.some(value=>value.sessionID===session.id&&value.action==='read'&&value.source?.type==='tool'&&value.source.messageID===messageID&&value.source.id===callID));
  for(const forged of [{sessionID:foreign.id},{id:'call_forged'},{tool:'write'},{messageID:SessionMessage.ID.create()},{agent:'plan'}]){variant=forged;yield* reject(execute(),'native_tool_hook_scope_invalid');}variant={};
  yield* publisher.toolExecution(callID,'read',{content:[{type:'text',text:'Native read completed'}]});
  assert.equal((yield* store.message(messageID)).message.content.find(part=>part.type==='tool').state.status,'completed');
  yield* reject(execute(),'native_tool_hook_scope_invalid');
  // A second actual native call remains running when the assistant completes.
  const second=SessionMessage.ID.create(),running='call_after_assistant';
  const ended=createLLMEventPublisher(bus,{sessionID:session.id,agent:'build',model:{providerID:'opencode',id:'fixture'},providerMetadataKey:'fixture',started:Date.now(),assistantMessageID:second});
  yield* ended.publish({type:'tool-call',id:running,name:'read',input:{path:target}});
  yield* ended.failAssistant({type:'aborted',message:'Actual native assistant interrupted'});yield* ended.publishStepFailure();
  assert.notEqual((yield* store.message(second)).message.time.completed,undefined);
  variant={messageID:second,id:running};yield* reject(execute(),'native_tool_hook_scope_invalid');variant={};
  const liveID=SessionMessage.ID.create();const live=createLLMEventPublisher(bus,{sessionID:session.id,agent:'build',model:{providerID:'opencode',id:'fixture'},providerMetadataKey:'fixture',started:Date.now(),assistantMessageID:liveID});
  yield* live.publish({type:'tool-call',id:'call_reload',name:'read',input:{path:target}});
  variant={messageID:liveID,id:'call_reload'};yield* execute();const old=retained;
  yield* LocationServiceMap.reload().pipe(Effect.provideService(LocationServiceMap.Service,map));
  yield* reject(old,'native_tool_hook_scope_invalid|native_permission_location_expired');
  assert.ok(requests.some(request=>request.operation==='tool.execute'&&request.messageID===messageID&&request.input.callID===callID));
 }).pipe(Effect.provide(Logger.layer([],{mergeWithExisting:false})))));
 process.stdout.write(JSON.stringify({actualToolCalled:true,actualRead:true,nativePermissionSource:true,forgedRefused:5,completedToolRefused:true,completedAssistantRefused:true,reloadRefused:true}));
 `;
 child=Bun.spawn([process.execPath,'--eval',source],{cwd:repository,env:{PATH:'/usr/bin:/bin',HOME:home,TMPDIR:tmp,XDG_CONFIG_HOME:path.join(home,'config'),XDG_DATA_HOME:path.join(home,'data'),XDG_CACHE_HOME:path.join(home,'cache'),XDG_STATE_HOME:path.join(home,'state'),GIT_CEILING_DIRECTORIES:root,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',DEVRYAN_GRAPH_DIRECTORY:directory},stdin:'ignore',stdout:'pipe',stderr:'pipe'});
 const timer=setTimeout(()=>child?.kill('SIGKILL'),40_000);
 try{const stdout=child.stdout,stderr=child.stderr;if(!stdout||typeof stdout==='number'||!stderr||typeof stderr==='number')throw Error('Owned pipes required');
 const [output,errors,code]=await Promise.all([new Response(stdout).text(),new Response(stderr).text(),child.exited]);
 if(code!==0)throw Error(errors.slice(0,12000));expect(code).toBe(0);expect(errors).toBe('');
 expect(JSON.parse(output)).toEqual({actualToolCalled:true,actualRead:true,nativePermissionSource:true,forgedRefused:5,completedToolRefused:true,completedAssistantRefused:true,reloadRefused:true});
 }finally{clearTimeout(timer);}
 }finally{if(child&&child.exitCode===null){child.kill('SIGKILL');await child.exited;}await fs.rm(root,{recursive:true,force:true});}
},45_000);
