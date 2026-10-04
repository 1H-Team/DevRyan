import {test,expect}from'bun:test';
import fs from'node:fs/promises';import path from'node:path';
import {prepareReviewedNativeInputs,reviewedNativeInputPlugin,rewriteSealedNodeRequire}from'../native-runtime-assets.mjs';

test('compiled original DOM parses HTML with no ambient IO and refuses unapproved sync XHR before IO',async()=>{
 const repository=path.resolve(import.meta.dirname,'../..');
 const root=await fs.mkdtemp(path.join(repository,'.cache/v2-validation/compiled-dom-'));
 try{
  const reviewed=await prepareReviewedNativeInputs(repository);
  const entry=path.join(root,'entry.ts'),original=path.join(repository,'packages/web/runtime/reviewed-inputs/jsdom-30.1.1/node_modules/jsdom/lib/api.js');
  await fs.writeFile(entry,`export {JSDOM}from ${JSON.stringify(original)};`);
  const build=await Bun.build({entrypoints:[entry],target:'node',conditions:['node'],format:'esm',minify:true,plugins:[reviewedNativeInputPlugin(reviewed)]});
  expect(build.success).toBe(true);if(!build.success)throw new Error(build.logs.join('\n'));
  const output=path.join(root,'DevRyan-dom.mjs');await fs.writeFile(output,rewriteSealedNodeRequire(await build.outputs[0].text()));
  const child=Bun.spawn([process.execPath,'--input-type=module','-e',`
   import fs from'node:fs';import fsp from'node:fs/promises';import cp from'node:child_process';import wt from'node:worker_threads';import http from'node:http';import https from'node:https';import {syncBuiltinESMExports}from'node:module';
   let io=0;const refuse=()=>{io++;throw new Error('ambient_io_forbidden');};
   for(const name of ['readFileSync','openSync','readSync','writeFileSync','mkdirSync','readdirSync','statSync','lstatSync','realpathSync','existsSync'])fs[name]=refuse;
   for(const name of ['readFile','open','writeFile','mkdir','readdir','stat'])fsp[name]=refuse;
   for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync'])cp[name]=refuse;
   wt.Worker=class{constructor(){refuse();}};http.request=refuse;https.request=refuse;globalThis.fetch=refuse;syncBuiltinESMExports();
   let phase='import';try{const {JSDOM}=await import(${JSON.stringify(output)});
   phase='parse';const dom=new JSDOM('<!doctype html><p id="original">Original &amp; parser</p>',{url:'http://127.0.0.1/owned'});
   if(dom.window.document.querySelector('#original').textContent!=='Original & parser')throw new Error('original_dom_lost');
   if(io!==0)throw new Error('dom_ambient_io');
   phase='xhr';const request=new dom.window.XMLHttpRequest();request.open('GET','http://127.0.0.1/unapproved',false);
   let refused=false;try{request.send();}catch(error){refused=error.message==='native_configuration_external_require_denied';}
   if(!refused||io!==0)throw new Error('sync_xhr_not_closed_before_io');
   dom.window.close();console.log('verified');
   }catch(error){console.error(JSON.stringify({phase,name:error.name,message:error.message}));process.exitCode=1;}
  `],{cwd:root,stdout:'pipe',stderr:'pipe',env:{PATH:'/usr/bin:/bin',HOME:root,TMPDIR:root}});
  const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect({code,stdout,stderr}).toEqual({code:0,stdout:'verified\n',stderr:''});
  const transform=reviewed.transforms.find(row=>row.reason==='compiled-dom-sync-xhr-lazy-original-worker-resolver');expect(transform?.sha256).toBe('6fd6e204c59a0fe05fa93e48553efde0d9603f7df525d8432a3261fa77e7f6f7');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
