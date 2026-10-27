import {test,expect}from'bun:test';import fs from'node:fs/promises';import path from'node:path';
import {reviewedNativeInputPlugin,rewriteSealedNodeRequire}from'../native-runtime-assets.mjs';
const repo=await fs.realpath('.');
const plugin=()=>reviewedNativeInputPlugin({rewrites:new Map(),virtualModules:new Map(),inputFiles:new Map(),resolutions:new Map()});
test('reviewed resolver preserves actual Effect barrel/subpath identity and native State initialization',async()=>{
 const root=await fs.mkdtemp(path.join(repo,'.cache/v2-validation/asset-resolution-'));
 try{
  const entry=path.join(root,'entry.ts');const core=await fs.realpath(path.join(repo,'node_modules/@opencode/core'));
  await fs.writeFile(entry,`import {Context,Effect}from'effect';import * as Direct from'effect/Context';import {State}from${JSON.stringify(path.join(core,'dist/state.js'))};import {ShellParse}from'@opencode/core/shell/parse';console.log(JSON.stringify({same:Context===Direct,result:await Effect.runPromise(Effect.succeed('actual-effect')),create:typeof State.create,scan:typeof ShellParse.scan}));`);
  const build=await Bun.build({entrypoints:[entry],target:'bun',minify:true,plugins:[plugin()],write:false});expect(build.success).toBe(true);
  const file=path.join(root,'compiled.js');await fs.writeFile(file,await build.outputs[0].text());const globals=path.join(root,'global');await fs.mkdir(globals);
  const child=Bun.spawn([process.execPath,file],{cwd:root,env:{PATH:'/usr/bin:/bin',HOME:globals,XDG_CONFIG_HOME:globals,XDG_DATA_HOME:globals,XDG_STATE_HOME:globals,XDG_CACHE_HOME:globals,TMPDIR:globals},stdout:'pipe',stderr:'pipe'});
  const [out,err,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);expect(exit).toBe(0);expect(err).toBe('');expect(JSON.parse(out)).toEqual({same:true,result:'actual-effect',create:'function',scan:'function'});
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('captured importer cannot fall back to an unreviewed dependency',async()=>{
 const root=await fs.mkdtemp(path.join(repo,'.cache/v2-validation/asset-resolution-'));
 try{
  const directory=path.join(root,'reviewed-inputs/imagegen-0.1.12');await fs.mkdir(directory,{recursive:true});const entry=path.join(directory,'entry.ts');await fs.writeFile(entry,"import {Context}from'effect';console.log(Context);");
  let failure;try{await Bun.build({entrypoints:[entry],target:'bun',plugins:[plugin()],write:false});}catch(error){failure=error;}expect(failure).toBeInstanceOf(AggregateError);expect(failure.errors.some(error=>String(error.message??error).includes('Reviewed DOM dependency outside captured closure'))).toBe(true);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('sealed data-url shim permits stdlib only and rejects generated pattern drift',async()=>{
 const source='import {createRequire as load}from"node:module";var require=load(import.meta.url);export const value=require("node:path").sep;export const denied=()=>require("not-reviewed");export const deniedResolve=()=>require.resolve("./outside.js");';
 const rewritten=rewriteSealedNodeRequire(source);const url='data:text/javascript;base64,'+Buffer.from(rewritten).toString('base64');
 const script=`const api=await import(${JSON.stringify(url)});if(api.value!=="/")throw new Error("builtin_missing");for(const name of ["denied","deniedResolve"]){let rejected=false;try{api[name]()}catch(error){rejected=error.message==="native_configuration_external_require_denied"}if(!rejected)throw new Error("external_require_allowed");}console.log("verified");`;
 const child=Bun.spawn(['node','--input-type=module','-e',script],{stdout:'pipe',stderr:'pipe'});const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect({code,out,err}).toEqual({code:0,out:'verified\n',err:''});
 expect(()=>rewriteSealedNodeRequire(source.replace('var require=','const require='))).toThrow('Pinned Node require shim declaration changed');
 const originalLazy='process.getBuiltinModule("module").createRequire(import.meta.url)';expect(rewriteSealedNodeRequire(source+';export const lazy=()=>'+originalLazy)).toContain(originalLazy);
});

test('reviewed resolver bundles original pinned JSONC parsing, formatting and edits from its ESM graph',async()=>{
 const root=await fs.mkdtemp(path.join(repo,'.cache/v2-validation/asset-jsonc-'));
 try{
  const resolved=Bun.resolveSync('jsonc-parser',path.join(repo,'packages/web'));
  await fs.mkdir(path.join(root,'node_modules'));await fs.symlink(path.resolve(path.dirname(resolved),'../..'),path.join(root,'node_modules/jsonc-parser'),'dir');
  const entry=path.join(root,'entry.ts');
  await fs.writeFile(entry,`import {parse,format,modify,applyEdits}from'jsonc-parser';const text='{/* original comment */"a":1}';const edited=applyEdits(text,modify(text,['a'],2,{formattingOptions:{insertSpaces:true,tabSize:2}}));const formatted=applyEdits(edited,format(edited,undefined,{insertSpaces:true,tabSize:2}));console.log(JSON.stringify({parsed:parse(text),edited:parse(edited),formatted:parse(formatted),multiline:formatted.includes('\\n')}));`);
  const build=await Bun.build({entrypoints:[entry],target:'bun',minify:true,metafile:true,plugins:[plugin()],write:false});expect(build.success).toBe(true);
  const inputs=Object.keys(build.metafile.inputs);expect(inputs.some(input=>input.endsWith('/jsonc-parser/lib/esm/main.js'))).toBe(true);expect(inputs.some(input=>input.includes('/jsonc-parser/lib/umd/'))).toBe(false);
  const file=path.join(root,'compiled.js');await fs.writeFile(file,await build.outputs[0].text());
  const child=Bun.spawn([process.execPath,file],{cwd:root,env:{PATH:'/usr/bin:/bin',HOME:root},stdout:'pipe',stderr:'pipe'});
  const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);expect(code).toBe(0);expect(err).toBe('');expect(JSON.parse(out)).toEqual({parsed:{a:1},edited:{a:2},formatted:{a:2},multiline:true});
  const invalidDirectory=path.join(root,'invalid');const fake=path.join(invalidDirectory,'node_modules/jsonc-parser');await fs.mkdir(path.join(fake,'lib/umd'),{recursive:true});await fs.mkdir(path.join(fake,'lib/esm'));
  await fs.writeFile(path.join(fake,'package.json'),JSON.stringify({name:'jsonc-parser',version:'3.3.2',main:'./lib/umd/main.js',module:'./lib/esm/main.js'}));await fs.writeFile(path.join(fake,'lib/umd/main.js'),'exports.parse=()=>({});');await fs.writeFile(path.join(fake,'lib/esm/main.js'),'export const parse=()=>({});');
  const invalidEntry=path.join(invalidDirectory,'entry.ts');await fs.writeFile(invalidEntry,"import {parse}from'jsonc-parser';console.log(parse('{}'));");
  let failure;try{await Bun.build({entrypoints:[invalidEntry],target:'bun',plugins:[plugin()],write:false});}catch(error){failure=error;}
  expect(failure).toBeInstanceOf(AggregateError);expect(failure.errors.some(error=>String(error.message??error).includes('Pinned JSONC module resolution changed'))).toBe(true);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
