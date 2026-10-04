import {expect,test} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const repository=path.resolve(import.meta.dirname,'../..');
/** Reuse the real assembled ServerFetch fixture; only owned account/catalog inputs and its final transport are extended. */
test('real scoped SDK catalog reads current Copilot account through constructor owner and expires after reload',async()=>{
 const root=await fs.mkdtemp(path.join(repository,'.cache/v2-validation/provider-catalog-')),home=path.join(root,'home'),tmp=path.join(home,'tmp');await fs.mkdir(tmp,{recursive:true});await fs.writeFile(path.join(tmp,'package.json'),'{"type":"commonjs"}\n');
 let child:ReturnType<typeof Bun.spawn>|undefined;
 try{
  const sourcePath=path.join(repository,'scripts/opencode-v2-native/controller-integrations.graph-fixture.mjs');let source=await fs.readFile(sourcePath,'utf8');
  const replace=(before:string,after:string)=>{if(source.split(before).length!==2)throw new Error('Owned integration fixture shape changed');source=source.replace(before,after);};
  source="import {Credential} from '@opencode/core/credential';\nimport {LayerNode} from '@opencode/util/effect/layer-node';\nimport {Schema} from 'effect';\nimport {createNativeProviderRuntimeOwner} from "+JSON.stringify(pathToFileURL(path.join(repository,'packages/web/server/lib/opencode/runtime-host/native-provider-runtime-owner.js')).href)+";\n"+source;
  replace("providers: { openai:","providers: { 'github-copilot':{env:[],models:{'gpt-4o-mini':{capabilities:{tools:true,input:['text'],output:['text']},limit:{context:128000,input:120000,output:4096}}}}, openai:");
  replace("  if (['auth.openai.com', 'api.openai.com', 'chatgpt.com'].includes(url.hostname)) {","  if(url.hostname==='api.githubcopilot.com'){assert.equal(url.protocol,'https:');return nativeFetch(new Request(loopback+(url.pathname==='/models'?'/owned-copilot-models':url.pathname),request));}\n  if (['auth.openai.com', 'api.openai.com', 'chatgpt.com'].includes(url.hostname)) {");
  replace("    if (request.url === '/api/accounts/deviceauth/usercode')","    if(request.url==='/owned-copilot-models'){const account=request.headers.authorization?.endsWith('account-c')?'c':request.headers.authorization?.endsWith('account-b')?'b':'a';return json({data:[{id:'gpt-4o-mini',name:'Utility '+account,model_picker_enabled:false,capabilities:{type:'chat',family:'gpt-4o-mini',tokenizer:'o200k_base',limits:{max_context_window_tokens:128000,max_prompt_tokens:120000,max_output_tokens:4096},supports:{tool_calls:true,vision:false}},supported_endpoints:['/chat/completions']},...(account==='c'?[]:[{id:'owned-picker-'+account,name:'Picker '+account,model_picker_enabled:true,capabilities:{type:'chat',family:'gpt-4o-mini',tokenizer:'o200k_base',limits:{max_context_window_tokens:128000,max_prompt_tokens:120000,max_output_tokens:4096},supports:{tool_calls:true,vision:false}},supported_endpoints:['/chat/completions']}])]});}\n    if (request.url === '/api/accounts/deviceauth/usercode')");
  replace("    if (request.url?.endsWith('/responses'))",`    if(request.url==='/chat/completions'){const body=JSON.parse(text);assert.equal(body.stream,true);assert.equal(body.model,'gpt-4o-mini');assert.equal(request.headers.authorization,'Bearer owned-github-account-c');assert.equal(request.headers['x-github-api-version'],'2026-08-01');assert.equal(request.headers['openai-intent'],'conversation-edits');assert.ok(request.headers['x-interaction-id']);copilotPhysical.push({model:body.model,interaction:request.headers['x-interaction-type'],initiator:request.headers['x-initiator']});response.writeHead(200,{'content-type':'text/event-stream'});response.end('data: '+JSON.stringify({id:'owned-copilot-response',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{role:'assistant',content:'Owned Copilot completion'},finish_reason:null}]})+'\\n\\ndata: '+JSON.stringify({id:'owned-copilot-response',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\\n\\ndata: [DONE]\\n\\n');return;}
    if (request.url?.endsWith('/responses'))`);
  replace('let wsReceipts=0;','let wsReceipts=0;const copilotPhysical=[];');
  const origin="const compatibilityOrigin={kind:'plugin',id:'devryan.provider-compat',manifestDigest:createHash('sha256').update(await fs.readFile(new URL('../../packages/web/server/lib/opencode/runtime-host/native-provider-compat-plugin.ts',import.meta.url))).digest('hex'),capabilities:['provider']};";
  replace(origin,'');replace('const factory = createControllerIntegrations(',origin+'\nlet providerOwner;const catalogBindings=[];\nconst factory = createControllerIntegrations(');
  replace("  if (input.action === 'credential-commit-owned')","  if(input.action==='provider-catalog-selection-owned'){const {action,...binding}=input;const selected=await factory.readCatalogSelectionOwned(binding);await fs.appendFile(path.join(root,'catalog-observations.jsonl'),JSON.stringify({directory:binding.directory,selected:Boolean(selected),credentialID:selected?.credential?.id})+'\\n');return selected;}\n  if (input.action === 'credential-commit-owned')");
  replace("  if (method === 'openai.attempt' || method === 'openai.access')","  if(method==='provider.catalog'){catalogBindings.push(structuredClone(input));return providerOwner.handleRpc(method,input,context);}\n  if (method === 'openai.attempt' || method === 'openai.access')");
  replace("  registrationOrigin: nativePlugins.get('devryan.remote-mcp'),","  providerCompatibilityOrigin:compatibilityOrigin,registrationOrigin: nativePlugins.get('devryan.remote-mcp'),");
  replace("const compatibility=createNativeProviderCompatibility({policyForDirectory:()=>({compactionReserved:7500})});","providerOwner=createNativeProviderRuntimeOwner({instanceID:controller.instanceID,snapshot,registrationOrigin:compatibilityOrigin,controller:()=>controller,isReady:()=>ready,withMutationQueue,admissionOwner,fetchImpl:globalThis.fetch});\nconst compatibility=createNativeProviderCompatibility({policyForDirectory:()=>({compactionReserved:7500}),discoverCopilot:factory.discoverCopilot});");
  replace('  await verifyModels();\n  const old=',`  // Synthetic pre-existing accounts belong to this disposable fixture. Use
  // the original native store in a separate completed scope, never the guarded
  // HTTP mutation surface or a retained service from a closed scope.
  const fixtureCredentialLayer=LayerNode.compile(Credential.node,{replacements:[
    Global.node.replace(Global.layerWith(globals)),
    Database.node.replace(Database.configured({path:options.database.path}))
  ]});
  const withFixtureCredentials=action=>withMutationQueue(()=>Effect.runPromise(Effect.scoped(
    Effect.gen(function*(){return yield* action(yield* Credential.Service);})
      .pipe(Effect.provide(fixtureCredentialLayer),Effect.provide(Logger.layer([],{mergeWithExisting:false}))))));
  const copilotID=Schema.decodeUnknownSync(Integration.ID)('github-copilot');
  const accounts=await withFixtureCredentials(credentials=>Effect.forEach(['a','b','c'],account=>credentials.create({
    integrationID:copilotID,label:'owned-'+account,activate:false,
    value:Schema.decodeUnknownSync(Credential.Value)({type:'oauth',methodID:'device',access:account==='c'?'owned-github-account-'+account:'',refresh:'owned-github-account-'+account,expires:0})
  })));
  const beforeRaw=await withFixtureCredentials(credentials=>credentials.list(copilotID));
  const rawResponse=await nativeFetch(new Request(nativeURL+'/api/credential',{method:'POST',headers:{'content-type':'application/json','x-opencode-directory':encodeURIComponent(directories[0])},
    body:JSON.stringify({integrationID:'github-copilot',label:'unowned',value:{type:'oauth',methodID:'device',access:'unowned',refresh:'unowned',expires:0}})}));
  assert.equal(rawResponse.status,500,'Unowned Copilot HTTP credential creation must remain refused');
  const afterRaw=await withFixtureCredentials(credentials=>credentials.list(copilotID));
  assert.deepEqual(afterRaw.map(row=>row.id),beforeRaw.map(row=>row.id),'Refused raw creation must not change native accounts');
  const seed=async account=>withFixtureCredentials(credentials=>credentials.activate(accounts[['a','b','c'].indexOf(account)].id));
  await seed('a');
  const inspect=async(directory,account)=>at(directory,Effect.gen(function*(){const service=yield* Model.Service;const models=yield* service.all();assert.ok(models.some(row=>row.id==='owned-picker-'+account),'Actual Copilot rows: '+JSON.stringify(models.filter(row=>row.providerID==='github-copilot').map(row=>({id:row.id,name:row.name}))));assert.equal(models.some(row=>row.id==='owned-picker-'+(account==='a'?'b':'a')),false);assert.equal(models.some(row=>row.id==='gpt-4o-mini'),false,'Original picker priority excludes non-picker utility row');const automatic=yield* service.get('github-copilot','auto');assert.ok(automatic,'Actual get must expose original Auto row');return models;}));
  for(const directory of directories){await inspect(directory,'a');await verifyToolModel(directory,'github-copilot','owned-picker-a');}
  await seed('b');for(const directory of directories){await inspect(directory,'b');await verifyToolModel(directory,'github-copilot','owned-picker-b');const stale=await nativeFetch(nativeURL+'/devryan/tools?'+new URLSearchParams({directory,providerID:'github-copilot',modelID:'owned-picker-a'}));assert.equal(stale.status,404);}
  await seed('c');for(const directory of directories)await at(directory,Effect.gen(function*(){const service=yield* Model.Service;const models=(yield* service.all()).filter(row=>row.providerID==='github-copilot');assert.deepEqual(models.map(row=>row.id).sort(),['auto','gpt-4o-mini']);const utility=yield* service.get('github-copilot','gpt-4o-mini');assert.equal(utility.package,'aisdk:@ai-sdk/github-copilot');}));
  const copilotSession=await callerContext.run(caller,()=>client.sessions.create({model:{providerID:'github-copilot',modelID:'gpt-4o-mini'}},{directory:directories[0]}));
  const copilotPermit=await admissionOwner.handleRpc('native.admission.authorize',{operation:'execution.resume',sessionID:copilotSession.id});ownedTokens.add(copilotPermit.token);
  try{const generated=await call(directories[0],'/api/session/'+copilotSession.id+'/generate','POST',{prompt:'Owned Copilot physical generation'},{'x-devryan-native-permit':JSON.stringify(copilotPermit)});assert.equal(generated.data.text,'Owned Copilot completion');}finally{await admissionOwner.handleRpc('native.admission.release',copilotPermit);}
  assert.equal(copilotPhysical.length,1);assert.equal(copilotPhysical[0].interaction,'conversation-agent');
  const oldCatalogBinding=catalogBindings.findLast(row=>row.directory===directories[0]);assert.ok(oldCatalogBinding);
  await verifyModels();
  const old=`);
  replace("  await assert.rejects(Effect.runPromise(oldModels.all()),/native_provider_location_expired/);","  await assert.rejects(Effect.runPromise(oldModels.all()),/native_provider_location_expired/);\n  await assert.rejects(providerOwner.catalog(oldCatalogBinding),/native_provider_catalog_binding_invalid/);\n  await at(directories[0],Effect.gen(function*(){const models=yield* (yield* Model.Service).all();assert.deepEqual(models.filter(row=>row.providerID==='github-copilot').map(row=>row.id).sort(),['auto','gpt-4o-mini']);}));");
  replace('    providerKinds: [], physicalReceipts: 0, permitsWereOwned: true };','    providerKinds: [], physicalReceipts: 0, permitsWereOwned: true,copilotCatalog:true };');
  replace('  await cleanup(() => factory.close());','  await cleanup(() => providerOwner.close());\n  await cleanup(() => factory.close());');
  // Move fixture source into the disposable repository root without changing its exact imported owners.
  source=source.replace(/from (['"])(\.\.\/\.\.\/[^'"]+)\1/g,(_all,_quote,relative:string)=>'from '+JSON.stringify(pathToFileURL(path.resolve(path.dirname(sourcePath),relative)).href));
  source=source.replace(/new URL\((['"])(\.\.\/\.\.\/[^'"]+)\1,import\.meta\.url\)/g,(_all,_quote,relative:string)=>'new URL('+JSON.stringify(pathToFileURL(path.resolve(path.dirname(sourcePath),relative)).href)+')');
  const entry=path.join(root,'fixture.mjs');await fs.writeFile(entry,source);
  child=Bun.spawn([process.execPath,entry],{cwd:repository,env:{PATH:'/usr/bin:/bin',HOME:home,TMPDIR:tmp,XDG_CONFIG_HOME:path.join(home,'config'),XDG_DATA_HOME:path.join(home,'data'),XDG_STATE_HOME:path.join(home,'state'),XDG_CACHE_HOME:path.join(home,'cache'),GIT_CEILING_DIRECTORIES:root,DEVRYAN_INTEGRATION_FIXTURE_ROOT:root},stdout:'pipe',stderr:'pipe'});
  if(!child.stdout||typeof child.stdout==='number'||!child.stderr||typeof child.stderr==='number')throw new Error('Owned child pipes required');
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);await fs.writeFile(path.join(repository,'.cache/v2-validation/stage-d-provider-catalog-graph-child.log'),stderr);await fs.writeFile(path.join(repository,'.cache/v2-validation/stage-d-provider-catalog-graph-child.stdout.log'),stdout);
  for(const name of ['rpc-errors.jsonl','native-causes.jsonl','reported-causes.jsonl','admissions.jsonl','hooks.jsonl','catalog-observations.jsonl'])await fs.copyFile(path.join(root,name),path.join(repository,'.cache/v2-validation/stage-d-provider-catalog-'+name)).catch(error=>{if(error.code!=='ENOENT')throw error;});
  expect({code,stderr}).toEqual({code:0,stderr:''});expect(JSON.parse(stdout).copilotCatalog).toBe(true);
 }finally{if(child&&child.exitCode===null){child.kill();await child.exited;}await fs.rm(root,{recursive:true,force:true});}
},120000);
