import {expect,test} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Database} from 'bun:sqlite';
import {prepareReviewedNativeInputs,reviewedNativeInputPlugin} from '../native-runtime-assets.mjs';
import {createNativeAssetFixturePlugin,writeNativeFixtureOutputs} from './native-asset-fixture.mjs';

const repository=path.resolve(import.meta.dirname,'../..');
test('cold controller catalogs resolve original projects before the host closure is ready',async()=>{
 const root=await fs.mkdtemp(path.join(repository,'.cache/v2-validation/controller-cold-'));
 let child:ReturnType<typeof Bun.spawn>|undefined;
 try{
  const host=path.join(repository,'packages/web/server/lib/opencode/runtime-host'),entry=path.join(root,'fixture.ts');
  await fs.writeFile(entry,`
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Effect} from 'effect';
import {isReviewedControllerGitArgs} from ${JSON.stringify(path.join(host,'../execution-helper-policy.js'))};
const root=process.env.DEVRYAN_CATALOG_ROOT;
const directories=[path.join(root,'one'),path.join(root,'two')];
const globals=Object.fromEntries(['home','data','config','state','cache','tmp','bin','log','repos'].map(name=>[name,path.join(root,'isolated',name)]));
await Promise.all([...directories,...Object.values(globals)].map(directory=>fs.mkdir(directory,{recursive:true})));
const gitEnvironment={PATH:process.env.PATH,HOME:globals.home,GIT_CONFIG_GLOBAL:path.join(root,'git-config'),GIT_CONFIG_NOSYSTEM:'1',GIT_CEILING_DIRECTORIES:root,GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'};
await fs.writeFile(gitEnvironment.GIT_CONFIG_GLOBAL,'');
for(const directory of directories){
 const initialized=Bun.spawn(['git','init','--quiet',directory],{env:gitEnvironment,stdout:'pipe',stderr:'pipe'});assert.equal(await initialized.exited,0);
 await fs.writeFile(path.join(directory,'seed.txt'),path.basename(directory));
 for(const args of [['add','seed.txt'],['commit','--quiet','-m','Owned fixture seed']]){
  const seeded=Bun.spawn(['git',...args],{cwd:directory,env:gitEnvironment,stdout:'pipe',stderr:'pipe'});assert.equal(await seeded.exited,0);
 }
}
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
import {startNativeController} from ${JSON.stringify(path.join(host,'controller-startup.ts'))};
import {translateNativeConfiguration} from ${JSON.stringify(path.join(host,'native-configuration-data.js'))};
const legacy={model:'cursor-acp/composer-2.5',providers:{},plugin:[],formatter:false};
const agents={orchestrator:{mode:'primary',model:'cursor-acp/composer-2.5'},title:{disabled:true}};
const configuration=translateNativeConfiguration({legacy,agents});
const requirements={agents:['orchestrator'],tools:['read','write'],plugins:[],models:[]};
const snapshot={schema:1,revision:1,digest:'a'.repeat(64),registrationManifestDigest:'b'.repeat(64),locations:directories.map(directory=>({directory,configuration,skills:[],aliases:[],instructions:[],textReferences:[],requiredCatalogs:requirements,compatibility:{legacy,agents,commands:{},mcp:{},slim:{mergedConfig:{}}}}))};
const token='a'.repeat(43);let runtime;
try{
 globalThis.coldControllerHelper=controllerHelper;
 runtime=await startNativeController({instanceID:'isolated-cold-controller',buildId:'d'.repeat(64),globals,
  databasePath:path.join(globals.data,'native.db'),directory:directories[0],
  locations:directories.map(directory=>({directory,readRoots:[directory],protectedRoots:[]})),configuration,
  configurationSnapshot:snapshot,reviewedPlugins:[],catalogRequirements:requirements,httpToken:token,
  bridge:{url:'http://127.0.0.1:1',token:'offline-fixture'}},
  {coreDigest:'b'.repeat(64),hostDigest:'c'.repeat(64),reviewedPlugins:[],migration:'not-needed'});
 assert.equal(runtime.catalog.asserted,true);
 for(const directory of directories){
  const url=new URL(runtime.url+'/api/agent');
  const response=await nativeFetch(url,{headers:{authorization:'Bearer '+token,'x-opencode-directory':encodeURIComponent(directory)}});
  assert.equal(response.status,200);const body=await response.json();
  assert.equal(body.location.directory,directory);assert.ok(body.data.some(agent=>agent.id==='orchestrator'));
 }
 process.stdout.write(JSON.stringify({catalogAsserted:true,locations:directories.length}));
}finally{await runtime?.close();}
`);
  const helperFixture={name:'owned-read-only-git-discovery',setup(builder:Bun.PluginBuilder){
   builder.onLoad({filter:/\/controller-processes\.ts$/},async event=>{
    const source=await fs.readFile(event.path,'utf8'),start=source.indexOf('export function createControllerHelper('),end=source.indexOf('export function controllerProcessOverrides(');
    if(start<0||end<=start)throw Error('Original controller helper boundary missing');
    return {loader:'ts' as const,contents:source.slice(0,start)+'export const createControllerHelper=()=>globalThis.coldControllerHelper;\n'+source.slice(end)};
   });
  }};
  const built=await Bun.build({entrypoints:[entry],target:'bun',format:'esm',outdir:root,naming:{entry:'fixture.mjs',asset:'[name]-[hash].[ext]'},plugins:[helperFixture,reviewedNativeInputPlugin(await prepareReviewedNativeInputs(repository)),await createNativeAssetFixturePlugin(repository)]});
  if(!built.success)throw Error(built.logs.join('\n'));await writeNativeFixtureOutputs(built.outputs);
  child=Bun.spawn([process.execPath,path.join(root,'fixture.mjs')],{cwd:root,env:{PATH:'/usr/bin:/bin',HOME:path.join(root,'isolated/home'),TMPDIR:path.join(root,'isolated/tmp'),GIT_CEILING_DIRECTORIES:root,DEVRYAN_CATALOG_ROOT:root},stdout:'pipe',stderr:'pipe'});
  if(!child.stdout||typeof child.stdout==='number'||!child.stderr||typeof child.stderr==='number')throw Error('Owned fixture pipes required');
  const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  await fs.writeFile(path.join(repository,'.cache/v2-validation/controller-startup-cold-child.log'),stderr);
  expect({code,errors:stderr.split('\n').filter(line=>line&&!/^timestamp=.* level=INFO /.test(line))}).toEqual({code:0,errors:[]});
  expect(JSON.parse(stdout)).toEqual({catalogAsserted:true,locations:2});
  const db=new Database(path.join(root,'isolated/data/native.db'),{readonly:true});
  try{expect(db.query('SELECT COUNT(*) AS count FROM project').get()).toEqual({count:2});}finally{db.close();}
 }finally{if(child&&child.exitCode===null){child.kill();await child.exited;}await fs.rm(root,{recursive:true,force:true});}
},120_000);
