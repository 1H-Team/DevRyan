import {expect,test} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {prepareReviewedNativeInputs,reviewedNativeInputPlugin} from '../native-runtime-assets.mjs';
import {createNativeAssetFixturePlugin,writeNativeFixtureOutputs} from './native-asset-fixture.mjs';

const repository=path.resolve(import.meta.dirname,'../..');
test('actual Slim rescue retains native permission and reads only the exact reviewed support file',async()=>{
 const root=await fs.mkdtemp(path.join(repository,'.cache/v2-validation/slim-resource-'));
 let child:ReturnType<typeof Bun.spawn>|undefined;
 try{
  const fixture=path.join(repository,'scripts/opencode-v2-native/controller-integrations.graph-fixture.mjs');
  let source=await fs.readFile(fixture,'utf8');
  const replace=(before:string,after:string)=>{if(source.split(before).length!==2)throw Error('Original graph fixture changed: '+before);source=source.replace(before,after);};
  const host=path.join(repository,'packages/web/server/lib/opencode/runtime-host');
  source=`import {createControllerSlim} from ${JSON.stringify(path.join(host,'controller-slim.ts'))};
import {createExecutionRouting} from ${JSON.stringify(path.join(host,'execution-routing.ts'))};
import {createNativeSlimOwner} from ${JSON.stringify(path.join(host,'native-slim-owner.js'))};
import {captureReviewedSkill} from ${JSON.stringify(path.join(host,'reviewed-skills.js'))};
import * as originals from ${JSON.stringify(path.join(repository,'packages/web/runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js'))};
`+source;
  replace('let nativeURL, ready = false, handler, map,',`let slimOwner;let servedRead=false;const stages=[];let nativeURL, ready = false, handler, map,`);
  replace('const runtime = createSessionMutationRuntime(',`const skillRoot=path.join(globals.home,'private-skill');await fs.mkdir(skillRoot);const skillFile=path.join(skillRoot,'SKILL.md'),support=path.join(skillRoot,'support.txt');await fs.writeFile(skillFile,'# Reviewed body');await fs.writeFile(support,'EXACT REVIEWED SUPPORT BYTES\\n');
const skill=await captureReviewedSkill({directory:directories[0],skill:{name:'Reviewed',path:skillFile},allowedRoots:[globals.home],parseMarkdown:()=>({body:'# Reviewed body',frontmatter:{}})});
snapshot.locations[0].skills=[skill];for(const row of snapshot.locations){row.compatibility.slim={mergedConfig:{autoUpdate:false,companion:{enabled:false},backgroundJobs:{orchestratorWake:{enabled:false}},webfetch:{enabled:false}}};}
const roots=directories.map(directory=>({directory,readRoots:[directory],protectedRoots:[globals.home]}));
const runtime = createSessionMutationRuntime(`);
  replace('const rpc = async (method, input, context) => {',`const rpc = async (method, input, context) => {
 if(method==='native.slim.path'){stages.push('path:'+input.action);try{return await slimOwner.path(input,context);}catch(error){stages.push('path-refused:'+error.code);throw error;}}
 if(method==='native.slim.hook')return slimOwner.hook(input,context);
 if(method==='native.slim.context')return {messages:input.messages,presentationInsertions:[]};
 if(method.startsWith('execution.native.')){const action=method.slice('execution.native.'.length);stages.push(action);if(action==='direct-admit')return {token:'owned-direct',generation:1};if(action==='direct-finish')return {};throw Error('unexpected_execution_action');}`);
  replace('const gates = createAdmissionGates({',`const routing=createExecutionRouting({rpc,bridge,directory:directories[0],locations:roots,configurationSnapshot:snapshot});
const slimOrigin={kind:'plugin',id:'devryan.slim',manifestDigest:'a'.repeat(64),capabilities:['read','write','network','process']};
const unavailable=()=>{throw Error('unexpected_fixture_owner');};
const slim=createControllerSlim({snapshot,origin:slimOrigin,originals,ponytailCommand:{description:'unused',template:'unused'},rpc,
 executeOwned:routing.executeOwned,withControl:routing.withControl,commands:{assertCommand:unavailable,executeCommand:unavailable},
 webfetchBinaryDirectory:directory=>directory,webfetchOwnersFor:unavailable,applyPonytailCommand:unavailable,
 interviewForDirectory:()=>({runtime:{},service:{getActiveInterviewId:async()=>null,handleCommandExecuteBefore:unavailable,handleEvent:async()=>{}},submitCommand:unavailable,assertAcceptedCommand:unavailable,assertCurrent:async()=>{},dispose:async()=>{}}),
 observePrompt:async()=>{},observeLifecycle:async()=>{},transformImages:async()=>{},disposeLocation:async()=>{},log:()=>{}});
const gates = createAdmissionGates({sessionHooks:(inner,location,owners)=>slim.decorateHooks(inner,location,{assertToolRead:(event,target)=>owners.assertToolRead(event,target).pipe(Effect.tap(()=>Effect.sync(()=>stages.push('native-permission'))))}),`);
  replace("  executeOwned: () => Effect.die(new Error('Unexpected executable tool')) });",'  executeOwned:routing.executeOwned });');
  replace('...factory.overrides,...compatibility.overrides,','...factory.overrides,...compatibility.overrides,...routing.overrides,');
  replace('plugins: [{plugin:compatibility.plugin,origin:compatibilityOrigin}]','plugins: [{plugin:compatibility.plugin,origin:compatibilityOrigin},{plugin:slim.plugin,origin:slimOrigin}]');
  const bodyStart=source.indexOf('      const output = JSON.stringify(body)'),bodyEnd=source.indexOf('      response.writeHead(200,',bodyStart);
  if(bodyStart<0||bodyEnd<bodyStart)throw Error('Original response fixture changed');
  source=source.slice(0,bodyStart)+`      const isRead=!servedRead&&body.tools?.some(tool=>tool.type==='function'&&tool.name==='read')&&JSON.stringify(body).includes('Reviewed support proof');if(isRead)servedRead=true;
      const message=isRead?{id:'owned_support_function',type:'function_call',call_id:'owned_support_call',name:'read',arguments:JSON.stringify({path:path.join(root,'home','private-skill','support.txt')}),status:'completed'}:{id:'owned_done',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Owned support read complete',annotations:[]}]};
      const result={id:'owned_response_'+receipts.length,object:'response',created_at:Math.floor(Date.now()/1000),model:'gpt-5.5',status:'completed',output:[message],usage:{input_tokens:10,output_tokens:5,total_tokens:15,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}};
      const events=[{type:'response.created',response:{...result,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:{...message,status:'in_progress'}},{type:'response.output_item.done',output_index:0,item:message},{type:'response.completed',response:result}];
`+source.slice(bodyEnd);
  const begin=source.indexOf('  const session = await callerContext.run(caller, () => client.sessions.create('),end=source.indexOf('} catch (error) { primaryFailure = error;');
  if(begin<0||end<begin)throw Error('Original fixture main changed');
  source=source.slice(0,begin)+`
  slimOwner=createNativeSlimOwner({admissionOwner,openCodeClient:client,configurationSnapshot:snapshot,locations:roots});
  const session=await callerContext.run(caller,()=>client.sessions.create({model:{providerID:'openai',modelID:'gpt-5.5'}},{directory:directories[0]}));
  await callerContext.run(caller,()=>client.prompts.prompt(session.id,{agent:'build',model:{providerID:'openai',modelID:'gpt-5.5'},parts:[{type:'text',text:'Reviewed support proof'}]},{directory:directories[0]}));
  let tool;const end=Date.now()+15000;while(Date.now()<end){const requests=await client.interaction.permissions.list({directory:directories[0]},{sessionID:session.id});for(const request of requests){if(request.sessionID===session.id&&request.tool?.callID==='owned_support_call'){assert.equal(request.permission,'external_directory');stages.push('external-permission-once');await callerContext.run(caller,()=>client.interaction.permissions.reply(request.id,{reply:'once'},{directory:directories[0],sessionID:session.id}));}}const page=await client.sessions.messages(session.id,{},{directory:directories[0]});tool=page.records.flatMap(row=>row.parts).find(part=>part.type==='tool'&&part.callID==='owned_support_call'&&['completed','error'].includes(part.state.status));if(tool)break;await new Promise(resolve=>setTimeout(resolve,10));}
  const causes=await fs.readFile(path.join(root,'reported-causes.jsonl'),'utf8').catch(()=>''),codes=causes.trim().split('\\n').filter(Boolean).flatMap(line=>JSON.parse(line).map(row=>({code:row.code??null,name:row.name??null,messageSHA:row.message?createHash('sha256').update(row.message).digest('hex'):null,frames:row.frames?.slice(0,6)})));assert.ok(tool,'Actual native support read did not settle: '+JSON.stringify({stages,servedRead,kinds:[...kinds],codes}));
  result={status:tool.state.status,error:tool.state.error??null,output:tool.state.output??null,stages};
`+source.slice(end);
  replace('  await cleanup(() => runtime.drain());','  await cleanup(() => routing.close());await cleanup(() => runtime.drain());');
  source=source.replace(/from (['"])(\.\.\/\.\.\/[^'"]+)\1/g,(_all,_quote,relative:string)=>'from '+JSON.stringify(path.resolve(path.dirname(fixture),relative)));
  source=source.replace(/new URL\((['"])(\.\.\/\.\.\/[^'"]+)\1,import\.meta\.url\)/g,(_all,_quote,relative:string)=>'new URL('+JSON.stringify('file://'+path.resolve(path.dirname(fixture),relative))+')');
  const entry=path.join(root,'entry.mjs');await fs.writeFile(entry,source);
  const built=await Bun.build({entrypoints:[entry],target:'bun',outdir:root,naming:{entry:'graph.mjs',asset:'[name]-[hash].[ext]'},plugins:[await createNativeAssetFixturePlugin(repository),reviewedNativeInputPlugin(await prepareReviewedNativeInputs(repository))]});
  if(!built.success)throw new AggregateError(built.logs,'Reviewed support graph build failed');await writeNativeFixtureOutputs(built.outputs);
  const home=path.join(root,'home'),tmp=path.join(home,'tmp');await fs.mkdir(tmp,{recursive:true});await fs.writeFile(path.join(tmp,'package.json'),'{"type":"commonjs"}');
  child=Bun.spawn([process.execPath,path.join(root,'graph.mjs')],{cwd:repository,env:{PATH:'/usr/bin:/bin',HOME:home,TMPDIR:tmp,XDG_CONFIG_HOME:path.join(home,'config'),XDG_DATA_HOME:path.join(home,'data'),XDG_STATE_HOME:path.join(home,'state'),XDG_CACHE_HOME:path.join(home,'cache'),GIT_CEILING_DIRECTORIES:root,DEVRYAN_INTEGRATION_FIXTURE_ROOT:root},stdout:'pipe',stderr:'pipe'});
  if(!child.stdout||typeof child.stdout==='number'||!child.stderr||typeof child.stderr==='number')throw Error('Owned pipes required');
  const deadline=setTimeout(()=>child?.kill('SIGKILL'),30000);
  try{
   const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
   expect({code,stderr}).toEqual({code:0,stderr:''});const result=JSON.parse(stdout);
   await fs.writeFile(path.join(repository,'.cache/v2-validation/resume-skill-resource-graph-result.json'),JSON.stringify(result));
   expect(result.status).toBe('completed');expect(result.output).toContain('EXACT REVIEWED SUPPORT BYTES');
   expect(result.stages.filter((stage:string)=>stage==='native-permission')).toHaveLength(1);
   expect(result.stages.filter((stage:string)=>stage==='path:stat')).toHaveLength(1);
   expect(result.stages.indexOf('native-permission')).toBeLessThan(result.stages.indexOf('path:stat'));
   expect(result.stages.indexOf('path:stat')).toBeLessThan(result.stages.indexOf('direct-admit'));
   expect(result.stages.filter((stage:string)=>stage==='external-permission-once')).toHaveLength(1);
   expect(result.stages.filter((stage:string)=>stage==='direct-admit')).toHaveLength(1);expect(result.stages.filter((stage:string)=>stage==='direct-finish')).toHaveLength(1);
  }finally{clearTimeout(deadline);}
 }finally{if(child&&child.exitCode===null){child.kill();await child.exited;}await fs.rm(root,{recursive:true,force:true});}
},60000);
