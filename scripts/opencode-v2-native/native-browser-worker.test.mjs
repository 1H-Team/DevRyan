import {test,expect} from 'bun:test';
import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
import {prepareReviewedNativeInputs,reviewedNativeInputPlugin} from '../native-runtime-assets.mjs';
import {createNativeAssetFixturePlugin,writeNativeFixtureOutputs} from './native-asset-fixture.mjs';
import {startSessionExecution,verifySessionExecutionLauncher} from '../../packages/harness-runtime/lib/session-execution.js';
const repository=path.resolve(import.meta.dirname,'../..'),hash=value=>createHash('sha256').update(value).digest('hex');

async function graph(writer=false){
 const root=await fs.mkdtemp(path.join(repository,'.cache/v2-validation/browser-worker-'));
 const entry=path.join(root,'exports.ts'),bundle=path.join(root,'exports.mjs');
 await fs.writeFile(entry,writer?`import ${JSON.stringify(path.join(repository,'packages/web/server/lib/opencode/runtime-host/writer-worker.ts'))};`: `export * from ${JSON.stringify(path.join(repository,'packages/web/server/lib/opencode/runtime-host/native-browser-worker.ts'))};
export * from ${JSON.stringify(path.join(repository,'packages/web/server/lib/opencode/runtime-host/native-browser-plugin.ts'))};
export * from ${JSON.stringify(path.join(repository,'packages/web/server/default-config/plugins/devryan-browser.mjs'))};`);
 const assetPlugins=writer?[await createNativeAssetFixturePlugin(repository)]:[];
 const built=await Bun.build({entrypoints:[writer?path.join(repository,'packages/web/server/lib/opencode/runtime-host/writer-worker.ts'):entry],external:['effect','@opencode/core/*','@opencode/schema/*','@opencode/plugin/*','@opencode/util/*'],target:'bun',outdir:root,naming:{entry:'exports.mjs',asset:'[name]-[hash].[ext]'},plugins:[...assetPlugins,{name:'owned-sdk-source-entry',setup(builder){builder.onResolve({filter:/^@opencode\/sdk\/effect$/},async()=>({path:await fs.realpath(path.join(repository,'packages/web/node_modules/@opencode/sdk/dist/effect/index.js'))}));}},reviewedNativeInputPlugin(await prepareReviewedNativeInputs(repository))]});
 if(!built.success)throw new AggregateError(built.logs,'Reviewed original browser worker build failed');
 await writeNativeFixtureOutputs(built.outputs);return {root,bundle};
}

test('original complete browser sequence runs in one real supervised worker with canonical lease operations',async()=>{
 const {root,bundle}=await graph();let active;
 try{
  const view=path.join(root,'worktree'),scratch=path.join(root,'scratch');await fs.mkdir(view);await fs.mkdir(scratch,{mode:0o700});
  const binary=path.join(root,'agent-browser'),config=path.join(root,'empty.json');await fs.writeFile(config,'{}');
  const source=`#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';const args=process.argv.slice(2),command=args[8];
if(command==='screenshot'){const file=path.join(process.env.AGENT_BROWSER_SCREENSHOT_DIR,'owned.png');fs.writeFileSync(file,'exact screenshot fixture');console.log(file);}else console.log('Exact CLI '+command);\n`;
  await fs.writeFile(binary,source,{mode:0o755});
  const request={protocol:1,tool:'devryan_browser',input:{command:'sequence',steps:[{command:'open',args:['http://127.0.0.1:1234']},{command:'screenshot'},{command:'close'}]},
   directory:view,projectDirectory:view,logicalDirectory:root,logicalProjectDirectory:root,scratchDirectory:scratch,browserSocketDirectory:path.join(scratch,'s'),config:{},
   reviewedBrowser:{binaryPath:binary,sha256:hash(source),configPath:config,configSha256:hash('{}')},
   context:{sessionID:'ses_owned',messageID:'msg_assistant',userMessageID:'msg_user',agent:'build',id:'call_browser'}};
  const requestFile=path.join(root,'request.json');await fs.writeFile(requestFile,JSON.stringify(request));
  const runner=path.join(root,'worker.mjs');await fs.writeFile(runner,`import fs from 'node:fs/promises';import * as originals from './exports.mjs';const {runNativeBrowserWorker}=originals;
const request=JSON.parse(await fs.readFile(${JSON.stringify(requestFile)},'utf8')),operations=[],permissions=[];
const result=await runNativeBrowserWorker(request,{signal:new AbortController().signal,assertPermission:async input=>permissions.push(input),operation:async input=>{operations.push(input);if(input.operation==='resolve')return {previewUrl:'http://127.0.0.1:1234'};if(input.operation==='acquire')return {leaseId:'lease_owned',wsUrl:'ws://127.0.0.1:1234/private-secret',previewUrl:'http://127.0.0.1:1234',clientAttached:false};return {ok:true};}},originals);
process.stdout.write(JSON.stringify({result,operations,permissions}));\n`);
  // This is a real accepted supervisor, not a hand-authored termination receipt.
  const launcher=path.join(repository,'packages/web/runtime/darwin-arm64/DevRyan-execution-darwin-arm64');
  expect(await verifySessionExecutionLauncher({launcher})).toBe(true);
  const output=[],errors=[];active=await startSessionExecution({launcher,lease:{viewDirectory:view,workingDirectory:view,projectDirectory:root},command:process.execPath,args:[runner],
   env:{PATH:'/usr/bin:/bin',GIT_CEILING_DIRECTORIES:root},socketDirectory:path.join(scratch,'s'),workerBrowsers:false,
   onOutput:({stream,data})=>(stream==='stdout'?output:errors).push(data)});
  const receipt=await active.result;active=undefined;
  expect({receipt,stderr:Buffer.concat(errors).toString()}).toMatchObject({receipt:{terminated:true,confined:true,cancelled:false,exitCode:0},stderr:''});
  expect(Buffer.concat(errors).toString()).toBe('');const row=JSON.parse(Buffer.concat(output).toString());
  const result=JSON.parse(row.result.content);expect(result.results).toHaveLength(3);expect(result.results[0].output).toBe('Exact CLI open');
  expect(result.results[2].output).toBe('Browser lease closed.');
  expect(await fs.readFile(path.join(view,'.devryan-browser/owned.png'),'utf8')).toBe('exact screenshot fixture');
  expect(row.result.content).not.toContain('private-secret');expect(row.result.content).not.toContain(binary);
  expect(row.operations.filter(value=>value.operation==='acquire')).toHaveLength(1);expect(row.operations.filter(value=>value.operation==='release')).toHaveLength(1);expect(row.operations.filter(value=>value.operation!=='assert-current').at(-1).operation).toBe('release');
  expect(row.operations.every(value=>value.scope.opencodeSessionID==='ses_owned'&&value.scope.messageID==='msg_user'&&value.scope.directory===root&&value.scope.agent==='build')).toBe(true);
  expect(row.permissions).toEqual([{sessionID:'ses_owned',agent:'build',action:'devryan_browser',resources:['*'],source:{type:'tool',messageID:'msg_assistant',id:'call_browser'}}]);
 }finally{if(active){active.cancel();await active.result;}await fs.rm(root,{recursive:true,force:true});}
},30_000);

test('reviewed original browser plugin registers in the actual SDK snapshot under captured location/provenance',async()=>{
 const {root,bundle}=await graph();let child;
 try{
  const home=path.join(root,'home'),tmp=path.join(home,'tmp'),directory=path.join(root,'project');await fs.mkdir(tmp,{recursive:true});await fs.mkdir(directory);await fs.writeFile(path.join(tmp,'package.json'),'{"type":"commonjs"}\n');
  const host=path.join(repository,'packages/web/server/lib/opencode/runtime-host');
  const runner=path.join(root,'registry.mjs');await fs.writeFile(runner,`
import {Effect,Layer,Logger} from 'effect';import {Global} from '@opencode/util/global';import {Tool} from '@opencode/core/tool';import {Plugin} from '@opencode/core/plugin';
const {OpenCode}=await import(${JSON.stringify(path.join(repository,'packages/web/node_modules/@opencode/sdk/dist/effect/index.js'))});
const {trustedPluginOverride}=await import(${JSON.stringify(path.join(host,'trusted-plugins.ts'))});const {configurationOverrides}=await import(${JSON.stringify(path.join(host,'configuration.ts'))});const {createAdmissionGates}=await import(${JSON.stringify(path.join(host,'admission-gates.ts'))});
const {nativeBrowserPlugin,reviewedBrowserInputSchema}=await import('./exports.mjs');
const origin={kind:'plugin',id:'devryan.browser',manifestDigest:'a'.repeat(64),capabilities:['process']},calls=[];
const bridge={awaitReady:async()=>{},authorize:async request=>({token:'b'.repeat(64),revision:0,sessionID:request.sessionID}),recheck:async()=>{},release:async()=>{},sealPrompt:async()=>({}),verifyAccepted:async()=>{},registerShellJob:async()=>{},sealSynthetic:async()=>({}),deferContinuation:async()=>{},hold:async()=>{},releaseHold:async()=>{},isHeld:async()=>false};
const gates=createAdmissionGates({bridge,nativePlugins:new Map(),executeOwned:call=>{calls.push({toolID:call.toolID,input:call.input,location:call.location,provenance:call.provenance});return call.nativePermissionAssert({sessionID:call.nativeContext.sessionID,action:'devryan_browser',resources:['*']}).pipe(Effect.as({content:'owned browser'}));}});await gates.controls.openStartup();
let tools,plugins;const capture=Plugin.node.replace(Plugin.node.mapLayer(layer=>Layer.effect(Plugin.Service,Effect.gen(function*(){const inner=yield* Plugin.Service;tools=yield* Tool.Service;plugins=inner;return inner;})).pipe(Layer.provide(layer))));
const globals=Object.fromEntries(['home','data','cache','config','state','tmp','bin','log','repos'].map(key=>[key,key==='home'?process.env.HOME:process.env.HOME+'/'+key]));
await Effect.runPromise(Effect.scoped(Effect.gen(function*(){const sdk=yield* OpenCode.create({database:{path:':memory:'},config:{project:false},models:{fetch:false,snapshot:false},fs:{filewatcher:false,fff:false},events:{persist:false}},{overrides:[...configurationOverrides({}),Global.node.replace(Global.layerWith(globals)),trustedPluginOverride({plugins:[{plugin:nativeBrowserPlugin,origin}],additionalOrigins:[],nativePlugins:new Map()}),...gates.overrides,capture]});
yield* sdk.agent.list({location:{directory:${JSON.stringify(directory)}}});yield* plugins.awaitActivation;const snapshot=yield* tools.snapshot([{action:'*',resource:'*',effect:'allow'}]);const input={command:'sequence',steps:[{command:'snapshot'},{command:'close'}]};reviewedBrowserInputSchema.parse(input);const session=yield* sdk.sessions.create({location:{directory:${JSON.stringify(directory)}},permissions:[{action:'devryan_browser',resource:'*',effect:'allow'}]});const result=yield* snapshot.execute({sessionID:session.id,messageID:'msg_assistant',agent:'build',call:{type:'tool-call',id:'call_browser',name:'devryan_browser',input}});process.stdout.write(JSON.stringify({calls,result}));}).pipe(Effect.provide(Logger.layer([],{mergeWithExisting:false})))));`);
  child=Bun.spawn([process.execPath,runner],{cwd:repository,env:{PATH:'/usr/bin:/bin',HOME:home,TMPDIR:tmp,XDG_CONFIG_HOME:home+'/config',XDG_DATA_HOME:home+'/data',XDG_CACHE_HOME:home+'/cache',XDG_STATE_HOME:home+'/state',GIT_CEILING_DIRECTORIES:root,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'},stdout:'pipe',stderr:'pipe'});
  const timer=setTimeout(()=>child.kill('SIGKILL'),20_000);let text,errors,code;try{[text,errors,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);}finally{clearTimeout(timer);}
  expect({code,errors}).toEqual({code:0,errors:''});const row=JSON.parse(text);expect(row.calls).toHaveLength(1);expect(row.calls[0]).toMatchObject({toolID:'devryan_browser',location:{directory},provenance:{kind:'plugin',id:'devryan.browser',manifestDigest:'a'.repeat(64),capabilities:['process']},input:{command:'sequence',steps:[{command:'snapshot'},{command:'close'}]}});
  expect(row.result.content).toEqual([{type:'text',text:'owned browser'}]);
 }finally{if(child&&child.exitCode===null){child.kill('SIGKILL');await child.exited;}await fs.rm(root,{recursive:true,force:true});}
},30_000);

test('actual writer entry transports original browser permissions and lease requests over strict correlated stdio',async()=>{
 const {root,bundle}=await graph(true);let active;const abort=new AbortController();
 try{
  const view=path.join(root,'worktree'),scratch=path.join(root,'scratch');await fs.mkdir(view);await fs.mkdir(scratch,{mode:0o700});
  const binary=path.join(root,'agent-browser'),config=path.join(root,'empty.json');await fs.writeFile(config,'{}');
  const source=`#!${process.execPath}\nconsole.log('Exact CLI '+process.argv.slice(2)[8]);\n`;await fs.writeFile(binary,source,{mode:0o755});
  const request={protocol:1,tool:'devryan_browser',input:{command:'sequence',steps:[{command:'snapshot'},{command:'close'}]},
   directory:view,projectDirectory:view,logicalDirectory:root,logicalProjectDirectory:root,scratchDirectory:scratch,browserSocketDirectory:path.join(scratch,'s'),config:{},
   reviewedBrowser:{binaryPath:binary,sha256:hash(source),configPath:config,configSha256:hash('{}')},
   context:{sessionID:'ses_owned',messageID:'msg_assistant',userMessageID:'msg_user',agent:'build',id:'call_browser'}};
  const ready=Promise.withResolvers(),operations=[],permissions=[],errors=[],events=[];let pending='',failure;
  const reply=value=>ready.promise.then(()=>new Promise((resolve,reject)=>active.child.stdin.write(JSON.stringify(value)+'\n',error=>error?reject(error):resolve())));
  active=await startSessionExecution({launcher:path.join(repository,'packages/web/runtime/darwin-arm64/DevRyan-execution-darwin-arm64'),
   lease:{viewDirectory:view,workingDirectory:view,projectDirectory:root},command:process.execPath,args:[bundle],env:{PATH:'/usr/bin:/bin',GIT_CEILING_DIRECTORIES:root},
   signal:abort.signal,socketDirectory:path.join(scratch,'s'),workerBrowsers:false,interactive:true,onOutput:({stream,data})=>{
    if(stream==='stderr'){errors.push(data);return;}
    pending+=data.toString();let newline;
    while((newline=pending.indexOf('\n'))!==-1){const line=pending.slice(0,newline);pending=pending.slice(newline+1);
     try{
      const event=JSON.parse(line);events.push(event);
      if(event.type==='permission'){permissions.push(event);void reply({id:event.id,ok:true}).catch(cause=>{failure=cause;abort.abort(cause);});}
      else if(event.type==='browser'){
       operations.push(event);expect(event.scope).toEqual({opencodeSessionID:'ses_owned',messageID:'msg_user',directory:root,agent:'build'});
       const result=event.operation==='acquire'?{leaseId:'lease_owned',wsUrl:'ws://127.0.0.1:1234/private',clientAttached:false}:event.operation==='resolve'?{previewUrl:'http://127.0.0.1:1234'}:{ok:true};
       void reply({type:'browser',id:event.id,ok:true,result}).catch(cause=>{failure=cause;abort.abort(cause);});
      }else if(event.type!=='result')throw Error('unexpected worker event');
     }catch(cause){failure=cause;abort.abort(cause);}
    }
   }});ready.resolve();active.child.stdin.write(JSON.stringify(request)+'\n');
  const timeout=setTimeout(()=>abort.abort(Error('owned worker deadline')),15_000);let receipt;try{receipt=await active.result;}finally{clearTimeout(timeout);}active=undefined;
  expect({receipt,errors:Buffer.concat(errors).toString(),failure,pending}).toMatchObject({receipt:{terminated:true,confined:true,cancelled:false,exitCode:0},errors:'',failure:undefined,pending:''});
  expect(permissions).toHaveLength(1);expect(permissions[0].input.source).toEqual({type:'tool',messageID:'msg_assistant',id:'call_browser'});
  expect(operations.filter(value=>value.operation==='acquire')).toHaveLength(1);expect(operations.filter(value=>value.operation==='release')).toHaveLength(1);
  expect(new Set(operations.map(value=>value.id)).size).toBe(operations.length);
  const result=events.filter(value=>value.type==='result');expect(result).toHaveLength(1);expect(result[0].ok).toBe(true);
  expect(JSON.parse(result[0].result.content).results.map(value=>value.output)).toEqual(['Exact CLI snapshot','Browser lease closed.']);
 }finally{if(active){active.cancel();await active.result;}await fs.rm(root,{recursive:true,force:true});}
},30_000);

test('captured managed Rust daemon reaches only owned CDP through lease-local relative Unix socket policy',async()=>{
 const {root,bundle}=await graph(true);let active;const errors=[],events=[],socketNames=[];let upgraded=0,pending='',server;
 try{
  const captured=path.join(repository,'.cache/browser-upgrade/current/node_modules/agent-browser');
  expect(JSON.parse(await fs.readFile(path.join(captured,'package.json'),'utf8')).version).toBe('0.38.1');
  const binary=await fs.realpath(path.join(captured,'bin/agent-browser-darwin-arm64'));
  const view=path.join(root,'worktree'),scratch=path.join(root,'scratch'),socket=path.join(scratch,'s');await fs.mkdir(view);await fs.mkdir(scratch,{mode:0o700});
  const config=path.join(root,'empty.json');await fs.writeFile(config,'{}');
  server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request,server){if(server.upgrade(request))return;return new Response('owned fixture',{status:400});},websocket:{
   async open(ws){upgraded++;socketNames.push(...await fs.readdir(path.join(socket,'namespaces/devryan/run')).catch(()=>[]));},message(ws,value){const input=JSON.parse(String(value));ws.send(JSON.stringify({id:input.id,error:{code:-32000,message:'owned fixture endpoint refused CDP'}}));}}});
  const request={protocol:1,tool:'devryan_browser',input:{command:'snapshot'},directory:view,projectDirectory:view,logicalDirectory:root,logicalProjectDirectory:root,
   scratchDirectory:scratch,browserSocketDirectory:socket,config:{},reviewedBrowser:{binaryPath:binary,sha256:hash(await fs.readFile(binary)),configPath:config,configSha256:hash('{}')},
   context:{sessionID:'ses_owned',messageID:'msg_assistant',userMessageID:'msg_user',agent:'build',id:'call_browser'}};
  const ready=Promise.withResolvers(),controller=new AbortController();let failure;
  const reply=value=>ready.promise.then(()=>new Promise((resolve,reject)=>active.child.stdin.write(JSON.stringify(value)+'\n',cause=>cause?reject(cause):resolve())));
  active=await startSessionExecution({launcher:path.join(repository,'packages/web/runtime/darwin-arm64/DevRyan-execution-darwin-arm64'),
   lease:{viewDirectory:view,workingDirectory:view,projectDirectory:root},command:process.execPath,args:[bundle],env:{PATH:'/usr/bin:/bin',GIT_CEILING_DIRECTORIES:root},
   signal:controller.signal,socketDirectory:socket,workerBrowsers:false,interactive:true,onOutput:({stream,data})=>{
    if(stream==='stderr'){errors.push(data);return;}pending+=data.toString();let newline;
    while((newline=pending.indexOf('\n'))!==-1){const line=pending.slice(0,newline);pending=pending.slice(newline+1);
     try{const event=JSON.parse(line);events.push(event);
      if(event.type==='permission')void reply({id:event.id,ok:true}).catch(cause=>{failure=cause;controller.abort(cause);});
      else if(event.type==='browser'){
       expect(event.scope).toEqual({opencodeSessionID:'ses_owned',messageID:'msg_user',directory:root,agent:'build'});
       const result=event.operation==='acquire'?{leaseId:'lease_owned',wsUrl:`ws://127.0.0.1:${server.port}/closed-owned-endpoint`,clientAttached:false}:{ok:true};
       void reply({type:'browser',id:event.id,ok:true,result}).catch(cause=>{failure=cause;controller.abort(cause);});
      }else if(event.type!=='result')throw Error('unexpected worker event');
     }catch(cause){failure=cause;controller.abort(cause);}
    }
   }});ready.resolve();active.child.stdin.write(JSON.stringify(request)+'\n');
  const timeout=setTimeout(()=>controller.abort(Error('owned Rust daemon deadline')),15_000);let receipt;try{receipt=await active.result;}finally{clearTimeout(timeout);}active=undefined;
  // Intentional endpoint refusal proves IPC+confinement only, not desktop/browser verification.
  expect({receipt,errors:Buffer.concat(errors).toString(),failure,pending}).toMatchObject({receipt:{terminated:true,confined:true,cancelled:false,exitCode:1},errors:'',failure:undefined,pending:''});
  expect(upgraded).toBeGreaterThan(0);expect(socketNames.some(name=>name.endsWith('.sock'))).toBe(true);
  expect(events.filter(value=>value.type==='permission')).toHaveLength(1);const result=events.filter(value=>value.type==='result');expect(result).toHaveLength(1);
  expect(result[0].ok).toBe(false);expect(result[0].error.message).toContain('owned fixture endpoint refused CDP');
  expect(await fs.lstat(socket).catch(error=>error.code)).toBe('ENOENT');
  await fs.writeFile(path.join(repository,'.cache/v2-validation/stage-d-native-browser-rust-proof.json'),JSON.stringify({binarySha256:request.reviewedBrowser.sha256,version:'0.38.1',socketNames,upgraded,receipt,expectedRefusal:'owned fixture endpoint refused CDP',scopeBound:true},null,2)+'\n');
 }finally{if(active){active.cancel();await active.result;}server?.stop(true);await fs.rm(root,{recursive:true,force:true});}
},30_000);
