import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {Credential} from '@opencode/core/credential';
import {Effect,Schema} from 'effect';
import {HostRefusal,refuseHost} from '../../packages/web/server/lib/opencode/runtime-host/host-refusal.js';
import {parseNativeBoot,parseNativeCommand,parseNativeMigrationRequest} from '../../packages/web/server/lib/opencode/runtime-host/native-process-protocol.js';

test('catalog selection command retains exact reviewed acquisition binding',()=>{
 const command={protocol:1,id:'catalog',action:'provider-catalog-selection-owned',directory:'/project/a',controllerInstanceID:'controller-one',integrationID:'github-copilot',acquisitionID:'acquisition-one',configurationDigest:'a'.repeat(64),origin:{id:'devryan.provider-compat',manifestDigest:'b'.repeat(64)}} as const;
 expect(parseNativeCommand(command)).toEqual(command);
 for(const changed of [{...command,directory:'relative'},{...command,integrationID:'openai'},{...command,acquisitionID:''},{...command,acquisitionID:'a'.repeat(257)},{...command,configurationDigest:'bad'},{...command,origin:{...command.origin,id:'forged'}},{...command,origin:{...command.origin,manifestDigest:'bad'}},{...command,origin:{...command.origin,capabilities:['provider']}},{...command,permit:{token:'c'.repeat(64),revision:0}}])expect(()=>parseNativeCommand(changed)).toThrow();
});
import {createNativeCommandDispatcher} from '../../packages/web/server/lib/opencode/runtime-host/controller-dispatch.js';
import {assertNativeCatalog} from '../../packages/web/server/lib/opencode/runtime-host/startup-catalog.js';
import {createCursorSdkRuntime} from '../../packages/cursor-sdk-runtime/index.js';
const globals={home:'/owned/home',config:'/owned/config',data:'/owned/data',cache:'/owned/cache',state:'/owned/state',tmp:'/owned/tmp',bin:'/owned/bin',log:'/owned/log',repos:'/owned/repos'};
const boot=()=>({protocol:1 as const,type:'boot' as const,bundleID:'data-bundle',instanceID:'controller-instance',buildId:'a'.repeat(64),manifestSha256:'b'.repeat(64),databasePath:'/owned/data/native.db',globals,directory:'/project/a',locations:[{directory:'/project/a',readRoots:['/project/a'],protectedRoots:['/owned']}],bridge:{url:'http://127.0.0.1:12/private',token:'c'.repeat(64)},httpToken:'d'.repeat(64),configuration:{},reviewedPlugins:[],migrationEvidence:{path:'/owned/migration.json',sha256:'e'.repeat(64)},catalogRequirements:{agents:[],plugins:[],tools:[],models:[]}});
test('boot accepts only finite Cursor declaration metadata, never credentials or another provider',()=>{
 const value={...boot(),cursorCatalog:{id:'cursor-acp' as const,models:[{id:'composer-2.5',variants:[]}]}};
 expect(parseNativeBoot(value)).toEqual(value);
 for(const cursorCatalog of [{...value.cursorCatalog,id:'openai'}, {...value.cursorCatalog,key:'private'},
  {id:'cursor-acp',models:[{id:'composer-2.5',variants:['high','high']}]},
  {id:'cursor-acp',models:[...value.cursorCatalog.models,...value.cursorCatalog.models]},
  {id:'cursor-acp',models:[{id:'composer-2.5',variants:[],credentialID:'forged'}]}])expect(()=>parseNativeBoot({...value,cursorCatalog})).toThrow();
});
test('shared protocol separates artifact identity from mutable data and refuses unsealed or remote input',()=>{
 const value=boot();expect(parseNativeBoot(value)).toEqual(value);
 const clone=parseNativeBoot(value);expect(clone).not.toBe(value);
 for(const mutation of [()=>({...value,locations:[]}),()=>({...value,locations:[...value.locations,...value.locations]}),()=>({...value,bridge:{...value.bridge,url:'https://example.invalid'}}),()=>({...value,buildId:'data-bundle'}),()=>({...value,secret:'unknown'})]) expect(()=>parseNativeBoot(mutation())).toThrow();
 expect(()=>parseNativeCommand({protocol:1,id:'1',action:'resume',sessionID:'ses_fixture'})).toThrow();
 expect(()=>parseNativeCommand({protocol:1,id:'1',action:'wake-owned',sessionID:'ses_fixture',permit:{token:'a'.repeat(64),sessionID:'ses_other',revision:1}})).toThrow();
 const removal={protocol:1 as const,id:'remove',action:'remove-leaf-owned' as const,intentID:'owned-intent',sessionID:'ses_fixture',permit:{token:'a'.repeat(64),sessionID:'ses_fixture',revision:1}};
 expect(parseNativeCommand(removal)).toEqual(removal);
 for(const mutation of [()=>({...removal,intentID:''}),()=>({...removal,permit:undefined}),()=>({...removal,sessionID:'ses_other'}),()=>({...removal,recursive:true})]) expect(()=>parseNativeCommand(mutation())).toThrow();
 expect(()=>parseNativeMigrationRequest({protocol:'devryan-native-migration/1',requestID:'request',bundleID:'data-bundle',candidateDatabasePath:'relative',isolatedRoot:'/owned',receiptPath:'/owned/receipt',auxiliary:{kind:'absent'},projectMap:[]})).toThrow();
});
test('clone boot accepts only canonical sealed prepared proof, never a caller supplied origin',()=>{
 const value={...boot(),databasePath:'/owned/B/opencode/opencode.db',migrationEvidence:{path:'/owned/B/sources/migration.json',sha256:'e'.repeat(64),clone:{preparedManifestPath:'/owned/B/prepared.json',preparedManifestSha256:'f'.repeat(64)}}};
 expect(parseNativeBoot(value)).toEqual(value);
 for(const clone of [{...value.migrationEvidence.clone,origin:{bundleID:'A',databasePath:'/A/db'}},{...value.migrationEvidence.clone,preparedManifestPath:'/owned/B/sources/../prepared.json'},{...value.migrationEvidence.clone,preparedManifestSha256:'bad'}])expect(()=>parseNativeBoot({...value,migrationEvidence:{...value.migrationEvidence,clone}})).toThrow();
 expect(()=>parseNativeBoot({...value,databasePath:'/owned/other.db'})).toThrow();
});
test('boot validates exact per-location model effort requirements even with a valid snapshot digest',()=>{
 const value=boot();
 const make=(models:unknown[])=>{
  const body={schema:1,revision:1,sourceStamp:'a'.repeat(64),registrationManifestDigest:'b'.repeat(64),locations:[{
   directory:'/project/a',configuration:{},compatibility:{},skills:[],aliases:[],activePlugins:[],
   requiredCatalogs:{agents:[],plugins:[],tools:[],models,skills:[],commands:[],mcp:[]},
  }]};
  return {...value,configurationSnapshot:{...body,digest:createHash('sha256').update(JSON.stringify(body)).digest('hex')}};
 };
 const required={providerID:'openai',id:'gpt-6.1-sol',variant:'high'};
 expect(parseNativeBoot(make([required])).configurationSnapshot?.locations[0]?.requiredCatalogs.models).toEqual([required]);
 for(const ref of [{...required,variant:null},{...required,variant:''},{...required,id:''},{...required,unexpected:true}])expect(()=>parseNativeBoot(make([ref]))).toThrow();
});
test('close allows correlated settlement reentry and only acknowledges after drain; failures propagate',async()=>{
 const replies:unknown[]=[];let closed=0,settle:()=>void=()=>{};const settled=new Promise<void>(resolve=>{settle=resolve;});
 const dispatcher=createNativeCommandDispatcher({closeStartup:()=>{closed++;},respond:(id,result)=>replies.push({id,...result}),run:async command=>{
  if(command.action==='close'){await settled;return {settled:true};}
  if(command.action==='wake-deferred-owned'){settle();return {kind:'idle'};}
  throw Object.assign(new Error('fixture'),{code:'native_fixture_refused',status:403});
 }});
 dispatcher.dispatch({protocol:1,id:'close',action:'close'});
 await Promise.resolve();expect(replies).toEqual([]);expect(closed).toBe(1);
 dispatcher.dispatch({protocol:1,id:'settlement',action:'wake-deferred-owned',sessionID:'ses_fixture',permit:{token:'a'.repeat(64),revision:0}});
 dispatcher.dispatch({protocol:1,id:'start',action:'open'});
 await dispatcher.drain();
 expect(replies).toContainEqual({id:'close',ok:true,result:{settled:true}});
 expect(replies).toContainEqual({id:'settlement',ok:true,result:{kind:'idle'}});
 expect(replies).toContainEqual({id:'start',ok:false,error:{code:'native_controller_stopping',status:409,message:'native_controller_stopping'}});
 const failed=createNativeCommandDispatcher({closeStartup:()=>{},respond:(id,result)=>replies.push({id,...result}),run:async()=>{throw Object.assign(new Error('unserialized secret'),{code:'native_fixture_refused',status:403});}});
 failed.dispatch({protocol:1,id:'refusal',action:'open'});await failed.drain();
 expect(replies).toContainEqual({id:'refusal',ok:false,error:{code:'native_fixture_refused',status:403,message:'native_fixture_refused'}});
});
test('private credential commands bind controller, directory and method without accepting extra payloads',()=>{
 const value=Schema.decodeUnknownSync(Credential.OAuth)({type:'oauth',methodID:'chatgpt-siwc',access:'fixture-access',refresh:'fixture-refresh',expires:123,metadata:{accountID:'fixture'}});
 const command={protocol:1 as const,id:'private-cas',action:'openai-cas-selected-owned' as const,directory:'/project/a',controllerInstanceID:'controller-one',
  expected:{directory:'/project/a',controllerInstanceID:'controller-one',integrationID:'openai' as const,credentialID:'credential-one',value},next:{...value,access:'next-fixture-access'}};
 expect(parseNativeCommand(command)).toEqual(command);
 for(const changed of [{...command,directory:'/project/b'},{...command,controllerInstanceID:'controller-two'},
  {...command,next:{...value,methodID:'chatgpt-browser'}},{...command,next:{...value,unexpected:true}}]) expect(()=>parseNativeCommand(changed)).toThrow();
 expect(parseNativeCommand({protocol:1,id:'commit',action:'credential-commit-owned',callID:'call-one',controllerInstanceID:'controller-one',bindingFingerprint:'b'.repeat(64)}).action).toBe('credential-commit-owned');
});
test('manual credential commands accept only key creation, labels and exact account operations',()=>{
 const base={protocol:1,id:'credential',action:'credential-operation-owned',directory:'/project/a',controllerInstanceID:'controller-one',requestAuthorization:'c'.repeat(64)};
 const input={integrationID:'openai',value:{type:'key',key:'synthetic-fixture'},label:'',activate:false};
 const mutations=[{operation:'create',input},{operation:'update',id:'credential-one',updates:{label:''}},{operation:'activate',id:'credential-one'},{operation:'remove',id:'credential-one'}];
 const cursor={operation:'create',input:{...input,integrationID:'cursor-acp'}};
 mutations.push(cursor);
 for(const mutation of mutations)expect<unknown>(parseNativeCommand({...base,mutation})).toEqual({...base,mutation});
 const invalid=[{operation:'create',input:{...input,integrationID:'other'}},{operation:'create',input:{...input,value:{type:'oauth',access:'fixture'}}},
  {operation:'create',input:{...input,value:{...input.value,metadata:{unreviewed:true}}}},{operation:'create',input:{...input,activate:'false'}},
  {operation:'update',id:'credential-one',updates:{label:'new',value:input.value}},{operation:'update',id:'credential-one',updates:{}},
  {operation:'remove',id:'credential/other'},{operation:'activate',id:'credential-one',directory:'/project/b'}];
 for(const mutation of invalid)expect(()=>parseNativeCommand({...base,mutation})).toThrow();
 expect(()=>parseNativeCommand({...base,requestAuthorization:undefined,mutation:mutations[0]})).toThrow();
 expect(()=>parseNativeCommand({...base,directory:'relative',mutation:mutations[0]})).toThrow();
});
test('catalog assertion uses every actual location and keeps missing original tools closed',async()=>{
 const assertion=await assertNativeCatalog({directories:['/project/a','/project/b'],requirements:{agents:['build'],plugins:[],tools:['read','original-plugin-tool'],models:[{providerID:'owned',id:'model'}]},tools:async directory=>directory==='/project/a'?['read','original-plugin-tool']:['read'],handler:async request=>{
  const directory=decodeURIComponent(request.headers.get('x-opencode-directory')!);
  const route=new URL(request.url).pathname;
  return Response.json({location:{directory},data:route==='/api/agent'?[{id:'build'}]:route==='/api/model'?[{providerID:'owned',id:'model'}]:[]});
 }});
 expect(assertion).toEqual({asserted:false,missing:{agents:[],plugins:[],tools:['original-plugin-tool'],models:[]},availability:{selections:
  ['/project/a','/project/b'].map(directory=>({directory,source:{kind:'requirement',index:0},providerID:'owned',modelID:'model',variant:null,status:'available',reason:null}))}});
});

test('configured agent inventory is captured after the actual activation barrier',async()=>{
 let activated=false,reads=0;
 const result=await assertNativeCatalog({directories:['/project/a'],requirements:{agents:['configured-agent'],plugins:[],tools:['read'],models:[]},tools:async()=>{activated=true;return ['read'];},handler:async request=>{
  const route=new URL(request.url).pathname;if(route==='/api/agent') reads++;
  return Response.json({location:{directory:'/project/a'},data:route==='/api/agent'&&activated?[{id:'configured-agent'}]:[]});
 }});
 expect(result.asserted).toBe(true);expect(reads).toBe(2);
});

test('catalog preserves an original request-scoped HostRefusal caught into an empty SDK 500',async()=>{
 const requirements={agents:[],plugins:[],tools:[],models:[]};let tools=0;
 const inspect=(refuse:boolean)=>assertNativeCatalog({directories:['/private/project'],requirements,
  tools:async()=>{tools++;return [];},handler:async()=>{
   if(refuse){try{await Effect.runPromise(refuseHost(new HostRefusal('native_helper_directory_denied',403,'private operation /secret', 'secret-session')));}catch{return new Response(null,{status:500});}}
   return new Response(null,{status:500});
  }});
 const outcomes=await Promise.allSettled([inspect(true),inspect(false)]);
 expect(outcomes.every(row=>row.status==='rejected')).toBe(true);
 const messages=outcomes.map(row=>row.status==='rejected'?String(row.reason.message):'');
 expect(messages).toEqual(['native_catalog_read_failed_agent_http_500_helper_directory_denied',
  'native_catalog_read_failed_agent_http_500_cause_unavailable']);
 expect(tools).toBe(0);
 for(const message of messages)expect(message).toMatch(/^(?:native|opencode)_[a-z0-9_]{1,80}$/);
 await expect(assertNativeCatalog({directories:['/private/project'],requirements,tools:async()=>[],
  handler:async()=>{throw new HostRefusal('native_helper_denied',403,'private operation');}}))
  .rejects.toThrow('native_catalog_read_failed_agent_refusal_403_helper_denied');
});

test('catalog non-OK diagnostics never infer a cause from response text or payload fields',async()=>{
 const requirements={agents:[],plugins:[],tools:[],models:[]};
 const cases=[
  {route:'/api/agent',status:409,body:{code:'controller_helper_unavailable',message:'secret /private/home',config:{token:'secret'}},reason:'cause_unavailable'},
  {route:'/api/plugin',status:503,body:{error:{code:'native_catalog_unavailable',stack:'secret stack'}},reason:'cause_unavailable'},
  {route:'/api/model',status:500,body:{error:{name:'TypeError',message:'secret model config'}},reason:'cause_unavailable'},
  {route:'/api/agent',status:500,body:{code:'native_secret_value',name:'PrivateAccount',message:'native_helper_directory_denied'},reason:'cause_unavailable'},
  {route:'/api/agent',status:500,body:{code:'native_helper_denied',message:'secret'.repeat(1000)},reason:'cause_unavailable'},
 ];
 for(const failure of cases){
  const inspect=assertNativeCatalog({directories:['/private/project'],requirements,tools:async()=>[],handler:async request=>{
   const route=new URL(request.url).pathname;
   return route===failure.route?Response.json(failure.body,{status:failure.status}):Response.json({location:{directory:'/private/project'},data:[]});
  }});
  await expect(inspect).rejects.toThrow(`native_catalog_read_failed_${failure.route.slice(5)}_http_${failure.status}_${failure.reason}`);
 }
 for(const body of ['not JSON','{"code":"native_helper_denied"']){
  await expect(assertNativeCatalog({directories:['/private/project'],requirements,tools:async()=>[],
   handler:async()=>new Response(body,{status:502,headers:{'content-type':'application/json'}})})).rejects.toThrow('native_catalog_read_failed_agent_http_502_cause_unavailable');
 }
});

test('catalog readiness checks only each location exact model and supported effort',async()=>{
 const requirements={agents:[],plugins:[],tools:[],models:[]};
 const a={...requirements,models:[{providerID:'openai',id:'gpt-6-astra',variant:'high'}]};
 const b={...requirements,models:[{providerID:'xai',id:'grok-4.6',variant:'default'}]};
 let effort='high',missing=false;
 const inspect=()=>assertNativeCatalog({directories:['/a','/b'],requirements,
  requirementsForDirectory:directory=>directory==='/a'?a:b,tools:async()=>[],handler:async request=>{
   const directory=decodeURIComponent(request.headers.get('x-opencode-directory')!);
   const data=new URL(request.url).pathname==='/api/model'
    ? directory==='/a'?(missing?[]:[{providerID:'openai',id:'gpt-6-astra',variants:[{id:effort}]}]):[{providerID:'xai',id:'grok-4.6',variants:[]}]:[];
   return Response.json({location:{directory},data});
  }});
 expect((await inspect()).asserted).toBe(true);
 effort='low';expect((await inspect()).missing.models).toEqual(a.models);
 missing=true;expect((await inspect()).missing.models).toEqual(a.models);
 await expect(assertNativeCatalog({directories:['/unreviewed'],requirements,
  requirementsForDirectory:()=>undefined,tools:async()=>[],handler:async()=>Response.json({})})).rejects.toThrow('native_catalog_requirements_missing');
});

test('Cursor offline declarations preserve exact per-location selections without claiming selected-account availability',async()=>{
 let loads=0,reads=0;
 const runtime=createCursorSdkRuntime({storageDir:'/unused',env:{},ripgrepPath:'/usr/bin/true',nativeWarming:false,
  readAuth:()=>{reads++;throw Error('Unexpected auth');},loadSdk:async()=>{loads++;throw Error('Unexpected SDK');}});
 try{
  const declared=runtime.getDeclaredVirtualProvider();
  const cursorCatalog={id:'cursor-acp' as const,models:Object.values(declared.models).map(model=>({id:model.id,variants:Object.keys(model.variants??{})}))};
  const requirements={agents:[],plugins:[],tools:[],models:[]};
  let selected='composer-2.5',variant='default';
  const native={providerID:'owned',id:'native-model',variant:'high'};
  const inspect=(present=true)=>assertNativeCatalog({directories:['/a','/b'],requirements,
   ...(present?{cursorCatalog}:{}),requirementsForDirectory:directory=>({...requirements,models:directory==='/a'?[{providerID:'cursor-acp',id:selected,variant}]:[native]}),
   tools:async()=>[],handler:async request=>{
    const directory=decodeURIComponent(request.headers.get('x-opencode-directory')!);
    return Response.json({location:{directory},data:new URL(request.url).pathname==='/api/model'&&directory==='/b'?[{...native,variants:[{id:'high'}]}]:[]});
   }});
  for(const selection of [{model:'composer-2.5',effort:'default'},{model:'composer',effort:'default'},
   {model:'composer-2.5',effort:'high'},{model:'composer-2.5',effort:'unsupported'}]){
   selected=selection.model;variant=selection.effort;
   for(const present of [true,false]){
    expect(await inspect(present)).toEqual({asserted:true,missing:{agents:[],plugins:[],tools:[],models:[]},availability:{selections:[
     {directory:'/a',source:{kind:'requirement',index:0},providerID:'cursor-acp',modelID:selected,
      variant:variant==='default'?null:variant,status:'unknown',reason:'catalog_unavailable'},
     {directory:'/b',source:{kind:'requirement',index:0},providerID:'owned',modelID:'native-model',variant:'high',status:'available',reason:null},
    ]}});
   }
  }
  expect({loads,reads}).toEqual({loads:0,reads:0});
 }finally{await runtime.dispose();}
});
