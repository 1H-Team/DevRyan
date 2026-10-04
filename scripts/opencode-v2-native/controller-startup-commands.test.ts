import {expect,test} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {prepareReviewedNativeInputs,reviewedNativeInputPlugin} from '../native-runtime-assets.mjs';
import {createNativeAssetFixturePlugin,writeNativeFixtureOutputs} from './native-asset-fixture.mjs';

const repository=path.resolve(import.meta.dirname,'../..');
test('production controller forwards actual reviewed Slim and Ponytail declarations to native command gates',async()=>{
 const root=await fs.mkdtemp(path.join(repository,'.cache/v2-validation/controller-commands-'));
 let child:ReturnType<typeof Bun.spawn>|undefined;
 try{
  const host=path.join(repository,'packages/web/server/lib/opencode/runtime-host');
  const entry=path.join(root,'fixture.ts');
  await fs.writeFile(entry,`
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const root=process.env.DEVRYAN_COMMAND_ROOT;
const globals=Object.fromEntries(['home','data','config','state','cache','tmp','bin','log','repos'].map(name=>[name,path.join(root,name)]));
await Promise.all(Object.values(globals).map(directory=>fs.mkdir(directory,{recursive:true})));
const directory=path.join(root,'project');await fs.mkdir(directory);
let captured;
globalThis.captureNativeHostOptions=options=>{captured=options;throw new Error('fixture_host_options_captured');};
let networkCalls=0;globalThis.fetch=async()=>{networkCalls++;throw new Error('fixture_network_forbidden');};
const {startNativeController}=await import(${JSON.stringify(path.join(host,'controller-startup.ts'))});
const {reviewedSlimCommandDeclarations}=await import(${JSON.stringify(path.join(host,'native-slim-commands.ts'))});
const originals=await import(${JSON.stringify(path.join(repository,'packages/web/runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js'))});
const {command:ponytail}=await import('devryan:reviewed-ponytail-instructions');
const ids=['devryan.slim','devryan.slim-commands','devryan.slim-lifecycle','devryan.ponytail'];
const origins=ids.map((id,index)=>({id,manifestDigest:String(index+1).repeat(64),capabilities:id==='devryan.slim'?['read','write','network','process']:['control']}));
const configuration={agents:{builder:{model:{providerID:'fixture',model:'m1'}}},default_agent:'builder',plugins:[],commands:{},warming:false};
const snapshot={schema:1,revision:1,digest:'a'.repeat(64),registrationManifestDigest:'b'.repeat(64),locations:[{
 directory,configuration,skills:[],aliases:[],instructions:[],textReferences:[],compatibility:{legacy:{},agents:{builder:{model:'fixture/m1'}},commands:{},mcp:{},slim:{mergedConfig:{autoUpdate:false,companion:{enabled:false},backgroundJobs:{orchestratorWake:{enabled:false}},agents:{builder:{model:'fixture/m1'}}}}}}
]};
const boot={instanceID:'01234567-89ab-cdef-0123-456789abcdef',buildId:'c'.repeat(64),directory,locations:[{directory,readRoots:[directory],protectedRoots:[]}],globals,
 databasePath:path.join(globals.data,'native.db'),bridge:{url:'http://127.0.0.1:1',token:'fixture'},httpToken:'d'.repeat(43),
 configuration,configurationSnapshot:snapshot,reviewedPlugins:origins,catalogRequirements:{agents:['builder'],plugins:ids,tools:[],models:[]}};
try{await startNativeController(boot,{coreDigest:'e'.repeat(64),hostDigest:'f'.repeat(64),reviewedPlugins:origins,migration:'not-needed'});throw new Error('fixture_capture_missing');}
catch(error){assert.equal(error.message,'fixture_host_options_captured');}
assert.ok(captured);
const declarations={...reviewedSlimCommandDeclarations({deepwork:originals.createDeepworkCommandHook,loop:originals.createLoopCommandHook,reflect:originals.createReflectCommandHook}),interview:originals.reviewedSlimInterviewCommandDeclaration};
const expected=Object.entries(declarations).map(([name,definition])=>({origin:{kind:'plugin',...origins[1]},name,definition}));
expected.push({origin:{kind:'plugin',...origins[3]},name:'ponytail',definition:ponytail});
assert.deepEqual(captured.reviewedBehaviorCommands,expected);
assert.deepEqual(captured.reviewedBehaviorCommands.map(row=>row.name).sort(),['deepwork','interview','loop','ponytail','reflect']);
for(const row of captured.reviewedBehaviorCommands)assert.ok(captured.plugins.some(plugin=>JSON.stringify(plugin.origin)===JSON.stringify(row.origin)));
assert.equal(networkCalls,0);
process.stdout.write('verified');
`);
  const reviewed=await prepareReviewedNativeInputs(repository);
  const capture={name:'capture-production-host-constructor',setup(builder:import('bun').PluginBuilder){
   builder.onLoad({filter:/\/runtime-host\/bootstrap\.ts$/},event=>{
    if(path.resolve(event.path)!==path.join(host,'bootstrap.ts'))throw new Error('Unexpected host constructor');
    return {loader:'ts' as const,contents:'export async function createNativeRuntimeHost(options){return globalThis.captureNativeHostOptions(options);}'};
   });
  }};
  const built=await Bun.build({entrypoints:[entry],target:'bun',format:'esm',outdir:root,naming:{entry:'fixture.mjs',asset:'[name]-[hash].[ext]'},
   plugins:[capture,reviewedNativeInputPlugin(reviewed),await createNativeAssetFixturePlugin(repository)]});
  if(!built.success)throw new Error(built.logs.join('\n'));
  await writeNativeFixtureOutputs(built.outputs);
  child=Bun.spawn([process.execPath,path.join(root,'fixture.mjs')],{cwd:root,env:{PATH:process.env.PATH,HOME:path.join(root,'home'),TMPDIR:path.join(root,'tmp'),
   OPENCODE_CONFIG_DIR:path.join(root,'config'),XDG_CONFIG_HOME:path.join(root,'config'),GIT_CEILING_DIRECTORIES:root,DEVRYAN_COMMAND_ROOT:root},stdout:'pipe',stderr:'pipe'});
  if(!child.stdout||typeof child.stdout==='number'||!child.stderr||typeof child.stderr==='number')throw new Error('Owned fixture pipes required');
  const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect({code,stderr:stderr.split('\n').map(line=>line.length>400?'[long source line omitted]':line).join('\n')}).toEqual({code:0,stderr:''});
  expect(stdout).toBe('verified');
 }finally{
  if(child&&child.exitCode===null){child.kill();await child.exited;}
  await fs.rm(root,{recursive:true,force:true});
 }
},120_000);
