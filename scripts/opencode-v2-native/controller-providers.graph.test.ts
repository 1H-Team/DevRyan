import {expect,test} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {prepareReviewedNativeInputs,reviewedNativeInputPlugin} from '../native-runtime-assets.mjs';
import {createNativeAssetFixturePlugin} from './native-asset-fixture.mjs';

// Child logs and receipts land in the test's own temp root (removed afterwards) unless DEVRYAN_KEEP_ARTIFACTS=1.
const keptDiagnostics=(root:string)=>process.env.DEVRYAN_KEEP_ARTIFACTS==='1'?path.join(repository,'.cache/v2-validation'):root;

const repository=path.resolve(import.meta.dirname,'../..');
/** Real native transport/parser/scope. The owned RPC peer uses the real admission
 * owner; the loopback responder stands in for Meridian, not for any SDK service. */
// compiled=true builds the darwin-arm64 native host, which only macOS can build.
for(const {transport,anthropicBaseURL,claudeCatalog,compiled} of [
 {transport:undefined,anthropicBaseURL:undefined},{transport:'websocket',anthropicBaseURL:undefined},{transport:'http',anthropicBaseURL:undefined},
 {transport:undefined,anthropicBaseURL:'http://127.0.0.1:3456'},
 {transport:undefined,anthropicBaseURL:undefined,claudeCatalog:true,compiled:true},
] as const)test.skipIf(compiled===true&&process.platform!=='darwin')(`native provider middleware owns physical HTTP scope with ${claudeCatalog?`selected Claude catalog compiled=${compiled}`:anthropicBaseURL?'saved root Anthropic URL':`${transport??'omitted'} OpenAI transport`}`,async()=>{
 const root=await fs.mkdtemp(path.join(repository,'.cache/v2-validation/provider-transport-')),home=path.join(root,'home'),tmp=path.join(home,'tmp');await fs.mkdir(tmp,{recursive:true});await fs.writeFile(path.join(tmp,'package.json'),'{}\n');let child:ReturnType<typeof Bun.spawn>|undefined;
 try{
  const sourcePath=path.join(repository,'scripts/opencode-v2-native/controller-integrations.graph-fixture.mjs');let source=await fs.readFile(sourcePath,'utf8');
  const replace=(before:string,after:string)=>{if(source.split(before).length!==2)throw new Error('Owned fixture shape changed');source=source.replace(before,after);};
  replace("settings: { transport: 'http' },", transport?`settings: { transport: '${transport}' },`:'');
  source="import {nativeConfiguredInstructionsPlugin} from "+JSON.stringify(pathToFileURL(path.join(repository,'packages/web/server/lib/opencode/runtime-host/native-configured-instructions.ts')).href)+";\n"+source;
  // Exercise the shipping plugin with constructor-frozen, location-specific
  // exact blocks. No ambient instruction discovery or hook mock supplies them.
  replace('directory, configuration, skills: [], instructions: [], textReferences: [], aliases: [], activePlugins: [],',`directory, configuration: {...configuration,compaction:{buffer:directory===directories[0]?0:12000}}, skills: [],
    instructions: ['FIRST BLOCK '+directory+'\\nKeep zero sampling.\\n','SECOND BLOCK '+directory+'\\nUnicode: café / - * \\n'].map((content,index)=>({path:path.join(directory,'captured-'+index+'.md'),content,size:Buffer.byteLength(content),sha256:createHash('sha256').update(content).digest('hex')})), textReferences: [], aliases: [], activePlugins: [],`);
  replace('plugins: [{plugin:compatibility.plugin,origin:compatibilityOrigin}]',"plugins: [{plugin:compatibility.plugin,origin:compatibilityOrigin},{plugin:nativeConfiguredInstructionsPlugin(snapshot),origin:instructionOrigin}]");
  replace("      const kind = request.headers['x-devryan-fixture-provider-kind'];",`      const kind = request.headers['x-devryan-fixture-provider-kind'];
      if(kind==='primary'){
        const wire=JSON.stringify(body),selected=snapshot.locations.filter(location=>wire.includes(JSON.stringify(location.instructions[0].content).slice(1,-1)));
        assert.equal(selected.length,1,'Physical request must contain exactly its captured location policy');
        const location=selected[0];
        for(const instruction of location.instructions)assert.ok(wire.includes(JSON.stringify(instruction.content).slice(1,-1)),'Exact captured instruction bytes lost at physical transport');
        assert.ok(wire.indexOf(JSON.stringify(location.instructions[0].content).slice(1,-1))<wire.indexOf(JSON.stringify(location.instructions[1].content).slice(1,-1)),'Captured instruction order changed');
        for(const other of snapshot.locations.filter(other=>other!==location))for(const instruction of other.instructions)assert.equal(wire.includes(JSON.stringify(instruction.content).slice(1,-1)),false,'Physical request borrowed another location policy');
        assert.equal(Object.hasOwn(body,'temperature'),false,'GPT high-effort sampling stays omitted');
        assert.equal(Object.hasOwn(body,'top_p'),false,'GPT high-effort sampling stays omitted');
        physicalInstructionLocations.add(location.directory);
      }`);
  replace('const configuration = { model:', "const instructionOrigin={kind:'plugin',id:'devryan.configured-instructions',manifestDigest:createHash('sha256').update(await fs.readFile("+JSON.stringify(path.join(repository,'packages/web/server/lib/opencode/runtime-host/native-configured-instructions.ts'))+")).digest('hex'),capabilities:['control']};const physicalInstructionLocations=new Set();\nconst configuration = { model:");
  replace('  result.providerCompatibility=true;', "  assert.deepEqual([...physicalInstructionLocations].sort(),[...directories].sort());result.physicalInstructions=true;\n  result.providerCompatibility=true;");
  replace("const nativeFetch = globalThis.fetch;","let websocketUpgrades=0,toolRequested=false,toolReturned=false;await fs.writeFile(path.join(directories[0],'owned-proof.txt'),'Owned native tool proof');\nconst nativeFetch = globalThis.fetch;");
  replace("transport.on('connection'", "transport.on('upgrade',(_request,socket)=>{websocketUpgrades++;socket.destroy();});\ntransport.on('connection'");
  source="import {createNativeObservation} from "+JSON.stringify(pathToFileURL(path.join(repository,'packages/web/server/lib/opencode/runtime-host/native-observation.ts')).href)+";\nimport {parseNativeObservation} from "+JSON.stringify(pathToFileURL(path.join(repository,'packages/web/server/lib/opencode/runtime-host/native-observation-contract.js')).href)+";\n"+source;
  source="import {createControllerProviders} from "+JSON.stringify(pathToFileURL(path.join(repository,'packages/web/server/lib/opencode/runtime-host/controller-providers.ts')).href)+";\n"+source;
  source="import {createExecutionRouting} from "+JSON.stringify(pathToFileURL(path.join(repository,'packages/web/server/lib/opencode/runtime-host/execution-routing.ts')).href)+";\n"+source;
  source="import {scrubOpencodeFingerprints as scrubSystem} from "+JSON.stringify(pathToFileURL(path.join(repository,'packages/web/runtime/reviewed-inputs/claude-1.8.0/node_modules/@rynfar/meridian-plugin-opencode-scrub/dist/scrub.js')).href)+";\n"+source;
  replace('tokenRevision=0, refreshRequests=0;','tokenRevision=0, refreshRequests=0;const meridianAttempts=new Map(),meridianEnded=[];let meridianObserved,meridianCancelObserved;');
  replace('const rpc = async (method, input, context) => {',`const observations=[];const rpc = async (method, input, context) => {
    if(method==='execution.native.direct-admit')return {token:'owned-direct',generation:1};if(method==='execution.native.direct-finish')return {};
    if(method==='native.observation'){assert.ok(ownedTokens.has(input.permit.token));const row=parseNativeObservation(input.observation);assert.equal(row.controllerInstanceID,controller.instanceID);assert.equal(row.configurationDigest,snapshot.digest);observations.push(row);return null;}`);
  const anthropicSettings=JSON.stringify({...claudeCatalog?{}:{apiKey:'wrong-owned'},...anthropicBaseURL?{baseURL:anthropicBaseURL}:{}});
  const ownedModel={capabilities:{tools:true,input:['text'],output:['text']},limit:{context:32768,input:16384,output:4096}};
  const refusedBases={'claude-prefix':'http://127.0.0.1:3456/prefix/v1','claude-userinfo':'http://fixture@127.0.0.1:3456','claude-hash':'http://127.0.0.1:3456/#fixture'};
  const anthropicModels=JSON.stringify({'claude-owned':ownedModel,...anthropicBaseURL?Object.fromEntries(Object.entries(refusedBases).map(([id,baseURL])=>[id,{...ownedModel,settings:{baseURL}}])):{}});
  replace('providers: { openai:',`providers: {anthropic:{package:'@opencode/ai/providers/anthropic',env:[],settings:${anthropicSettings},models:${anthropicModels}}, openai:`);
  if(claudeCatalog){
   const host=path.join(repository,'packages/web/server/lib/opencode/runtime-host');
   source="import {createNativeConfigurationSnapshotResolver} from "+JSON.stringify(pathToFileURL(path.join(host,'native-configuration-snapshot.js')).href)+";\nimport {resolveNativeProviderConfiguration,hasConfiguredNativeClaudeProfile} from "+JSON.stringify(pathToFileURL(path.join(host,'native-provider-configuration.js')).href)+";\n"+source;
   replace('const snapshot = {',`const meridianSettings=path.join(globals.home,'.config','meridian');await fs.mkdir(meridianSettings,{recursive:true});
   await fs.writeFile(path.join(meridianSettings,'profiles.json'),JSON.stringify([{id:'owned-selected',type:'claude-max',claudeConfigDir:globals.home}]));
   await fs.writeFile(path.join(meridianSettings,'settings.json'),JSON.stringify({activeProfile:'owned-selected'}));
   const registrationFile=path.join(root,'claude-catalog-registrations.json'),policyFile=path.join(root,'claude-catalog-policy.json');
   const registrations=JSON.stringify({schema:1,plugins:[{id:'devryan.provider-compat',legacySpecs:['./owned-claude-fixture']}]});await fs.writeFile(registrationFile,registrations);
   await fs.writeFile(policyFile,JSON.stringify({schema:1,locations:directories.map(directory=>({directory})),catalogRequirements:{agents:[],plugins:[],tools:[],models:[]}}));
   const catalogSnapshot=await createNativeConfigurationSnapshotResolver({hasConfiguredClaudeProfile:async()=>hasConfiguredNativeClaudeProfile(await resolveNativeProviderConfiguration({globals,environment:{}})),
    loadLocation:async()=>({legacy:{plugin:[]},agents:{},commands:{},skills:[],slim:{},parseMarkdown:()=>{throw Error('No Claude catalog resources');}})})({binding:{descriptor:{generation:2,launch:{global:globals,opencodeConfigDirectory:globals.config,reviewedPluginManifestPath:registrationFile,reviewedNativeConfigPath:policyFile},projectMap:directories.map(targetDirectory=>({targetDirectory}))}},revision:1,expectedRegistrationDigest:createHash('sha256').update(registrations).digest('hex')});
   for(const location of catalogSnapshot.locations){assert.deepEqual(location.activeRegistrationIDs,[]);assert.deepEqual(location.compatibility.legacy.plugin,[]);assert.deepEqual(location.configuration.providers.anthropic,{});assert.equal(Object.hasOwn(location.configuration.providers.anthropic,'settings'),false);}
   // Offline fixture supplies only transport/model metadata; production uses the native models catalog.
   configuration.providers.anthropic={...catalogSnapshot.locations[0].configuration.providers.anthropic,package:'@opencode/ai/providers/anthropic',env:[],models:${anthropicModels}};
   const snapshot = {`);
  }

  replace('compatibility: { legacy: {},','compatibility: { legacy: {compaction:{reserved:7500}},');
  replace("build: { mode: 'primary', model: 'openai/gpt-5.5' }","build: { mode: 'primary', model: 'openai/gpt-5.5',system:'You are OpenCode, the best coding agent on the planet.\\n\\nKeep owned tool policy.\\n' }");
  replace("    if (request.url === '/api/accounts/oauth/token')",`    if(new URL(request.url,'http://owned').pathname==='/v1/messages'){
      const body=JSON.parse(text),attempt=meridianAttempts.get(request.headers['x-devryan-provider-attempt']);assert.ok(attempt);assert.equal(request.headers.authorization,'Bearer '+ 'e'.repeat(64));assert.equal(decodeURIComponent(request.headers['x-devryan-directory']),attempt.input.directory);assert.equal(request.headers['x-opencode-directory'],request.headers['x-devryan-directory']);assert.equal(request.headers['x-opencode-session'],attempt.input.sessionID);assert.match(request.headers['x-opencode-request'],/^req_/);assert.equal(request.headers['x-opencode-agent-name'],'Build');assert.equal(request.headers['x-opencode-agent-mode'],'primary');assert.equal(request.headers['anthropic-beta'],undefined);assert.equal(request.headers['x-api-key'],undefined);assert.equal(meridianEnded.includes(attempt.id),false);
      assert.ok(JSON.stringify(body.system).includes('Keep owned tool policy.'));assert.equal(JSON.stringify(body.system).includes('You are OpenCode, the best coding agent on the planet.'),false,'Exact captured system scrub must run on the physical request');
      if(JSON.stringify(body).includes('Owned transport failure')){response.writeHead(503,{'content-type':'application/json','x-should-retry':'false'});response.end(JSON.stringify({error:{type:'overloaded_error',message:'Owned transport failure'}}));return;}
      if(JSON.stringify(body).includes('Owned transport cancellation')){response.writeHead(200,{'content-type':'text/event-stream'});response.write('event: message_start\\ndata: '+JSON.stringify({type:'message_start',message:{id:'owned-cancel',type:'message',role:'assistant',model:'claude-owned',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}})+'\\n\\n');meridianCancelObserved?.();return;}
      const events=[{type:'message_start',message:{id:'owned-message',type:'message',role:'assistant',model:'claude-owned',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Owned Meridian completion'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:5}},{type:'message_stop'}];response.writeHead(200,{'content-type':'text/event-stream'});response.write('event: message_start\\n'+'data: '+JSON.stringify(events.shift())+'\\n\\n');meridianObserved?.();await new Promise(resolve=>setImmediate(resolve));assert.equal(meridianEnded.includes(attempt.id),false,'Scope must survive headers and first response bytes');response.end(events.map(event=>'event: '+event.type+'\\ndata: '+JSON.stringify(event)+'\\n\\n').join(''));return;
    }
    if (request.url === '/api/accounts/oauth/token')`);

  replace("  if (method === 'openai.attempt')",`  if(method==='provider.catalog')return await factory.readCatalogSelectionOwned(input);
  if(method==='provider.meridian.begin'){
    assert.ok(ownedTokens.has(input.permit.token));let begin,deny,finish;const bound=new Promise((resolve,reject)=>{begin=resolve;deny=reject;});const work=admissionOwner.withProviderAttempt(input,async()=>{const id=createHash('sha256').update(String(meridianAttempts.size)+input.sessionID).digest('hex');const settled=new Promise(resolve=>{finish=resolve;});meridianAttempts.set(id,{id,input,finish,work:undefined});begin({attemptID:id,origin:loopback,authorization:'e'.repeat(64),directory:input.directory,sessionID:input.sessionID,controllerInstanceID:controller.instanceID});await settled;});void work.catch(deny);const value=await bound;meridianAttempts.get(value.attemptID).work=work;return value;
  }
  if(method==='provider.meridian.assert'||method==='provider.meridian.end'){
    const attempt=meridianAttempts.get(input.attemptID);assert.ok(attempt);assert.equal(input.sessionID,attempt.input.sessionID);assert.equal(input.directory,attempt.input.directory);if(method.endsWith('.assert'))return admissionOwner.withProviderAttempt(attempt.input,async()=>{});attempt.finish();await attempt.work;meridianEnded.push(attempt.id);return null;
  }
  if (method === 'openai.attempt')`);
  const old="const compatibility=createNativeProviderCompatibility({isOpenAiOAuth:factory.isOpenAiTokenSharing,policyForDirectory:()=>({compactionReserved:7500})});";
  const origin="const compatibilityOrigin={kind:'plugin',id:'devryan.provider-compat',manifestDigest:createHash('sha256').update(await fs.readFile(new URL('../../packages/web/server/lib/opencode/runtime-host/native-provider-compat-plugin.ts',import.meta.url))).digest('hex'),capabilities:['provider']};";
  replace(old,'');replace(origin,'');replace('const factory = createControllerIntegrations(',origin+'\nconst factory = createControllerIntegrations(');replace('  registrationOrigin: nativePlugins.get(\'devryan.remote-mcp\'),','  providerCompatibilityOrigin:compatibilityOrigin,registrationOrigin: nativePlugins.get(\'devryan.remote-mcp\'),');replace('let result, primaryFailure;',`// This fiber-local seam qualifies catalog policy wiring only. Physical requests
// keep the real selected browser credential and its original authority predicate.
const ModelPolicyFixture=Context.Reference('DevRyan/FixtureTokenSharingModelPolicy',{defaultValue:()=>false});
const compatibility=createControllerProviders({controllerInstanceID:controller.instanceID,configurationSnapshot:snapshot,origin:compatibilityOrigin,scrubSystem,
 integrations:{...factory,isOpenAiTokenSharing:directory=>Effect.flatMap(ModelPolicyFixture,fixture=>fixture?Effect.succeed(true):factory.isOpenAiTokenSharing(directory))},
 rpc,isBound:()=>Boolean(nativeURL),isExecutionReady:()=>ready});
const combinedObservation=createNativeObservation({controllerInstanceID:controller.instanceID,configurationDigest:snapshot.digest,rpc,decorateModelRequests:compatibility.decorateModelRequests});
let result, primaryFailure;`);
  replace("assert.ok(models.every(model=>model.enabled!==false),'Available models must follow OpenCode availability');}};",`assert.ok(models.every(model=>model.enabled!==false),'Available models must follow OpenCode availability');
    assert.equal(await Effect.runPromise(factory.isOpenAiTokenSharing(directory)),false,'Physical credential remains browser-selected');
    const before={requests:receipts.length,attempts:meridianAttempts.size};
    const policyModels=await at(directory,Effect.gen(function*(){const service=yield* Model.Service;return yield* service.available();}).pipe(Effect.provideService(ModelPolicyFixture,true)));
    const policySol=policyModels.find(model=>model.id==='gpt-5.6-sol');assert.ok(policySol);
    assert.equal(policySol.limit.context,1050000,'Reserve must preserve usable context');
    assert.equal(policySol.limit.input,256000+(directory===directories[0]?0:12000),'Native zero/12000 buffer must override legacy7500');
    assert.deepEqual({requests:receipts.length,attempts:meridianAttempts.size},before,'Catalog policy read cannot start a physical attempt');
  }};`);
  replace('...factory.overrides,...compatibility.overrides,','...factory.overrides,...compatibility.catalogOverrides,...combinedObservation.overrides,');
  replace('const gates = createAdmissionGates({',"const routing=createExecutionRouting({rpc,bridge,directory:directories[0],locations:directories.map(directory=>({directory,readRoots:[directory],protectedRoots:[globals.home]})),configurationSnapshot:snapshot});\nconst gates = createAdmissionGates({");
  replace("executeOwned: () => Effect.die(new Error('Unexpected executable tool'))",'executeOwned:routing.executeOwned');
  replace('...combinedObservation.overrides,','...combinedObservation.overrides,...routing.overrides,');
  replace('const actual=factory.providerHooks(inner);','const actual=combinedObservation.decorateHooks(factory.providerHooks(inner));');
  replace('      const message = { id: `message_${receiptNumber}`,',`      const toolResult=body.input.find(item=>item.type==='function_call_output'&&item.call_id==='owned_transport_read');if(kind==='primary'&&toolResult){assert.ok(JSON.stringify(toolResult).includes('Owned native tool proof'),JSON.stringify(toolResult));toolReturned=true;}
      const useTool=kind==='primary'&&!toolRequested;if(useTool){const tools=body.tools;assert.ok(tools.some(tool=>tool.name==='read'));toolRequested=true;}
      const message = useTool?{id:'owned_transport_function',type:'function_call',call_id:'owned_transport_read',name:'read',arguments:JSON.stringify({path:path.join(directories[0],'owned-proof.txt')}),status:'completed'}:{ id: \`message_\${receiptNumber}\`,`);
  replace("        { type: 'response.content_part.added',", "        ...useTool?[]:[{ type: 'response.content_part.added',");
  replace("        { type: 'response.output_item.done', output_index: 0, item: message },", "        ],...useTool?[{type:'response.function_call_arguments.delta',item_id:message.id,output_index:0,delta:message.arguments},{type:'response.function_call_arguments.done',item_id:message.id,output_index:0,arguments:message.arguments}]:[],{ type: 'response.output_item.done', output_index: 0, item: message },");
  replace("receipts.length,2,'Native title and primary", "receipts.length,3,'Native title and primary");
  replace('receipts.length<2','receipts.length<3');
  replace('while(Date.now()<end){ const page=',"while(Date.now()<end){ const permissions=await client.interaction.permissions.list({directory:directories[0]},{sessionID:session.id});for(const permission of permissions)await callerContext.run(caller,()=>client.interaction.permissions.reply(permission.id,{reply:'once'},{directory:directories[0],sessionID:session.id})); const page=");
  replace("completed=page.records.some(row=>row.info.role==='assistant'&&row.info.time.completed)","completed=toolReturned&&page.records.some(row=>row.info.role==='assistant'&&row.info.time.completed&&row.info.finish==='stop')");
  replace("['primary','title']);", "['primary','primary','title']);assert.equal(toolRequested,true);assert.equal(toolReturned,true);");
  replace("  assert.deepEqual(result.providerKinds,['compaction','generate','primary','title']);",`  assert.deepEqual(result.providerKinds,['compaction','generate','primary','title']);
  assert.equal(websocketUpgrades,0,'native Codex must never upgrade a physical socket');
  const hooks=(await fs.readFile(path.join(root,'hooks.jsonl'),'utf8')).trim().split('\\n').map(line=>JSON.parse(line));assert.equal(hooks.some(row=>row.name==='experimental.ws.handshake'||row.name==='experimental.ws.send'),false,'native Codex must never attempt native WebSocket hooks');
  const openaiPrepared=observations.filter(row=>row.stage==='model-prepared'&&row.execution.providerID==='openai');assert.ok(openaiPrepared.some(row=>row.kind==='primary'));assert.ok(openaiPrepared.some(row=>row.kind==='title'));for(const prepared of openaiPrepared){const physical=observations.filter(row=>row.stage==='physical'&&row.requestID===prepared.requestID);assert.ok(physical.length>0,'Every prepared native Codex request must reach physical HTTP');assert.ok(physical.every(row=>row.transport==='http'));}
  result.toolRoundTrip=true;`);
  replace('  await verifyModels();\n  const old=',`  if(${claudeCatalog===true})for(const directory of directories)await at(directory,Effect.gen(function*(){
    const integration=yield* Integration.Service;const anthropic=yield* integration.get(Integration.ID.make('anthropic'));assert.deepEqual(anthropic.connections,[],'Catalog activation must not manufacture a native Anthropic credential');
    const providers=yield* Provider.Service;assert.ok((yield* providers.snapshot()).available.some(row=>row.provider.id==='anthropic'),'Original Provider snapshot must activate selected Claude');
    const models=yield* (yield* Model.Service).available();assert.ok(models.some(row=>row.providerID==='anthropic'&&row.id==='claude-owned'));
  }));
  const meridianSession=await callerContext.run(caller,()=>client.sessions.create({model:{providerID:'anthropic',modelID:'claude-owned'}},{directory:directories[0]}));
  const meridianCall=async prompt=>{const permit=await admissionOwner.handleRpc('native.admission.authorize',{operation:'execution.resume',sessionID:meridianSession.id});ownedTokens.add(permit.token);try{return await call(directories[0],'/api/session/'+meridianSession.id+'/generate','POST',{prompt},{'x-devryan-native-permit':JSON.stringify(permit)});}finally{await admissionOwner.handleRpc('native.admission.release',permit);}};
  const unownedPreparedIDs=new Set();if(${claudeCatalog===true}){
   await assert.rejects(()=>call(directories[0],'/api/session/'+meridianSession.id+'/generate','POST',{prompt:'Unowned catalog metadata request'}),/500|403/);assert.equal(meridianAttempts.size,0,'Visible catalog metadata must not grant a physical attempt');
   const unowned=observations.filter(row=>row.stage==='model-prepared'&&row.sessionID===meridianSession.id);assert.equal(unowned.length,1);unownedPreparedIDs.add(unowned[0].requestID);
   assert.equal(observations.some(row=>row.stage==='physical'&&unownedPreparedIDs.has(row.requestID)),false,'Unowned prepared metadata must not reach physical transport');
  }
  const generated=await meridianCall('Owned real transport cwd="'+directories[1]+'"');assert.equal(generated.data.text,'Owned Meridian completion');assert.equal(meridianEnded.length,1);
  await assert.rejects(()=>meridianCall('Owned transport failure'),/ServiceUnavailableError/);assert.equal(meridianEnded.length,2,'Failed physical fetch must settle original attempt');
  const cancelPermit=await admissionOwner.handleRpc('native.admission.authorize',{operation:'execution.resume',sessionID:meridianSession.id});ownedTokens.add(cancelPermit.token);const cancel=new AbortController();let cancellationReached=false;meridianCancelObserved=()=>{cancellationReached=true;};
  const pending=nativeFetch(nativeURL+'/api/session/'+meridianSession.id+'/generate',{method:'POST',headers:{'x-opencode-directory':encodeURIComponent(directories[0]),'content-type':'application/json','x-devryan-native-permit':JSON.stringify(cancelPermit)},body:JSON.stringify({prompt:'Owned transport cancellation'}),signal:cancel.signal});const cancelled=assert.rejects(pending,error=>error.name==='AbortError');
  try{const deadline=Date.now()+5000;while(!cancellationReached&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(cancellationReached,true,'Actual physical stream must start before cancellation');cancel.abort();await cancelled;while(meridianEnded.length<3&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(meridianEnded.length,3,'Browser request cancellation must settle original native transport Scope');}finally{cancel.abort();await admissionOwner.handleRpc('native.admission.release',cancelPermit);}
  const meridianPrepared=observations.filter(row=>row.stage==='model-prepared'&&row.sessionID===meridianSession.id&&!unownedPreparedIDs.has(row.requestID));
  assert.equal(meridianPrepared.length,3);for(const prepared of meridianPrepared){assert.equal(prepared.kind,'generate');assert.equal(prepared.execution.providerID,'anthropic');assert.equal(prepared.directory,directories[0]);const physical=observations.filter(row=>row.stage==='physical'&&row.requestID===prepared.requestID);assert.equal(physical.length,1);assert.equal(physical[0].transport,'http');assert.equal(physical[0].sessionID,prepared.sessionID);assert.equal(physical[0].directory,prepared.directory);}
  assert.ok(observations.some(row=>row.stage==='physical'&&row.transport==='http'),'native Codex OpenAI physical observations remain active');
  result.meridianMiddleware=true;result.providerObservationComposed=true;
  await verifyModels();
  const old=`);
  if(anthropicBaseURL)replace('  await verifyModels();\n  const old=',`  for(const modelID of ${JSON.stringify(Object.keys(refusedBases))}){
    const session=await callerContext.run(caller,()=>client.sessions.create({model:{providerID:'anthropic',modelID}},{directory:directories[0]}));
    const permit=await admissionOwner.handleRpc('native.admission.authorize',{operation:'execution.resume',sessionID:session.id});ownedTokens.add(permit.token);const ended=meridianEnded.length;
    try{await assert.rejects(()=>call(directories[0],'/api/session/'+session.id+'/generate','POST',{prompt:'Owned unreviewed route'},{'x-devryan-native-permit':JSON.stringify(permit)}),/500/);assert.equal(meridianEnded.length,ended+1,'Refused route still settles its owned attempt');}
    finally{await admissionOwner.handleRpc('native.admission.release',permit);}
  }
  assert.equal((await fs.readFile(path.join(root,'reported-causes.jsonl'),'utf8')).trim().split('\\n').map(line=>JSON.parse(line)).filter(rows=>rows.some(row=>row.code==='native_meridian_route_unreviewed'||row.message?.includes('native_meridian_route_unreviewed'))).length,3,'Only prefix, userinfo and hash routes must be refused');
  await verifyModels();
  const old=`);
  replace('  await cleanup(() => factory.close());','  await cleanup(() => {compatibility.close();});\n  await cleanup(() => factory.close());');
  replace('  await cleanup(() => runtime.drain());','  await cleanup(() => routing.close());\n  await cleanup(() => runtime.drain());');
  source="import {Provider} from '@opencode/core/provider';\n"+source;
  source=source.replace(/from (['"])(\.\.\/\.\.\/[^'"]+)\1/g,(_all,_quote,relative:string)=>'from '+JSON.stringify(pathToFileURL(path.resolve(path.dirname(sourcePath),relative)).href));
  source=source.replace(/new URL\((['"])(\.\.\/\.\.\/[^'"]+)\1,import\.meta\.url\)/g,(_all,_quote,relative:string)=>'new URL('+JSON.stringify(pathToFileURL(path.resolve(path.dirname(sourcePath),relative)).href)+')');
  const entry=path.join(root,'fixture.mjs');await fs.writeFile(entry,source);let command=[process.execPath,entry];
  if(compiled){
   const disk=Bun.spawn(['df','-h',repository],{stdout:'pipe',stderr:'pipe'});if(await disk.exited!==0)throw Error('Disk check unavailable');
   const executable=path.join(root,'DevRyan-Claude-catalog-fixture');
   const build=await Bun.build({entrypoints:[entry],target:'bun',compile:{target:'bun-darwin-arm64',outfile:executable,autoloadDotenv:false,autoloadBunfig:false,autoloadTsconfig:false,autoloadPackageJson:false},plugins:[await createNativeAssetFixturePlugin(repository),reviewedNativeInputPlugin(await prepareReviewedNativeInputs(repository))]});
   if(!build.success)throw new AggregateError(build.logs,'Compiled Claude catalog fixture failed');await fs.chmod(executable,0o755);command=[executable];
  }
  child=Bun.spawn(command,{cwd:repository,env:{PATH:'/usr/bin:/bin',HOME:home,TMPDIR:tmp,XDG_CONFIG_HOME:path.join(home,'config'),XDG_DATA_HOME:path.join(home,'data'),XDG_STATE_HOME:path.join(home,'state'),XDG_CACHE_HOME:path.join(home,'cache'),GIT_CEILING_DIRECTORIES:root,DEVRYAN_INTEGRATION_FIXTURE_ROOT:root},stdout:'pipe',stderr:'pipe'});
  if(!child.stdout||typeof child.stdout==='number'||!child.stderr||typeof child.stderr==='number')throw new Error('Owned child pipes required');
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);await fs.writeFile(path.join(keptDiagnostics(root),'stage-d-provider-transport-child.log'),stderr);await fs.writeFile(path.join(keptDiagnostics(root),'stage-d-provider-transport-child.stdout.log'),stdout);
  for(const name of ['rpc-errors.jsonl','native-causes.jsonl','reported-causes.jsonl','hooks.jsonl'])await fs.copyFile(path.join(root,name),path.join(keptDiagnostics(root),`stage-d-provider-transport-${transport??'omitted'}-${name}`)).catch(error=>{if(error.code!=='ENOENT')throw error;});
  expect({code,stderr}).toEqual({code:0,stderr:''});expect(JSON.parse(stdout).meridianMiddleware).toBe(true);expect(JSON.parse(stdout).providerObservationComposed).toBe(true);
 }finally{if(child&&child.exitCode===null){child.kill();await child.exited;}await fs.rm(root,{recursive:true,force:true});}
},120000);
