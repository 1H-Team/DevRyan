import {test,expect} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {prepareReviewedNativeInputs,reviewedNativeInputPlugin} from '../native-runtime-assets.mjs';
const repository=path.resolve(import.meta.dirname,'../..');
const parent=path.join(repository,'.cache/v2-validation');await fs.mkdir(parent,{recursive:true});
const root=await fs.mkdtemp(path.join(parent,'slim-fetch-'));
const entry=path.join(root,'entry.ts'),output=path.join(root,'bundle.mjs');
await fs.writeFile(entry,`export * from ${JSON.stringify(path.join(repository,'packages/web/server/lib/opencode/runtime-host/native-slim-webfetch.ts'))};
export * from ${JSON.stringify(path.join(repository,'packages/web/runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js'))};
export * from ${JSON.stringify(path.join(repository,'packages/web/server/lib/opencode/runtime-host/native-slim-dom.ts'))};`);
const built=await Bun.build({entrypoints:[entry],target:'bun',plugins:[reviewedNativeInputPlugin(await prepareReviewedNativeInputs(repository))]});
if(!built.success)throw new AggregateError(built.logs,'Reviewed webfetch build failed');
await fs.writeFile(output,await built.outputs[0].text());
const original=await import(output);
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
 const url=new URL(request.url);
 if(url.pathname==='/redirect')return new Response(null,{status:302,headers:{location:'/text'}});
 if(url.pathname==='/foreign')return new Response(null,{status:302,headers:{location:'http://localhost:1234/secret'}});
 if(url.pathname==='/loop')return new Response(null,{status:302,headers:{location:'/loop'}});
 if(url.pathname==='/llms-full.txt')return new Response('# Exact llms content\n\nOwned documentation fixture',{headers:{'content-type':'text/plain'}});
 if(url.pathname==='/binary')return new Response(new Uint8Array([0,1,2,255]),{headers:{'content-type':'image/png','content-disposition':'attachment; filename="fixture.png"'}});
 if(url.pathname==='/large')return new Response('X'.repeat(10*1024*1024+128),{headers:{'content-type':'text/plain'}});
 if(url.pathname==='/html')return new Response('<!doctype html><html><body>fixture</body></html>',{headers:{'content-type':'text/html'}});
 if(url.pathname==='/slow'){
  await new Promise(resolve=>setTimeout(resolve,80));return new Response('late',{headers:{'content-type':'text/plain'}});
 }
 return new Response('Owned '+Array.from({length:40},(_,i)=>`word${i}`).join(' '),{headers:{'content-type':'text/plain'}});
}});
const url=name=>`http://fixture.invalid:${server.port}/${name}`;
let serial=0;
async function fixture({configuration={},deny=false,secondary,loadJSDOM,fetcher,smallModelRef}={}){
 const binaryDirectory=path.join(root,'files'+serial++);await fs.mkdir(binaryDirectory);
 const cache=original.createReviewedWebfetchCache();let valid=true;const requests=[],asks=[],saves=[],metadata=[];
 const context={sessionID:'ses_owned',abort:new AbortController().signal,ask:async request=>{asks.push(request);if(deny)throw new Error('permission_denied');},metadata:request=>metadata.push(request)};
 const owners={cache,assertCurrent:async()=>{if(!valid)throw new Error('grant_revoked');},
  fetch:async(value,init)=>{requests.push(value);if(value.startsWith('https:'))throw new Error('fixture_has_no_tls');const local=new URL(value);local.hostname="127.0.0.1";return fetcher?fetcher(local.toString(),init):fetch(local,init);},
  loadJSDOM:loadJSDOM??(async()=>{throw new Error('approved_jsdom_unavailable');}),
  secondary:secondary??(async()=>{throw new Error('secondary_unavailable');}),
  saveBinary:async input=>{await input.recheck();saves.push(input);return original.saveReviewedWebfetchBinary(input.directory,input.data,input.contentType,input.filename);}};
 const tool=original.createOwnedSlimWebfetch({originals:original,configuration,binaryDirectory,smallModelRef,ownersFor:async()=>owners});
 return {tool,context,requests,asks,saves,metadata,binaryDirectory,revoke:()=>{valid=false;}};
}

test('actual original webfetch preserves schema/defaults, local redirects, llms, metadata and bounded bodies',async()=>{
 const f=await fixture();
 const content=await f.tool.execute({url:url('redirect'),prefer_llms_txt:'never'},f.context);
 expect(content).toContain('word39');expect(content).toContain('redirect_chain:');
 expect(f.requests).toContain(url('text'));expect(f.asks.some(request=>request.patterns.includes(url('text')))).toBe(true);
 const count=f.requests.length;const replay=await f.tool.execute({url:url('redirect'),prefer_llms_txt:'never'},f.context);
 expect(replay).toContain('cache_hit: true');expect(f.requests.length).toBe(count);expect(f.asks.length).toBeGreaterThan(2);
 const llms=await f.tool.execute({url:url('docs'),prefer_llms_txt:'always'},f.context);
 expect(llms).toContain('Exact llms content');expect(llms).toContain('used_llms_txt: true');
 const blocked=await f.tool.execute({url:url('foreign'),prefer_llms_txt:'never'},f.context);
 expect(blocked).toContain('localhost:1234');expect(f.requests.some(value=>value.includes('localhost:1234'))).toBe(false);
 await expect(f.tool.execute({url:url('loop'),prefer_llms_txt:'never'},f.context)).rejects.toThrow('Too many redirects');
 const bounded=await f.tool.execute({url:url('large'),format:'text',prefer_llms_txt:'never',include_metadata:false},f.context);
 expect(bounded).toContain('[..content truncated..]');expect(bounded.length).toBeLessThan(10*1024*1024+100);
 await expect(f.tool.execute({url:url('text'),timeout:121},f.context)).rejects.toThrow();
 await expect(f.tool.execute({url:url('text'),forged:true},f.context)).rejects.toThrow('native_webfetch_input_invalid');
});

test('original binary allocator, secondary selection/prompt and cancellation remain owner scoped',async()=>{
 const calls=[];const f=await fixture({configuration:{webfetchModels:[{id:'owned/model',variant:'high'}]},secondary:async request=>{calls.push(request);return 'Exact secondary answer';}});
 const binary=await f.tool.execute({url:url('binary'),save_binary:true,prefer_llms_txt:'never'},f.context);
 expect(binary).toContain('fixture.png');expect(await fs.readFile(path.join(f.binaryDirectory,'fixture.png'))).toEqual(Buffer.from([0,1,2,255]));
 await f.tool.execute({url:url('binary'),save_binary:true,prefer_llms_txt:'never'},f.context);
 expect(await fs.readFile(path.join(f.binaryDirectory,'fixture-1.png'))).toEqual(Buffer.from([0,1,2,255]));
 const result=await f.tool.execute({url:url('text'),prompt:'Find exact words',prefer_llms_txt:'never'},f.context);
 expect(result).toContain('Exact secondary answer');expect(calls[0].model).toEqual({providerID:'owned',modelID:'model',variant:'high'});
 expect(calls[0].sessionID).toBe('ses_owned');
 const inherited=[];let small='owned/saved';const frozenSmall=await fixture({smallModelRef:()=>small,secondary:async request=>{inherited.push(request.model);return 'Frozen small model';}});small='owned/changed';await frozenSmall.tool.execute({url:url('text'),prompt:'Capture',prefer_llms_txt:'never'},frozenSmall.context);expect(inherited).toEqual([{providerID:'owned',modelID:'saved'}]);expect(calls[0].prompt).toContain('Use only the fetched content below.');expect(calls[0].prompt).toContain('Task:\nFind exact words');
 const controller=new AbortController();const pending=f.tool.execute({url:url('slow'),prefer_llms_txt:'never'},{...f.context,abort:controller.signal});
 setTimeout(()=>controller.abort(new Error('owned_cancelled')),5);
 await expect(pending).rejects.toThrow('owned_cancelled');
 const denied=await fixture({deny:true});await expect(denied.tool.execute({url:url('text')},denied.context)).rejects.toThrow('permission_denied');expect(denied.requests).toEqual([]);
 f.revoke();await expect(f.tool.execute({url:url('binary'),save_binary:true},f.context)).rejects.toThrow('grant_revoked');expect(f.saves).toHaveLength(2);
});

test('concurrent owners do not borrow cache, DOM, save or secondary authority',async()=>{
 const a=await fixture({configuration:{webfetchModels:[{id:'owned/a'}]},secondary:async()=>{await Bun.sleep(10);return 'Only owner A';}});
 const b=await fixture({configuration:{webfetchModels:[{id:'owned/b'}]},secondary:async()=> 'Only owner B'});
 const results=await Promise.all([a.tool.execute({url:url('text'),prompt:'A',prefer_llms_txt:'never'},a.context),b.tool.execute({url:url('text'),prompt:'B',prefer_llms_txt:'never'},b.context)]);
 expect(results[0]).toContain('Only owner A');expect(results[1]).toContain('Only owner B');expect(a.requests).toHaveLength(2);expect(b.requests).toHaveLength(2);
 await expect(a.tool.execute({url:url('html'),prefer_llms_txt:'never'},a.context)).rejects.toThrow('approved_jsdom_unavailable');
 await expect(original.createWebfetchTool({},{binaryDir:a.binaryDirectory}).execute({url:url('text'),format:'text',extract_main:true,prefer_llms_txt:'never',include_metadata:true,save_binary:false},a.context)).rejects.toThrow('reviewed_webfetch_owner_required');
});

test('captured original JSDOM30.1.1 runs the actual Slim extractor without browser/script/network substitution',async()=>{
 const directory=await fs.realpath(path.join(repository,'packages/web/runtime/reviewed-inputs/jsdom-30.1.1/node_modules/jsdom'));
 if(!directory.startsWith(repository+path.sep))throw new Error('Captured parser escaped repository');
 const metadata=JSON.parse(await fs.readFile(path.join(directory,'package.json'),'utf8'));expect(metadata.version).toBe('30.1.1');
 const parser=await original.loadReviewedSlimJSDOM();
 const f=await fixture({loadJSDOM:async()=>parser,fetcher:async()=>new Response('<!doctype html><html><head><title>Exact original HTML</title><link rel="canonical" href="/canonical"></head><body><main><h1>Owned heading</h1><p>'+Array.from({length:80},(_,i)=>'Original content '+i).join(' ')+'</p><pre><code>const exact = 42;</code></pre><script>throw new Error("must not execute");</script></main></body></html>',{headers:{'content-type':'text/html'}})});
 const result=await f.tool.execute({url:url('html'),prefer_llms_txt:'never'},f.context);
 expect(result).toContain('Exact original HTML');expect(result).toContain('Owned heading');expect(result).toContain('const exact = 42;');expect(result).toContain('/canonical');expect(result).not.toContain('must not execute');
});

test('webfetch fixture cleanup',async()=>{server.stop(true);await fs.rm(root,{recursive:true,force:true});});
