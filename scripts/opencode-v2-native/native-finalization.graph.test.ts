import {expect,test} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {rewriteNativeFinalizationObservation} from '../native-finalization-observation-transform.mjs';
import {createNativeAssetFixturePlugin,writeNativeFixtureOutputs} from './native-asset-fixture.mjs';
import {prepareReviewedNativeInputs,reviewedNativeInputPlugin} from '../native-runtime-assets.mjs';
import {findNativeCoreSources,nativeCoreSourceFilter} from '../native-core-sources.mjs';
const repository=path.resolve(import.meta.dirname,'../..');
for(const compiled of [false,true])test(`actual native post-model mandatory IO success/error/cancellation ${compiled?'compiled':'source'} witness`,async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'devryan-finalization-')));
 let child:ReturnType<typeof Bun.spawn>|undefined,timer:ReturnType<typeof setTimeout>|undefined,failure:unknown;
 try{
  const finalizationSource=(await findNativeCoreSources(await fs.realpath(path.join(repository,'node_modules/@opencode/core')))).finalization;
  const observation:Bun.BunPlugin={name:'pinned-native-finalization',setup(builder){builder.onLoad({filter:nativeCoreSourceFilter(finalizationSource)},async event=>({
   contents:rewriteNativeFinalizationObservation(await fs.readFile(event.path,'utf8'),path.join(repository,'packages/web/server/lib/opencode/runtime-host/native-finalization-observation.ts')).contents,loader:'js'}));}};
  const executable=path.join(root,compiled?'witness-native':'witness.mjs');
  const built=await Bun.build({entrypoints:[path.join(repository,'scripts/opencode-v2-native/native-finalization.fixture.mjs')],target:'bun',
   ...compiled?{compile:{outfile:executable,autoloadDotenv:false,autoloadBunfig:false,autoloadTsconfig:false,autoloadPackageJson:false}}:{outdir:root,naming:{entry:'witness.mjs'}},
   plugins:[observation,await createNativeAssetFixturePlugin(repository),reviewedNativeInputPlugin(await prepareReviewedNativeInputs(repository))]});
  if(!built.success)throw new AggregateError(built.logs,'Native finalization fixture build failed');
  if(!compiled)await writeNativeFixtureOutputs(built.outputs);
  child=Bun.spawn(compiled?[executable]:[process.execPath,executable],{cwd:repository,env:{PATH:'/usr/bin:/bin',HOME:root,TMPDIR:root},stdout:'pipe',stderr:'pipe'});
  if(!child.stdout||typeof child.stdout==='number'||!child.stderr||typeof child.stderr==='number')throw Error('Owned pipes required');
  let timedOut=false;timer=setTimeout(()=>{timedOut=true;try{child?.kill('SIGKILL');}catch{}},30000);
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  clearTimeout(timer);if(timedOut)throw Error('Native finalization child exceeded its bounded 30-second lifetime');
  expect({code,stderr}).toEqual({code:0,stderr:''});const result=JSON.parse(stdout);expect(result.status).toBe('passed');expect(result.results).toHaveLength(3);
 }catch(error){failure=error;throw error;}finally{
  clearTimeout(timer);let cleanupTimer:ReturnType<typeof setTimeout>|undefined;
  try{if(child&&child.exitCode===null){child.kill('SIGKILL');await Promise.race([child.exited,new Promise<never>((_resolve,reject)=>{cleanupTimer=setTimeout(()=>reject(Error('Owned finalization child failed to settle after SIGKILL')),5000);})]);}}
  catch(error){throw failure?new AggregateError([failure,error],'Finalization fixture and child cleanup failed',{cause:failure}):error;}
  finally{clearTimeout(cleanupTimer);await fs.rm(root,{recursive:true,force:true});}
 }
},120000);
