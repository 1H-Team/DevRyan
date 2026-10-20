import {expect,test} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {prepareReviewedNativeInputs,reviewedNativeInputPlugin} from '../native-runtime-assets.mjs';
import {createNativeAssetFixturePlugin,writeNativeFixtureOutputs} from './native-asset-fixture.mjs';
const repository=path.resolve(import.meta.dirname,'../..');
// Child logs and results land in the test's own temp root (removed afterwards) unless DEVRYAN_KEEP_ARTIFACTS=1.
const keptDiagnostics=(root:string)=>process.env.DEVRYAN_KEEP_ARTIFACTS==='1'?path.join(repository,'.cache/v2-validation'):root;
const archiveEntry=Bun.resolveSync('adm-zip',path.join(repository,'packages/shared-runtime/lib'));

/** Regression: helper text (titles, commit/PR drafts, notification summaries)
 * resolved its model through a bare ModelResolver read, outside the permit-bound
 * credential resolution scope. Every owned-credential provider then refused the
 * request and the controller answered 503. This drives the actual controller
 * helper path through the real OpenAI credential owners and physical transport. */
test('native helper text resolves owned provider credentials through the permit-bound session model scope',async()=>{
 const root=await fs.mkdtemp(path.join(repository,'.cache/v2-validation/native-helper-credentials-'));
 let child:ReturnType<typeof Bun.spawn>|undefined;
 try{
  const sourcePath=path.join(repository,'scripts/opencode-v2-native/controller-integrations.graph-fixture.mjs');
  let source=await fs.readFile(sourcePath,'utf8');
  const replace=(before:string,after:string)=>{if(source.split(before).length!==2)throw Error('Original graph fixture changed: '+before);source=source.replace(before,after);};
  source="import {createControllerWebfetch} from "+JSON.stringify(path.join(repository,'packages/web/server/lib/opencode/runtime-host/controller-webfetch.ts'))+";\n"+source;
  replace("agents: { build: { mode: 'primary', model: 'openai/gpt-5.5' },",
   "agents: { build: { mode: 'primary', model: 'openai/gpt-5.5' }, 'devryan-title': { mode: 'subagent', hidden: true, system: 'Return only a short title.', permissions: [{ action: '*', resource: '*', effect: 'deny' }] },");
  replace('const scope = Effect.runSync(Scope.make()); let server;',`const helperWebfetch=createControllerWebfetch({tmpDirectory:await fs.realpath(globals.tmp),
  originals:{createReviewedWebfetchCache:()=>{throw Error('Unexpected webfetch cache');},saveReviewedWebfetchBinary:async()=>{throw Error('Unexpected webfetch binary');}},
  withSecondary:()=>Effect.die(Error('Unexpected webfetch secondary'))});
const scope = Effect.runSync(Scope.make()); let server;`);
  replace('...factory.overrides,...compatibility.overrides,','...helperWebfetch.overrides,...factory.overrides,...compatibility.overrides,');
  replace("assert.equal(receipts.length,generateBefore+1);assert.ok(kinds.has('generate'));",`assert.equal(receipts.length,generateBefore+1);assert.ok(kinds.has('generate'));
  const helperBefore=receipts.length,helperPermit=await admissionOwner.handleRpc('native.admission.authorize',{operation:'execution.resume',sessionID:session.id});ownedTokens.add(helperPermit.token);
  try{
   const helper=await helperWebfetch.generateHelper({directory:directories[0],agent:'devryan-title',providerID:'openai',modelID:'gpt-5.5',prompt:'Owned native helper title',maxOutputTokens:64},
    helperPermit,AbortSignal.timeout(20_000),async()=>{});
   assert.equal(helper.text,'Owned native integration completion');
  }finally{await admissionOwner.handleRpc('native.admission.release',helperPermit);}
  assert.equal(receipts.length,helperBefore+1,'Helper must reach the physical provider exactly once');
  const helperReceipt=receipts.at(-1),helperCredential=await factory.readSelectedOwned({directory:directories[0]});
  assert.equal(helperReceipt.kind,'generate');assert.equal(helperReceipt.authorization,'Bearer '+helperCredential.value.access);
  result={helperCredentialScope:true};
  // HELPER_CASE_END`);
  // The helper case ends this fixture's main. The fixture's own location-map
  // capture would replace the controller helper's LocationActivity override.
  const caseEnd=source.indexOf('  // HELPER_CASE_END'),mainEnd=source.indexOf('} catch (error) { primaryFailure = error;');
  if(caseEnd<0||mainEnd<caseEnd)throw Error('Original graph main changed');
  source=source.slice(0,caseEnd)+source.slice(mainEnd);
  replace(`    LocationActivity.node.replace(LocationActivity.node.mapLayer(original => Layer.effect(LocationActivity.Service, Effect.gen(function* () {
      const value = yield* LocationActivity.Service; map = yield* LocationServiceMap.Service; return value;
    })).pipe(Layer.provide(original))))] }).pipe(`,'] }).pipe(');
  source=source.replace(/from (['"])(\.\.\/\.\.\/[^'"]+)\1/g,(_all,_quote,relative:string)=>'from '+JSON.stringify(path.resolve(path.dirname(sourcePath),relative)));
  source=source.replace(/new URL\((['"])(\.\.\/\.\.\/[^'"]+)\1,import\.meta\.url\)/g,(_all,_quote,relative:string)=>'new URL('+JSON.stringify('file://'+path.resolve(path.dirname(sourcePath),relative))+')');
  const entry=path.join(root,'fixture.mjs');await fs.writeFile(entry,source);
  const built=await Bun.build({entrypoints:[entry],target:'bun',outdir:root,naming:{entry:'helper.mjs',asset:'[name]-[hash].[ext]'},plugins:[
   {name:'owned-workspace-archive-entry',setup(builder){builder.onResolve({filter:/^adm-zip$/},()=>({path:archiveEntry}));}},
   await createNativeAssetFixturePlugin(repository),reviewedNativeInputPlugin(await prepareReviewedNativeInputs(repository))]});
  if(!built.success)throw new AggregateError(built.logs,'Actual helper credential graph build failed');await writeNativeFixtureOutputs(built.outputs);
  const home=path.join(root,'home'),tmp=path.join(home,'tmp');await fs.mkdir(tmp,{recursive:true});await fs.writeFile(path.join(tmp,'package.json'),'{"type":"commonjs"}\n');
  child=Bun.spawn([process.execPath,path.join(root,'helper.mjs')],{cwd:repository,env:{PATH:'/usr/bin:/bin',HOME:home,TMPDIR:tmp,XDG_CONFIG_HOME:path.join(home,'config'),XDG_DATA_HOME:path.join(home,'data'),XDG_STATE_HOME:path.join(home,'state'),XDG_CACHE_HOME:path.join(home,'cache'),GIT_CEILING_DIRECTORIES:root,DEVRYAN_INTEGRATION_FIXTURE_ROOT:root},stdout:'pipe',stderr:'pipe'});
  if(!child.stdout||typeof child.stdout==='number'||!child.stderr||typeof child.stderr==='number')throw Error('Owned pipes required');
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  await fs.writeFile(path.join(keptDiagnostics(root),'native-helper-credentials-child.log'),stderr);
  if(code!==0){for(const name of ['rpc-errors.jsonl','reported-causes.jsonl','native-causes.jsonl','hooks.jsonl']){const bytes=await fs.readFile(path.join(root,name)).catch(()=>Buffer.alloc(0));await fs.writeFile(path.join(keptDiagnostics(root),'native-helper-credentials-'+name),bytes);}}
  expect({code,stderr}).toEqual({code:0,stderr:''});
  expect(JSON.parse(stdout).helperCredentialScope).toBe(true);
 }finally{if(child&&child.exitCode===null){child.kill();await child.exited;}await fs.rm(root,{recursive:true,force:true});}
},120_000);
