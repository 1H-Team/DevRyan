import { expect,test } from 'bun:test';
import { Effect, Schema } from 'effect';
import { Location } from '@opencode/core/location';
import { WorkerInput } from '../../packages/web/server/lib/opencode/runtime-host/worker-protocol.js';
import type { OwnedToolInvocation } from '../../packages/web/server/lib/opencode/runtime-host/native-admission-contract.js';
import { managedTaskInputSchema,withManagedTaskExecution } from '../../packages/web/server/lib/opencode/runtime-host/managed-task.js';
import { councilInputSchema,withCouncilExecution } from '../../packages/web/server/lib/opencode/runtime-host/council.js';

const origin={kind:'plugin',id:'devryan.managed-task',manifestDigest:'a'.repeat(64),capabilities:['managed-task']} as const;
const councilOrigin={...origin,id:'devryan.council'};
const context=Schema.decodeUnknownSync(WorkerInput)({protocol:1,tool:'write',input:{},directory:'/fixture/view',projectDirectory:'/fixture/view',logicalDirectory:'/fixture/project',logicalProjectDirectory:'/fixture/project',scratchDirectory:'/fixture/scratch',config:{},context:{sessionID:'ses_root',agent:'orchestrator',messageID:'msg_assistant',id:'call_managed'}}).context;
const invocation=(toolID:string,input:unknown):OwnedToolInvocation=>({toolID,input,provenance:toolID==='council_session'?councilOrigin:origin,
  location:Schema.decodeUnknownSync(Location.Info)({directory:'/reviewed/project',project:{id:'global',directory:'/reviewed/project',canonical:'/reviewed/project'}}),
  nativeContext:{...context,progress:()=>Effect.void},
  existingPermit:{token:'private',revision:1,sessionID:'ses_root'},recheckPermit:()=>Effect.void,nativePermissionAssert:()=>Effect.void,
  executeNative:()=>Effect.die(new Error('must remain host-owned'))});

test('native schemas expose the complete managed action contract and refuse caller execution overrides',()=>{
  const decode=(input:unknown)=>Schema.decodeUnknownSync(managedTaskInputSchema)(input,{onExcessProperty:'error'});
  for(const input of [
    {action:'start',agent:'fixer',prompt:'Fix',required_checks:[{name:'unit',command:'bun test',paths:['app.js']}]},
    ...['status','wait','cancel','continue','retry','resume','abandon'].map(action=>({action,task_id:'dvr_task_one'})),
    {action:'wait_any',task_ids:['dvr_task_one']},{action:'read_result',task_id:'dvr_task_one',result_cursor:'cursor'},
    {action:'plan_read'},{action:'plan_update',expected_version:'version',text:'# Progress'},
    {action:'checkpoint'},{action:'decisions',query:'dependencies'},
    {action:'remember_decision',decision:'Keep dependencies unchanged.',source_message_id:'msg_user'},
  ]) { const decoded:unknown=decode(input); expect(decoded).toEqual(input); }
  expect(()=>decode({action:'start',agent:'fixer',prompt:'Fix',provider_id:'caller'})).toThrow();
  expect(()=>decode({action:'plan_update',expected_version:1,text:'# Progress'})).toThrow();
  expect(()=>Schema.decodeUnknownSync(councilInputSchema)({prompt:'Compare',models:['caller']},{onExcessProperty:'error'})).toThrow();
});
test('composed native executors retain exact reviewed provenance, canonical location and original recheck',async()=>{
  const calls:{method:string;input:Record<string,unknown>}[]=[];let checks=0;
  const rpc=async(method:string,input:Record<string,unknown>)=>{calls.push({method,input});return {result:'owned'};};
  const task=withManagedTaskExecution({origin,directory:'/unused-default',rpc,executeOwned:()=>Effect.die(new Error('unknown tool'))});
  const execute=withCouncilExecution({origin:councilOrigin,rpc,executeOwned:task});
  for(const [toolID,input] of [['devryan_task',{action:'status',task_id:'dvr_task_one'}],['council_session',{prompt:'Compare',preset:'default'}]] as const){
    const call=invocation(toolID,input);
    const result=await Effect.runPromise(execute({...call,recheckPermit:()=>Effect.sync(()=>{checks++;})}));
    expect(result.content).toBe('{"result":"owned"}');
  }
  expect(checks).toBe(3);expect(calls.map(row=>row.method)).toEqual(['native.managed-task','native.council']);
  for(const row of calls){expect(row.input.directory).toBe('/reviewed/project');expect(row.input.authorization).toMatchObject({operation:'tool.execute',input:{callID:'call_managed'}});}
  const forged=invocation('council_session',{prompt:'Compare'});
  await expect(Effect.runPromise(execute({...forged,provenance:{...forged.provenance,manifestDigest:'forged'}}))).rejects.toThrow('origin_mismatch');
  await expect(Effect.runPromise(execute({...forged,recheckPermit:()=>Effect.die(Error('revoked'))}))).rejects.toThrow('revoked');
  expect(calls).toHaveLength(2);
});

test('attached waits repeat bounded slices with unchanged input and original authority',async()=>{
  for(const action of ['wait','wait_any'] as const){
    const input=action==='wait'?{action,task_id:'dvr_task_one'}:{action,task_ids:['dvr_task_one'],after_cursor:'original_cursor'};
    const call=invocation('devryan_task',input),requests:Readonly<Record<string,unknown>>[]=[],signals:AbortSignal[]=[];let checks=0;
    const rpc=async(_method:string,request:Readonly<Record<string,unknown>>,options?:{readonly signal?:AbortSignal})=>{
      requests.push(request);if(options?.signal)signals.push(options.signal);
      const finished=requests.length===3;
      return action==='wait'
        ? {task:{taskId:'dvr_task_one',rootSessionId:'ses_root',directory:'/reviewed/project',status:finished?'completed':'running'}}
        : {schemaVersion:2,rootSessionId:'ses_root',cursor:'slice_cursor',settled:finished,pendingTaskIds:finished?[]:['dvr_task_one'],readyTaskIds:finished?['dvr_task_one']:[],attention:[],changedTaskIds:finished?['dvr_task_one']:[]};
    };
    const execute=withManagedTaskExecution({origin,directory:'/unused',rpc,executeOwned:()=>Effect.die(Error('unknown'))});
    const result=await Effect.runPromise(execute({...call,recheckPermit:()=>Effect.sync(()=>{checks++;})}));
    expect(requests).toHaveLength(3);expect(checks).toBe(6);expect(signals).toHaveLength(3);
    expect(requests.every(request=>JSON.stringify(request)===JSON.stringify(requests[0]))).toBe(true);
    expect(requests[0]?.input).toEqual(input);expect(requests[0]?.authorization).toMatchObject({input:{input}});
    if(typeof result.content!=='string')throw Error('Owned JSON content required');
    expect(JSON.parse(result.content)).toMatchObject(action==='wait'?{task:{status:'completed'}}:{settled:true});
  }
});
test('attached waits refuse revocation after a slice and malformed live transport results',async()=>{
  let calls=0,checks=0;
  const input={action:'wait',task_id:'dvr_task_one'},call=invocation('devryan_task',input);
  const rpc=async()=>{calls++;return {task:{taskId:'dvr_task_one',rootSessionId:'ses_root',directory:'/reviewed/project',status:'running'}};};
  const execute=withManagedTaskExecution({origin,directory:'/unused',rpc,executeOwned:()=>Effect.die(Error('unknown'))});
  await expect(Effect.runPromise(execute({...call,recheckPermit:()=>++checks===3?Effect.die(Error('revoked')):Effect.void}))).rejects.toThrow('revoked');
  expect(calls).toBe(1);
  const malformed=withManagedTaskExecution({origin,directory:'/unused',rpc:async()=>({task:{status:'running'}}),executeOwned:()=>Effect.die(Error('unknown'))});
  await expect(Effect.runPromise(malformed(call))).rejects.toThrow('native_task_wait_response_invalid');
});

test('real SDK activates managed and Council registrations with reviewed per-location authority',async()=>{
  const fs=await import('node:fs/promises'),path=await import('node:path');
  const base=path.resolve(import.meta.dirname,'../../.cache/v2-validation');
  const root=await fs.mkdtemp(path.join(base,'native-managed-registry-')),scratch=path.join(root,'scratch'),directory=path.join(root,'project');
  await fs.mkdir(path.join(scratch,'tmp'),{recursive:true});await fs.mkdir(directory);
  await fs.writeFile(path.join(scratch,'tmp','package.json'),'{"type":"commonjs"}\n');
  const host=new URL('../../packages/web/server/lib/opencode/runtime-host/',import.meta.url).href;
  const source=`
    import {Effect,Layer,Logger} from 'effect';
    import {Global} from '@opencode/util/global';
    import {Plugin} from '@opencode/core/plugin';
    import {Tool} from '@opencode/core/tool';
    const {OpenCode}=await import(${JSON.stringify(new URL('../../packages/web/node_modules/@opencode/sdk/dist/effect/index.js',import.meta.url).href)});
    const {trustedPluginOverride}=await import(${JSON.stringify(`${host}trusted-plugins.ts`)});
    const {createAdmissionGates}=await import(${JSON.stringify(`${host}admission-gates.ts`)});
    const {configurationOverrides}=await import(${JSON.stringify(`${host}configuration.ts`)});
    const {managedTaskPlugin}=await import(${JSON.stringify(`${host}managed-task.ts`)});
    const {councilPlugin}=await import(${JSON.stringify(`${host}council.ts`)});
    const {nativeSessionContextPlugin}=await import(${JSON.stringify(`${host}native-session-context.ts`)});
    const rows=[],directory=process.env.DEVRYAN_GRAPH_DIRECTORY,scratch=process.env.HOME;
    const bridge={awaitReady:async()=>{},authorize:async request=>({token:'b'.repeat(64),revision:0,sessionID:request.sessionID}),
      recheck:async()=>{},release:async()=>{},sealPrompt:async()=>({}),verifyAccepted:async()=>{},registerShellJob:async()=>{},sealSynthetic:async()=>{},deferContinuation:async()=>{},hold:async()=>{},releaseHold:async()=>{},isHeld:async()=>false};
    const gates=createAdmissionGates({bridge,nativePlugins:new Map(),executeOwned:call=>Effect.sync(()=>{
      rows.push({toolID:call.toolID,input:call.input,origin:call.provenance,directory:call.location.directory});return {content:'registered'};})});
    await gates.controls.openStartup();let tools,plugins;
    const capture=Plugin.node.replace(Plugin.node.mapLayer(layer=>Layer.effect(Plugin.Service,Effect.gen(function*(){tools=yield* Tool.Service;plugins=yield* Plugin.Service;return plugins;})).pipe(Layer.provide(layer))));
    const reviewed=[managedTaskPlugin,councilPlugin,nativeSessionContextPlugin].map(plugin=>({plugin,origin:{kind:'plugin',id:plugin.id,manifestDigest:'a'.repeat(64),capabilities:['managed-task']}}));
    await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
      const sdk=yield* OpenCode.create({database:{path:':memory:'},config:{project:false},models:{fetch:false,snapshot:false},fs:{filewatcher:false,fff:false},events:{persist:false}},
        {overrides:[...configurationOverrides({}),Global.node.replace(Global.layerWith({home:scratch,data:scratch+'/data',cache:scratch+'/cache',config:scratch+'/config',state:scratch+'/state',tmp:scratch+'/tmp',bin:scratch+'/bin',log:scratch+'/log',repos:scratch+'/repos'})),trustedPluginOverride({plugins:reviewed,additionalOrigins:[],nativePlugins:new Map()}),...gates.overrides,capture]});
      yield* sdk.agent.list({location:{directory}});yield* plugins.awaitActivation;
      const snapshot=yield* tools.snapshot([{action:'*',resource:'*',effect:'allow'}]);
      const session=yield* sdk.sessions.create({location:{directory}});
      for(const call of [{name:'devryan_task',input:{action:'wait_any',task_ids:['dvr_task_one']}},{name:'devryan_task',input:{action:'plan_update',expected_version:'version',text:'# Progress'}},{name:'council_session',input:{prompt:'Compare',preset:'default'}},{name:'todoread',input:{}},{name:'todowrite',input:{todos:[{id:'one',content:'Verify',status:'in_progress',priority:'high'}]}}])
        yield* snapshot.execute({sessionID:session.id,messageID:'msg_graph',agent:'orchestrator',call:{type:'tool-call',id:'call_graph',...call}});
    }).pipe(Effect.provide(Logger.layer([],{mergeWithExisting:false})))));
    process.stdout.write(JSON.stringify(rows));
  `;
  const child=Bun.spawn([process.execPath,'--eval',source],{cwd:path.resolve(import.meta.dirname,'../..'),env:{PATH:'/usr/bin:/bin',HOME:scratch,TMPDIR:path.join(scratch,'tmp'),
    XDG_CONFIG_HOME:path.join(scratch,'config'),XDG_DATA_HOME:path.join(scratch,'data'),XDG_CACHE_HOME:path.join(scratch,'cache'),XDG_STATE_HOME:path.join(scratch,'state'),
    GIT_CEILING_DIRECTORIES:root,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',DEVRYAN_GRAPH_DIRECTORY:directory},stdin:'ignore',stdout:'pipe',stderr:'pipe'});
  const timer=setTimeout(()=>child.kill('SIGKILL'),20000);
  try{
    const out=child.stdout,err=child.stderr;if(!out||typeof out==='number'||!err||typeof err==='number')throw Error('Owned pipes required');
    const [stdout,stderr,exit]=await Promise.all([new Response(out).text(),new Response(err).text(),child.exited]);expect({stderr,exit}).toEqual({stderr:'',exit:0});
    const rows:{toolID:string;origin:{id:string};directory:string}[]=JSON.parse(stdout);
    expect(rows.map(row=>[row.toolID,row.origin.id,row.directory])).toEqual([['devryan_task','devryan.managed-task',directory],['devryan_task','devryan.managed-task',directory],['council_session','devryan.council',directory],['todoread','devryan.harness-context',directory],['todowrite','devryan.harness-context',directory]]);
  }finally{clearTimeout(timer);if(child.exitCode===null){child.kill('SIGKILL');await child.exited;}await fs.rm(root,{recursive:true,force:true});}
},25000);
