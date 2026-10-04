import {test,expect,afterAll} from 'bun:test';
import {deflateSync} from 'node:zlib';
import fs from 'node:fs/promises';import path from 'node:path';import {createHash,randomUUID} from 'node:crypto';
import {prepareReviewedNativeInputs,reviewedNativeInputPlugin} from '../native-runtime-assets.mjs';
import {createNativeAssetFixturePlugin,writeNativeFixtureOutputs} from './native-asset-fixture.mjs';
import {createSessionExecutionHost} from '../../packages/web/server/lib/opencode/session-execution-host.js';
import {git} from '../../packages/harness-runtime/lib/session-changes-git.js';
import {createNativeImageGeneration} from '../../packages/web/server/lib/opencode/runtime-host/native-image-generation.js';
import {rewriteReviewedImagegen} from '../../packages/web/server/lib/opencode/runtime-host/reviewed-imagegen-transform.js';
const repository=path.resolve(import.meta.dirname,'../..');
const root=await fs.mkdtemp(path.join(repository,'.cache/v2-validation/imagegen-'));
const reviewed=await prepareReviewedNativeInputs(repository),hostDirectory=path.join(repository,'packages/web/server/lib/opencode/runtime-host');
const build=async(entry,target='bun',external=[])=>{
 const result=await Bun.build({entrypoints:[entry],target,external,outdir:root,naming:{entry:path.basename(entry).replace(/\.ts$/,'.mjs'),asset:'[name]-[hash].[ext]'},plugins:[...(target==='bun'?[await createNativeAssetFixturePlugin(repository)]:[]),{name:'owned-sdk-source-entry',setup(builder){builder.onResolve({filter:/^@opencode\/sdk\/effect$/},async()=>({path:await fs.realpath(path.join(repository,'packages/web/node_modules/@opencode/sdk/dist/effect/index.js'))}));}},reviewedNativeInputPlugin(reviewed)]});
 if(!result.success)throw new AggregateError(result.logs,'Image generation reviewed graph failed');await writeNativeFixtureOutputs(result.outputs);return result.outputs[0].text();
};
const worker=path.join(root,'worker.mjs');await fs.writeFile(worker,await build(path.join(hostDirectory,'writer-worker.ts'),'bun',['effect','@opencode/core/*','@opencode/schema/*','@opencode/plugin/*','@opencode/util/*']));
const entry=path.join(root,'original-entry.ts'),originalPath=path.join(root,'original.mjs');await fs.writeFile(entry,`export * from ${JSON.stringify(path.join(repository,'packages/web/runtime/reviewed-inputs/imagegen-0.1.12/dist/index.js'))};`);
await fs.writeFile(originalPath,await build(entry,'node'));const originals=await import(originalPath);
afterAll(()=>fs.rm(root,{recursive:true,force:true}));
function fixturePNG(){
 const crc=bytes=>{let value=0xffffffff;for(const byte of bytes){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;};
 const chunk=(type,data)=>{const body=Buffer.concat([Buffer.from(type),data]),result=Buffer.alloc(data.length+12);result.writeUInt32BE(data.length);body.copy(result,4);result.writeUInt32BE(crc(body),result.length-4);return result;};
 const header=Buffer.alloc(13);header.writeUInt32BE(8,0);header.writeUInt32BE(8,4);header[8]=8;header[9]=6;
 const pixels=Buffer.alloc(8*33,255);for(let y=0;y<8;y++)pixels[y*33]=0;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
const png=fixturePNG();
const origin={kind:'plugin',id:'opencode-gpt-imagegen',manifestDigest:'a'.repeat(64),capabilities:['read','write','process','network']};

test('exact original image body/parser and retained model hotfix use only injected selected credentials',async()=>{
 const source=await fs.readFile(path.join(repository,'packages/web/runtime/reviewed-inputs/imagegen-0.1.12/dist/index.js'));
 expect(()=>rewriteReviewedImagegen(Buffer.concat([source,Buffer.from(' ')]))).toThrow('reviewed_imagegen_source_changed');
 const transformed=rewriteReviewedImagegen(source).contents;expect(transformed).not.toContain('auth.json');expect(transformed).not.toContain('OPENCODE_AUTH_CONTENT');
 let request;const result=await originals.withReviewedImagegenOwner({fetch:async(url,init)=>{
  request={url,headers:new Headers(init.headers),body:JSON.parse(init.body)};
  return new Response(`data: ${JSON.stringify({type:'response.output_item.done',item:{type:'image_generation_call',result:png.toString('base64')}})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
 }},()=>originals.callReviewedImagegenResponses({access:'fixture-selected',accountId:'fixture-account'},{prompt:'Exact original image',quality:'high',size:'1024x1024'},['data:image/png;base64,'+png.toString('base64')]));
 expect(result).toBe(png.toString('base64'));expect(request.url).toBe('https://chatgpt.com/backend-api/codex/responses');
 expect(request.headers.get('Authorization')).toBe('Bearer fixture-selected');expect(request.headers.get('ChatGPT-Account-Id')).toBe('fixture-account');
 expect(request.body).toMatchObject({model:'gpt-6-astra',reasoning:{effort:'medium'},tools:[{type:'image_generation',output_format:'png',quality:'high',size:'1024x1024'}],tool_choice:{type:'image_generation'},stream:true,store:false});
 expect(request.body.input[0].content[1]).toEqual({type:'input_image',image_url:'data:image/png;base64,'+png.toString('base64')});
 await expect(originals.callReviewedImagegenResponses({access:'fixture-selected'},{prompt:'No ambient fetch',quality:'auto'},[])).rejects.toThrow('reviewed_imagegen_owner_required');
});

async function fixture({revokeAfterReceipt=false,hold=false,malformed=false}={}){
 const directory=await fs.mkdtemp(path.join(root,'project-'));await git(directory,['init','--quiet']);await fs.writeFile(path.join(directory,'keep.txt'),'Preserved');
 let live=true,checks=0;const receipts=[],outcomes=[],requests=[],waiting=Promise.withResolvers();
 const sessionID='ses_imagegen',messageID='msg_assistant',callID='call_'+randomUUID();
 const info={id:sessionID,directory},record={info:{id:messageID,sessionID,role:'assistant',parentID:'msg_user'},parts:[{type:'tool',tool:'gpt_imagegen',callID,state:{status:'running'}}],turnOwnership:{source:'native-sequence',userMessageID:'msg_user'}};
 const host=createSessionExecutionHost({dataDirectory:directory+'-data',getLauncher:()=>path.join(repository,'packages/web/runtime/darwin-arm64/DevRyan-execution-darwin-arm64'),
  openCodeClient:{generation:()=>2,sessions:{get:async()=>info,message:async()=>record}},nativeExecution:{workerCommand:process.execPath,workerArgs:[worker],workerEnvironment:{PATH:'/usr/bin:/bin',GIT_CEILING_DIRECTORIES:directory},socketDirectory:null,workerBrowsers:false,reviewedImagegenOrigin:origin,
   recheckPermit:async()=>{checks++;if(!live)throw Object.assign(Error('original_grant_revoked'),{code:'original_grant_revoked'});},
   imageGeneration:async(invocation,args,{signal})=>{requests.push({invocation,args});waiting.resolve();if(hold)await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});if(signal.aborted)reject(signal.reason);});return {base64:malformed?'not-an-image':png.toString('base64')};},
   onTermination:event=>{receipts.push(event);if(revokeAfterReceipt)live=false;},onOutcome:event=>outcomes.push(event)}});
 const start=async(input)=>{
  const spec={kind:'writer',tool:'gpt_imagegen',input};
  return host.nativeExecution({action:'start',directory,sessionID,messageID,callID,agent:'build',...spec,permit:{token:'constructor'},authorization:{input:{provenance:origin}},argsDigest:createHash('sha256').update(JSON.stringify(spec)).digest('hex')});
 };
 const settle=async(handle)=>{let cursor=0;for(;;){const batch=await host.nativeExecution({action:'read',handle,cursor});cursor=batch.cursor;for(const event of batch.events)if(event.type==='permission')await host.nativeExecution({action:'input',handle,reply:{id:event.id,ok:true}});const terminal=batch.events.find(event=>['settled','uncertain'].includes(event.type));if(terminal)return terminal;}};
 return {host,directory,receipts,outcomes,requests,start,settle,waiting:waiting.promise,checks:()=>checks,scope:{directory,sessionID,messageID,callID}};
}

test('actual original image executor publishes versioned PNG only after a real receipt and retains canonical output paths',async()=>{
 const f=await fixture();try{
  await fs.writeFile(path.join(f.directory,'art.png'),'Existing image');await fs.writeFile(path.join(f.directory,'reference.png'),png);
  const started=await f.start({prompt:'Use reference image',out:path.join(f.directory,'art.png'),quality:'auto',images:['reference.png']});
  const terminal=await f.settle(started.handle);
  expect(terminal).toMatchObject({type:'settled',ok:true,receipt:{terminated:true,confined:true,cancelled:false,exitCode:0},result:{metadata:{out:path.join(f.directory,'art-v2.png'),versioned:true,billing:'subscription'}}});
  expect(terminal.result.output).toContain(path.join(f.directory,'art-v2.png'));expect(terminal.result.output).not.toContain('/worktree');
  expect(await fs.readFile(path.join(f.directory,'art-v2.png'))).toEqual(png);expect(await fs.readFile(path.join(f.directory,'art.png'),'utf8')).toBe('Existing image');
  expect(f.requests).toHaveLength(1);expect(f.requests[0].args).toEqual({prompt:'Use reference image',quality:'auto',referenceImages:['data:image/png;base64,'+png.toString('base64')]});
  const lease=await f.host.runtime.leaseForCall(f.scope);expect(f.requests[0].invocation.token).toBe(lease.token);expect(lease.state).toBe('published');
  expect(f.receipts).toHaveLength(1);expect(f.outcomes).toHaveLength(1);expect(f.outcomes[0].state).toBe('published');expect(f.checks()).toBeGreaterThan(5);
  expect(await fs.readFile(path.join(f.directory,'keep.txt'),'utf8')).toBe('Preserved');
 }finally{await f.host.drain();}
},60_000);

test.each([{revokeAfterReceipt:true},{malformed:true}])('settled revocation/invalid image cannot publish %#',async options=>{
 const f=await fixture(options);try{
  const started=await f.start({prompt:'Refused output',out:'refused.png',quality:'low'}),terminal=await f.settle(started.handle);
  expect(terminal.ok).toBe(false);expect(f.receipts).toHaveLength(1);expect(f.receipts[0].receipt).toMatchObject({terminated:true,confined:true});
  expect(await fs.stat(path.join(f.directory,'refused.png')).catch(()=>null)).toBeNull();expect(await f.host.runtime.activeLeases({directory:f.directory})).toEqual([]);
 }finally{await f.host.drain();}
},60_000);

test('canonical root and symlink escapes refuse before any physical image request',async()=>{
 const f=await fixture();try{
  const external=path.join(root,'external.png');await fs.writeFile(external,png);await fs.symlink(external,path.join(f.directory,'escaped.png'));
  const started=await f.start({prompt:'Refused reference',out:'refused.png',quality:'low',images:['escaped.png']}),terminal=await f.settle(started.handle);
  expect(terminal.ok).toBe(false);expect(terminal.error.message).toContain('native_read_root_denied');expect(f.requests).toEqual([]);expect(f.receipts[0].receipt).toMatchObject({terminated:true,confined:true});
  expect(await fs.stat(path.join(f.directory,'refused.png')).catch(()=>null)).toBeNull();
 }finally{await f.host.drain();}
},60_000);

test('cancel drains the physical image request and real worker receipt without publication',async()=>{
 const f=await fixture({hold:true});try{
  const started=await f.start({prompt:'Cancel held generation',out:'cancelled.png',quality:'high'}),work=f.settle(started.handle);
  await f.waiting;await f.host.nativeExecution({action:'cancel',handle:started.handle});const terminal=await work;
  expect(terminal.ok).toBe(false);expect(f.receipts).toHaveLength(1);expect(f.receipts[0].receipt).toMatchObject({terminated:true,confined:true,cancelled:true});
  expect(await fs.stat(path.join(f.directory,'cancelled.png')).catch(()=>null)).toBeNull();expect(await f.host.runtime.activeLeases({directory:f.directory})).toEqual([]);
 }finally{await f.host.drain();}
},60_000);

test('actual reviewed plugin registration captures native location, original schema and exact provenance',async()=>{
 const pluginEntry=path.join(root,'plugin-entry.ts'),pluginPath=path.join(root,'plugin.mjs');
 await fs.writeFile(pluginEntry,`export * from ${JSON.stringify(path.join(hostDirectory,'native-imagegen-plugin.ts'))};`);
 await fs.writeFile(pluginPath,await build(pluginEntry,'bun',['effect','@opencode/core/*','@opencode/schema/*','@opencode/plugin/*','@opencode/util/*']));
 const home=path.join(root,'registration-home'),tmp=path.join(home,'tmp'),directory=path.join(root,'registration-project');await fs.mkdir(tmp,{recursive:true});await fs.mkdir(directory);await fs.writeFile(path.join(tmp,'package.json'),'{"type":"commonjs"}');
 const runner=path.join(root,'registration.mjs');await fs.writeFile(runner,`
import {Effect,Layer,Logger,Exit,Cause} from 'effect';import {Global} from '@opencode/util/global';import {Tool} from '@opencode/core/tool';import {Plugin} from '@opencode/core/plugin';
const {OpenCode}=await import(${JSON.stringify(path.join(repository,'packages/web/node_modules/@opencode/sdk/dist/effect/index.js'))});
const {trustedPluginOverride}=await import(${JSON.stringify(path.join(hostDirectory,'trusted-plugins.ts'))});const {configurationOverrides}=await import(${JSON.stringify(path.join(hostDirectory,'configuration.ts'))});const {createAdmissionGates}=await import(${JSON.stringify(path.join(hostDirectory,'admission-gates.ts'))});
const {nativeImagegenPlugin}=await import('./plugin.mjs');const origin=${JSON.stringify(origin)},calls=[];let invalidOutput=false;
const bridge={awaitReady:async()=>{},authorize:async request=>({token:'b'.repeat(64),revision:0,sessionID:request.sessionID}),recheck:async()=>{},release:async()=>{},sealPrompt:async()=>({}),verifyAccepted:async()=>{},registerShellJob:async()=>{},sealSynthetic:async()=>({}),deferContinuation:async()=>{},hold:async()=>{},releaseHold:async()=>{},isHeld:async()=>false};
const gates=createAdmissionGates({bridge,nativePlugins:new Map(),executeOwned:call=>{calls.push({toolID:call.toolID,input:call.input,location:call.location,provenance:call.provenance});return Effect.succeed({output:invalidOutput?42:'owned original image',metadata:{out:call.location.directory+'/art.png',versioned:false,billing:'subscription'}});}});await gates.controls.openStartup();
let tools,plugins;const capture=Plugin.node.replace(Plugin.node.mapLayer(layer=>Layer.effect(Plugin.Service,Effect.gen(function*(){const inner=yield* Plugin.Service;tools=yield* Tool.Service;plugins=inner;return inner;})).pipe(Layer.provide(layer))));
const globals=Object.fromEntries(['home','data','cache','config','state','tmp','bin','log','repos'].map(key=>[key,key==='home'?process.env.HOME:process.env.HOME+'/'+key]));
await Effect.runPromise(Effect.scoped(Effect.gen(function*(){const sdk=yield* OpenCode.create({database:{path:':memory:'},config:{project:false},models:{fetch:false,snapshot:false},fs:{filewatcher:false,fff:false},events:{persist:false}},{overrides:[...configurationOverrides({}),Global.node.replace(Global.layerWith(globals)),trustedPluginOverride({plugins:[{plugin:nativeImagegenPlugin,origin}],additionalOrigins:[],nativePlugins:new Map()}),...gates.overrides,capture]});
yield* sdk.agent.list({location:{directory:${JSON.stringify(directory)}}});yield* plugins.awaitActivation;const snapshot=yield* tools.snapshot([{action:'*',resource:'*',effect:'allow'}]);const input={prompt:'Actual original schema',out:'art.png',quality:'high',images:['reference.png']};const session=yield* sdk.sessions.create({location:{directory:${JSON.stringify(directory)}},permissions:[{action:'*',resource:'*',effect:'allow'}]});const result=yield* snapshot.execute({sessionID:session.id,messageID:'msg_assistant',agent:'build',call:{type:'tool-call',id:'call_imagegen',name:'gpt_imagegen',input}});invalidOutput=true;const invalid=yield* Effect.exit(snapshot.execute({sessionID:session.id,messageID:'msg_assistant',agent:'build',call:{type:'tool-call',id:'call_invalid_imagegen',name:'gpt_imagegen',input}}));process.stdout.write(JSON.stringify({calls,result,invalidRejected:Exit.isFailure(invalid),invalidOutputError:Exit.isFailure(invalid)?Cause.pretty(invalid.cause):null}));}).pipe(Effect.provide(Logger.layer([],{mergeWithExisting:false})))));`);
 const child=Bun.spawn([process.execPath,runner],{cwd:repository,env:{PATH:'/usr/bin:/bin',HOME:home,TMPDIR:tmp,XDG_CONFIG_HOME:home+'/config',XDG_DATA_HOME:home+'/data',XDG_CACHE_HOME:home+'/cache',XDG_STATE_HOME:home+'/state',GIT_CEILING_DIRECTORIES:root,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'},stdout:'pipe',stderr:'pipe'});
 const deadline=setTimeout(()=>child.kill('SIGKILL'),20_000);
 try{
  const [text,errors,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect({code,errors}).toEqual({code:0,errors:''});const row=JSON.parse(text);expect(row.calls).toHaveLength(2);expect(row.calls[0]).toMatchObject({toolID:'gpt_imagegen',location:{directory},provenance:origin,input:{prompt:'Actual original schema',out:'art.png',quality:'high',images:['reference.png']}});
  expect(row.result.content).toEqual([{type:'text',text:'owned original image'}]);
  expect(row.result.metadata).toEqual({out:path.join(directory,'art.png'),versioned:false,billing:'subscription'});
  expect(row.invalidRejected).toBe(true);expect(row.invalidOutputError).toContain('Tool returned an invalid value for its output schema');
 }finally{clearTimeout(deadline);if(child.exitCode===null){child.kill('SIGKILL');await child.exited;}}
},30_000);


test('actual original transport uses fresh selected account for each physical request and awaits cancelled stream settlement',async()=>{
 let selected='account-one',checks=0,cancelled=false;const requests=[];
 const transport=createNativeImageGeneration({originals,withImageGeneration:async(_invocation,action)=>action({access:async()=>({accessToken:'fixture-'+selected,accountId:selected}),recheck:async()=>{checks++;}}),fetchImpl:async(url,init)=>{
  const body=JSON.parse(init.body);requests.push({url,body,headers:new Headers(init.headers)});
  if(body.input[0].content[0].text==='Cancel original parser')return new Response(new ReadableStream({start(controller){init.signal.addEventListener('abort',()=>{cancelled=true;controller.error(init.signal.reason);},{once:true});},cancel(){cancelled=true;}}));
  return new Response(`data: ${JSON.stringify({type:'response.output_item.done',item:{type:'image_generation_call',result:png.toString('base64')}})}\n\n`);
 }});
 const args={prompt:'Original transport',quality:'high',size:'1024x1024',referenceImages:['data:image/png;base64,'+png.toString('base64')]};
 expect(await transport({token:'lease-one'},args)).toEqual({base64:png.toString('base64')});selected='account-two';
 expect(await transport({token:'lease-two'},args)).toEqual({base64:png.toString('base64')});
 expect(requests.map(row=>[row.headers.get('Authorization'),row.headers.get('ChatGPT-Account-Id')])).toEqual([['Bearer fixture-account-one','account-one'],['Bearer fixture-account-two','account-two']]);
 expect(requests.every(row=>row.body.model==='gpt-6-astra'&&row.body.reasoning.effort==='medium')).toBe(true);
 expect(requests[1].body.tools).toEqual([{type:'image_generation',output_format:'png',quality:'high',size:'1024x1024'}]);expect(requests[1].body.input[0].content[1].image_url).toBe(args.referenceImages[0]);
 const controller=new AbortController(),work=transport({token:'lease-cancel'},{prompt:'Cancel original parser',quality:'auto',referenceImages:[]},{signal:controller.signal});
 while(requests.length<3)await new Promise(resolve=>setTimeout(resolve,1));controller.abort(Error('fixture_cancelled'));
 await expect(work).rejects.toThrow('fixture_cancelled');expect(cancelled).toBe(true);expect(checks).toBeGreaterThan(5);
});

test('original version selection cannot follow a dangling output symlink outside the private view',async()=>{
 const f=await fixture();try{
  const external=path.join(root,'version-escape.png');await fs.writeFile(path.join(f.directory,'art.png'),'Keep requested');await fs.symlink(external,path.join(f.directory,'art-v2.png'));
  const started=await f.start({prompt:'Refuse version escape',out:'art.png',quality:'auto'}),terminal=await f.settle(started.handle);
  expect(terminal.ok).toBe(false);expect(terminal.error.message).toContain('native_read_root_denied');expect(f.requests).toHaveLength(1);
  expect(f.receipts[0].receipt).toMatchObject({terminated:true,confined:true,exitCode:1});expect(await fs.stat(external).catch(()=>null)).toBeNull();expect(await fs.readFile(path.join(f.directory,'art.png'),'utf8')).toBe('Keep requested');
 }finally{await f.host.drain();}
},60_000);
