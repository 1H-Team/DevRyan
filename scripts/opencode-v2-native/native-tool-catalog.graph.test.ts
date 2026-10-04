import {expect,test} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {prepareReviewedNativeInputs,reviewedNativeInputPlugin} from '../native-runtime-assets.mjs';
import {createNativeAssetFixturePlugin,writeNativeFixtureOutputs} from './native-asset-fixture.mjs';
import {Schema} from 'effect';
import {readNativeToolCatalog} from './native-tool-catalog-client-fixture.mjs';

const repository=path.resolve(import.meta.dirname,'../..');
const ToolCatalog=Schema.Struct({ids:Schema.Array(Schema.String),definitions:Schema.NullOr(Schema.Array(Schema.Struct({id:Schema.String,description:Schema.String,parameters:Schema.Unknown})))});
test('authenticated host tool route exposes exact sealed two-location native catalogs and schemas',async()=>{
 const root=await fs.mkdtemp(path.join(repository,'.cache/v2-validation/tool-catalog-'));
 let child:ReturnType<typeof Bun.spawn>|undefined;
 try{
  const entry=path.join(root,'fixture.ts'),host=path.join(repository,'packages/web/server/lib/opencode/runtime-host');
  await fs.writeFile(entry,`
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Effect,Schema} from 'effect';
import {createNativeRuntimeHost} from ${JSON.stringify(path.join(host,'bootstrap.ts'))};
import {createReviewedNativePluginRegistry} from ${JSON.stringify(path.join(host,'native-plugin-registry.ts'))};
import {isReviewedControllerGitArgs} from ${JSON.stringify(path.join(host,'../execution-helper-policy.js'))};
const root=process.env.DEVRYAN_CATALOG_ROOT;
const directories=[path.join(root,'one'),path.join(root,'two')];
const globals=Object.fromEntries(['home','data','config','state','cache','tmp','bin','log','repos'].map(name=>[name,path.join(root,'isolated',name)]));
await Promise.all([...directories,...Object.values(globals)].map(directory=>fs.mkdir(directory,{recursive:true})));
const gitEnvironment={PATH:process.env.PATH,HOME:globals.home,GIT_CONFIG_GLOBAL:path.join(root,'git-config'),GIT_CONFIG_NOSYSTEM:'1',GIT_CEILING_DIRECTORIES:root};
await fs.writeFile(gitEnvironment.GIT_CONFIG_GLOBAL,'');
for(const directory of directories){const initialized=Bun.spawn(['git','init','--quiet',directory],{env:gitEnvironment,stdout:'pipe',stderr:'pipe'});assert.equal(await initialized.exited,0);}
// Only reviewed read-only discovery is exercised here; this fixture does not qualify helper confinement.
const controllerHelper=(command,options)=>Effect.promise(async signal=>{
 assert.equal(command._tag,'StandardCommand');assert.equal(path.basename(command.command),'git');assert.ok(isReviewedControllerGitArgs(command.args));assert.ok(directories.includes(command.options.cwd));
 const child=Bun.spawn([command.command,...command.args],{cwd:command.options.cwd,env:gitEnvironment,stdout:'pipe',stderr:'pipe'});
 const abort=()=>child.kill();signal.addEventListener('abort',abort,{once:true});
 try{const [exitCode,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).arrayBuffer(),new Response(child.stderr).arrayBuffer()]);return {command:command.command,exitCode,stdout:Buffer.from(stdout),stderr:Buffer.from(stderr),stdoutTruncated:false,stderrTruncated:false,...options?.combineOutput?{output:Buffer.concat([Buffer.from(stdout),Buffer.from(stderr)]),outputTruncated:false}:{}};}finally{signal.removeEventListener('abort',abort);}
});
const nativeFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{
 const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
 assert.ok(['127.0.0.1','localhost'].includes(url.hostname),'Unexpected external fixture request');return nativeFetch(input,init);
};
let effects=0;
const origin={kind:'plugin',id:'fixture.sealed-catalog',manifestDigest:'a'.repeat(64),capabilities:['read']};
const plugin={id:origin.id,effect:context=>context.tool.transform(editor=>{
 editor.namespace({name:'sealed',description:'Owned fixture namespace'});
 editor.add({name:context.location.directory===directories[0]?'location_one':'location_two',description:'Exact native fixture schema',
  input:Schema.Struct({value:Schema.String}),options:{namespace:'sealed',codemode:false},execute:()=>Effect.sync(()=>{effects++;return {content:'unexpected'};})});
 editor.add({name:'subagent',description:'Unsupported',input:Schema.Struct({}),execute:()=>Effect.succeed({content:''})});
})};
const bridge={awaitReady:async()=>{},authorize:async()=>{throw new Error('No tool execution admitted');},recheck:async()=>{},release:async()=>{},
 sealPrompt:async()=>({}),verifyAccepted:async()=>{},registerShellJob:async()=>{},sealSynthetic:async()=>({}),deferContinuation:async()=>{},hold:async()=>{},releaseHold:async()=>{},isHeld:async()=>false};
const token='a'.repeat(43);let runtime;
try{
 runtime=await createNativeRuntimeHost({databasePath:path.join(globals.data,'native.db'),token,globals,bridge,
  controllerHelper,nativePlugins:createReviewedNativePluginRegistry('b'.repeat(64),{hostDigest:'c'.repeat(64)}),plugins:[{plugin,origin}],executionOverrides:[],drainExecutions:async()=>{},
  executeOwned:()=>Effect.die('Catalog must never execute a tool'),
  configuration:{agents:{build:{model:{providerID:'fixture',model:'m1'}}},providers:{fixture:{name:'Owned catalog fixture',package:'aisdk:@ai-sdk/openai-compatible',settings:{apiKey:'fixture',baseURL:'http://127.0.0.1:1'},models:{m1:{name:'Owned',limit:{context:200000,output:32000}}}}}},
  readiness:{hostVersion:'fixture',buildId:'d'.repeat(64),migration:'not-needed',directories,requirements:{agents:['build'],tools:['read'],plugins:[],models:[{providerID:'fixture',id:'m1'}]}}});
 assert.equal(runtime.catalog.asserted,true);await runtime.openStartup();
 const read=(route,directory,authorization='Bearer '+token,method='GET')=>{const url=new URL(runtime.url+route);if(directory!==undefined)url.searchParams.set('directory',directory);return nativeFetch(url,{method,headers:{authorization}});};
 assert.equal((await read('/devryan/tools',directories[0],'Bearer wrong')).status,401);
 assert.equal((await read('/devryan/tools',directories[0],undefined,'POST')).status,405);
 assert.equal((await read('/devryan/tools',undefined)).status,400);
 assert.equal((await read('/devryan/tools','relative')).status,400);
 assert.equal((await read('/devryan/tools',path.join(root,'unreviewed'))).status,403);
 const malformed=await nativeFetch(runtime.url+'/devryan/tools?directory=%zz',{headers:{authorization:'Bearer '+token}});assert.equal(malformed.status,400);
 for(const suffix of ['?providerID=fixture','?modelID=m1','?providerID=&modelID=m1','?providerID=fixture&modelID=m1&unknown=x','?providerID=fixture&providerID=fixture&modelID=m1'])
  assert.equal((await read('/devryan/tools'+suffix,directories[0])).status,400);
 assert.equal((await read('/devryan/tools?providerID=fixture&modelID=missing',directories[0])).status,404);
 assert.equal((await read('/devryan/tools?providerID=missing&modelID=m1',directories[0])).status,404);
 for(const [index,directory] of directories.entries()){
  const response=await read('/devryan/tools',directory);assert.equal(response.status,200);const ids=await response.json();
  assert.equal(ids.definitions,null);assert.ok(ids.ids.includes('sealed_location_'+(index===0?'one':'two')));
  assert.ok(!ids.ids.includes('sealed_location_'+(index===0?'two':'one')));assert.ok(!ids.ids.includes('execute')&&!ids.ids.includes('subagent'));
  const responseWithModel=await read('/devryan/tools?providerID=fixture&modelID=m1',directory);assert.equal(responseWithModel.status,200);const catalog=await responseWithModel.json();
  assert.deepEqual(catalog.ids,ids.ids);assert.deepEqual(catalog.definitions.map(row=>row.id).sort(),[...ids.ids].sort());
  const exact=catalog.definitions.find(row=>row.id==='sealed_location_'+(index===0?'one':'two'));
  assert.equal(exact.description,'Exact native fixture schema');assert.equal(exact.parameters.type,'object');assert.equal(exact.parameters.properties.value.type,'string');
 }
 assert.equal(effects,0);
 const readyPath=path.join(root,'ready.json');
 await fs.writeFile(readyPath+'.tmp',JSON.stringify({url:runtime.url}),{flag:'wx',mode:0o600});
 await fs.rename(readyPath+'.tmp',readyPath);
 for await(const _ of process.stdin){}
 process.stdout.write(JSON.stringify({locations:directories.length,toolsExecuted:effects}));
}finally{await runtime?.close();}
`);
  const reviewed=await prepareReviewedNativeInputs(repository);
  const built=await Bun.build({entrypoints:[entry],target:'bun',format:'esm',outdir:root,naming:{entry:'fixture.mjs',asset:'[name]-[hash].[ext]'},plugins:[reviewedNativeInputPlugin(reviewed),await createNativeAssetFixturePlugin(repository)]});
  if(!built.success)throw new Error(built.logs.join('\n'));await writeNativeFixtureOutputs(built.outputs);
  child=Bun.spawn([process.execPath,path.join(root,'fixture.mjs')],{cwd:root,env:{PATH:process.env.PATH,HOME:path.join(root,'isolated/home'),TMPDIR:path.join(root,'isolated/tmp'),GIT_CEILING_DIRECTORIES:root,DEVRYAN_CATALOG_ROOT:root},stdin:'pipe',stdout:'pipe',stderr:'pipe'});
  if(!child.stdout||typeof child.stdout==='number'||!child.stderr||typeof child.stderr==='number')throw new Error('Owned fixture pipes required');
  const stdoutPromise=new Response(child.stdout).text(),stderrPromise=new Response(child.stderr).text();
  let ready:{url:string}|undefined;const deadline=Date.now()+30_000;
  while(!ready&&child.exitCode===null&&Date.now()<deadline){
   try{ready=JSON.parse(await fs.readFile(path.join(root,'ready.json'),'utf8'));}catch(error){if(!error||typeof error!=='object'||!('code' in error)||error.code!=='ENOENT')throw error;}
   if(!ready)await new Promise(resolve=>setTimeout(resolve,10));
  }
  if(ready){
   const url=ready.url;
   for(const location of ['one','two']){
    const directory=path.join(root,location),ids=Schema.decodeUnknownSync(ToolCatalog)(await readNativeToolCatalog(url,directory));
    expect(ids?.definitions).toBeNull();expect(ids?.ids).toContain('sealed_location_'+location);
    const defined=Schema.decodeUnknownSync(ToolCatalog)(await readNativeToolCatalog(url,directory,{providerID:'fixture',modelID:'m1'}));
    expect(defined?.definitions?.find(row=>row.id==='sealed_location_'+location)).toMatchObject({description:'Exact native fixture schema',parameters:{type:'object',properties:{value:{type:'string'}}}});
    expect(defined?.ids).not.toContain('execute');expect(defined?.ids).not.toContain('subagent');
   }
   if(typeof child.stdin==='number'||!child.stdin)throw new Error('Owned fixture stdin required');child.stdin.end();
  }else if(child.exitCode===null){child.kill();}
  const [code,stdout,stderr]=await Promise.all([child.exited,stdoutPromise,stderrPromise]);
  await fs.writeFile(path.join(repository,'.cache/v2-validation/resume-native-tool-catalog-child.log'),stderr);
  expect({code,errors:stderr.split('\n').filter(line=>line&&!/^timestamp=.* level=INFO /.test(line))}).toEqual({code:0,errors:[]});expect(JSON.parse(stdout)).toEqual({locations:2,toolsExecuted:0});
 }finally{if(child&&child.exitCode===null){child.kill();await child.exited;}await fs.rm(root,{recursive:true,force:true});}
},120_000);
