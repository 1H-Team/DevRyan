import {Effect} from 'effect';
// Test-only executable: the Node parent installs owned HOME/XDG/TMP before imports.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createInterface} from 'node:readline';
import {createNativeRuntimeHost} from '../../packages/web/server/lib/opencode/runtime-host/bootstrap.js';
import {createExecutionRouting} from '../../packages/web/server/lib/opencode/runtime-host/execution-routing.js';
import {createControllerHelper} from '../../packages/web/server/lib/opencode/runtime-host/controller-processes.js';
import {createRemoteNativeAdmissionBridge} from '../../packages/web/server/lib/opencode/runtime-host/native-admission-bridge.js';
import {createReviewedNativePluginRegistry} from '../../packages/web/server/lib/opencode/runtime-host/native-plugin-registry.js';
import {createNativeSessionContext,nativeSessionContextPlugin} from '../../packages/web/server/lib/opencode/runtime-host/native-session-context.js';
import {runWithRequestPermit,requestPermit} from '../../packages/web/server/lib/opencode/runtime-host/native-admission-contract.js';
import {primaryStepOverride} from '../../packages/web/server/lib/opencode/runtime-host/primary-step.js';
import {makeNativeSimulation} from './simulation.js';
import {attachDriveController} from './drive-controller.mjs';

const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const text=(value:unknown):string=>{if(typeof value!=='string'||!value)throw Error('todo_fixture_string_required');return value;};
const settings:unknown=JSON.parse(await fs.readFile(text(process.argv[2]),'utf8'));
if(!record(settings))throw Error('todo_fixture_settings_invalid');
const root=await fs.realpath(text(settings.root));
for(const name of ['HOME','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME','TMPDIR']){
 const actual=await fs.realpath(text(process.env[name]));assert.ok(actual.startsWith(root+path.sep));
}
const rpc=async(method:string,input:unknown,options?:{readonly signal?:AbortSignal}):Promise<unknown>=>{
 const response=await fetch(text(settings.bridgeUrl),{method:'POST',headers:{authorization:`Bearer ${text(settings.bridgeToken)}`,
  'content-type':'application/json',connection:'close'},body:JSON.stringify({method,params:input}),signal:options?.signal??AbortSignal.timeout(30_000)});
 const value:unknown=await response.json();
 if(!response.ok||!record(value)||value.ok!==true)throw Error(record(value)&&record(value.error)?String(value.error.code):'todo_fixture_rpc_failed');
 return value.result;
};
const origin={kind:'plugin' as const,id:'devryan.harness-context',manifestDigest:text(settings.contextDigest),capabilities:['control'] as const};
const simulationOrigin={kind:'plugin' as const,id:'opencode.simulation.tools',manifestDigest:text(settings.simulationDigest),capabilities:['provider'] as const};
const bridge=createRemoteNativeAdmissionBridge({rpc});
const routing=createExecutionRouting({rpc,bridge,directory:text(settings.directory),readRoots:[text(settings.directory)],protectedRoots:[path.join(root,'home'),path.join(root,'web-data')]});
const context=createNativeSessionContext({origin,rpc,executeOwned:routing.executeOwned});
const simulation=makeNativeSimulation(text(settings.simulationEndpoint),simulationOrigin);
const host:Awaited<ReturnType<typeof createNativeRuntimeHost>>=await createNativeRuntimeHost({databasePath:text(settings.databasePath),token:text(settings.token),configuration:settings.configuration,
 plugins:[{plugin:nativeSessionContextPlugin,origin}],additionalPluginOrigins:[simulationOrigin],bridge,
 executeOwned:context.withPrimaryToolExecution(context.executeOwned),sessionHooks:context.decorateHooks,
 nativePlugins:createReviewedNativePluginRegistry(text(settings.coreDigest)),executionOverrides:[...routing.overrides,primaryStepOverride(rpc,undefined,event=>host?host.wakeQueuedParents(event):Effect.void,undefined,undefined,undefined,undefined,events=>host?host.prepareQueuedPublication(events):Effect.succeed([]),event=>host?host.assertQueuedPublication(event):Effect.void)],
 platformOverrides:simulation.overrides,controllerHelper:createControllerHelper({rpc}),drainExecutions:routing.close});
let phase:'initial'|'recovered'='initial',issued=false,finished=false;
const driver=await attachDriveController(simulation.endpoint,request=>{
 assert.ok(record(request.body)&&Array.isArray(request.body.messages));
 const messages=request.body.messages;
 const continuation=messages.some(message=>JSON.stringify(message).includes('[devryan-open-todo-continuation:v1]'));
 assert.equal(continuation,phase==='recovered','Unexpected native TODO inference objective');
 const callID=phase==='initial'?'todo_initial':'todo_recovered';
 const result=messages.find(message=>record(message)&&message.role==='tool'&&message.tool_call_id===callID);
 if(result){assert.ok(issued&&!finished);finished=true;return {items:[{type:'textDelta',text:phase==='initial'?'TODO remains open':'TODO is complete'}],reason:'stop'};}
 assert.equal(issued,false,'Repeated native TODO write');issued=true;
 assert.ok(Array.isArray(request.body.tools)&&request.body.tools.some(tool=>record(tool)&&record(tool.function)&&tool.function.name==='todowrite'));
 return {items:[{type:'toolCall',index:0,id:callID,name:'todowrite',input:{todos:[{id:'verify',content:'Verify actual native TODO continuation',priority:'high',status:phase==='initial'?'pending':'completed'}]}}],reason:'tool-calls'};
});
const write=(value:unknown)=>process.stdout.write(`DEVRYAN_NATIVE_ACCEPTANCE ${JSON.stringify(value)}\n`);
let closing:Promise<void>|undefined;
const close=()=>closing??=(async()=>{try{await host.close();}finally{await driver.close();}})();
write({type:'ready',url:host.url});
const lines=createInterface({input:process.stdin});
const active=new Set<Promise<void>>();
const handle=async(value:unknown)=>{
 if(!record(value)||!Number.isSafeInteger(value.id))throw Error('todo_fixture_command_invalid');
 const id=value.id;
 try{
  let result:unknown;
  if(value.action==='open')await host.openStartup();
  else if(value.action==='recovered'){phase='recovered';issued=false;finished=false;}
  else if(value.action==='state'){driver.check();result={phase,issued,finished,requests:driver.requests.length};}
  else if(value.action==='reconcile-primary-owned')result=await runWithRequestPermit(new Headers({'x-devryan-native-permit':JSON.stringify(value.permit)}),async()=>{const permit=requestPermit();if(!permit)throw Error('todo_fixture_permit_required');return host.reconcilePrimaryOwned({sessionID:text(value.sessionID),messageID:text(value.messageID),permit});});
  else if(value.action==='queued-primary-idle-owned'){const permit=runWithRequestPermit(new Headers({'x-devryan-native-permit':JSON.stringify(value.permit)}),async()=>{const owned=requestPermit();if(!owned)throw Error('todo_fixture_permit_required');return host!.queuedPrimaryIdleOwned({sessionID:text(value.sessionID),messageID:text(value.messageID),permit:owned});});result=await permit;}
  else if(value.action==='hold')result=await host.holdAndStop(text(value.sessionID));
  else if(value.action==='close')await close();
  else throw Error('todo_fixture_action_unknown');
  write({id,ok:true,result});
 }catch(error){write({id,ok:false,error:error instanceof Error?error.message:'todo_fixture_failed'});}
};
try{
 for await(const line of lines){
  if(Buffer.byteLength(line)>64*1024||active.size>=8)throw Error('todo_fixture_command_bound');
  const work=handle(JSON.parse(line));active.add(work);void work.finally(()=>active.delete(work));
  if(JSON.parse(line).action==='close'){await work;break;}
 }
 await Promise.all(active);await close();
}catch(error){try{await close();}finally{write({type:'failed',error:error instanceof Error?error.message:'todo_fixture_failed'});process.exitCode=1;}}
