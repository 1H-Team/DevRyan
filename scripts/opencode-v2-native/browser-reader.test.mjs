import {test,expect} from 'bun:test';import fs from 'node:fs/promises';import path from 'node:path';import {spawn} from 'node:child_process';
import {prepareReviewedNativeInputs,reviewedNativeInputPlugin} from '../native-runtime-assets.mjs';
const repository=path.resolve(import.meta.dirname,'../..'),parent=path.join(repository,'.cache/v2-validation');await fs.mkdir(parent,{recursive:true});
const root=await fs.mkdtemp(path.join(parent,'native-browser-')),entry=path.join(root,'entry.ts'),bundle=path.join(root,'bundle.mjs');
await fs.writeFile(entry,`export * from ${JSON.stringify(path.join(repository,'packages/web/server/lib/opencode/runtime-host/native-browser.ts'))};
export * from ${JSON.stringify(path.join(repository,'packages/web/server/default-config/plugins/devryan-browser.mjs'))};
export * from ${JSON.stringify(path.join(repository,'packages/web/server/lib/opencode/runtime-host/native-slim-dom.ts'))};`);
const built=await Bun.build({entrypoints:[entry],target:'bun',plugins:[reviewedNativeInputPlugin(await prepareReviewedNativeInputs(repository))]});if(!built.success)throw new AggregateError(built.logs,'Original browser graph failed');await fs.writeFile(bundle,await built.outputs[0].text());const original=await import(bundle);
const binary=path.join(root,'fixture-browser'),config=path.join(root,'empty.json');await fs.writeFile(config,'{}');
await fs.writeFile(binary,`#!${process.execPath}\nimport {loadReviewedSlimJSDOM} from './bundle.mjs';
const args=process.argv.slice(2),command=args[8];
if(command==='eval'){const {JSDOM}=await loadReviewedSlimJSDOM();const dom=new JSDOM('<main><button id="exact" data-state="ready">Owned fixture</button></main>');globalThis.document=dom.window.document;globalThis.getComputedStyle=dom.window.getComputedStyle;console.log(JSON.stringify((0,eval)(args[9])));dom.window.close();}
else if(command==='wait'){setTimeout(()=>console.log('late'),5000);}
else console.log('Exact local CLI '+command);\n`,{mode:0o755});
const calls=[],processes=[];let grant=true,preview='http://127.0.0.1:1234';
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){const payload=await request.json();calls.push(payload);if(payload.scope.opencodeSessionID!=='ses_owned'||payload.scope.messageID!=='msg_user'||payload.scope.directory!==root)return new Response('scope denied',{status:403});if(payload.operation==='resolve')return Response.json({previewUrl:preview});if(payload.operation==='acquire')return Response.json({leaseId:'owned_lease',wsUrl:'ws://127.0.0.1:1234/private-proxy',previewUrl:preview,created:true,clientAttached:false});return Response.json({ok:true});}});
const context={sessionID:'ses_owned',messageID:'msg_assistant',directory:root,agent:'build',abort:new AbortController().signal};
const environment={leasesUrl:'devryan://private-browser/leases',token:'',binaryPath:binary,configPath:config,installRoot:root,screenshotDirectory:null,ffmpegDirectory:null};
let invalidTurn=false;
const owners={assertCurrent:async()=>{if(!grant)throw new Error('grant_revoked');},resolveTurn:async scope=>{if(scope.messageID!=='msg_assistant')throw new Error('canonical_assistant_missing');return invalidTurn?'foreign':'msg_user';},
 lease:async(operation,input)=>{const response=await fetch(`http://127.0.0.1:${server.port}/lease`,{method:'POST',body:JSON.stringify({operation,...input,signal:undefined}),signal:input.signal});if(!response.ok)throw new Error('actual_lease_scope_refused');return response.json();},
 runBinary:async input=>{
  let settled=Promise.resolve();let child;
  try{return await original.runReviewedBrowserBinary({...input,spawnImpl:(file,args,options)=>{child=spawn(file,args,{...options,env:{...options.env,HOME:root,XDG_CONFIG_HOME:root,XDG_DATA_HOME:root,XDG_CACHE_HOME:root,XDG_STATE_HOME:root,OPENCODE_CONFIG_DIR:root,TMPDIR:root}});processes.push(child);settled=new Promise(resolve=>{child.once('close',resolve);child.once('error',resolve);});return child;}});}finally{await settled;}
 }};
const tool=await original.createOwnedNativeBrowser({originals:original,environment,ownersFor:async()=>owners});

test('actual original lease/CLI/inspect/sequence flow uses canonical turn and bounded private transport',async()=>{
 const result=await tool.execute({command:'sequence',steps:[{command:'open',args:['http://127.0.0.1:1234']},{command:'inspect',selector:'#exact',attributes:['data-state']},{command:'close'}]},context);
 const parsed=JSON.parse(result);expect(parsed.results).toHaveLength(3);expect(parsed.results[0].output).toBe('Exact local CLI open');
 const inspected=JSON.parse(parsed.results[1].output);expect(inspected).toEqual({status:'found',selector:'#exact',matchCount:1,styles:{},attributes:{'data-state':'ready'}});expect(parsed.results[2].output).toBe('Browser lease closed.');
 expect(calls.filter(call=>call.operation==='acquire')).toHaveLength(1);expect(calls.at(-1).operation).toBe('release');expect(calls.every(call=>call.scope.messageID==='msg_user')).toBe(true);expect(processes.every(child=>child.exitCode!==null)).toBe(true);
});

test('original no-preview handoff, forbidden controls/schema, cancellation settlement and revocation remain enforced',async()=>{
 const fresh=await original.createOwnedNativeBrowser({originals:original,environment,ownersFor:async()=>owners});preview=null;const before=processes.length;
 const guidance=await fresh.execute({command:'open'},context);expect(guidance).toBe(original.__test.NO_PREVIEW_HANDOFF_MESSAGE);expect(processes).toHaveLength(before);preview='http://127.0.0.1:1234';
 await expect(tool.execute({command:'connect',args:['ws://foreign']},context)).rejects.toThrow();await expect(tool.execute({command:'open',args:['--session','foreign']},context)).rejects.toThrow();
 await expect(tool.execute({command:'record',args:['start']},context)).rejects.toThrow('sequence');await expect(tool.execute({command:'sequence',steps:[]},context)).rejects.toThrow();await expect(tool.execute({command:'snapshot',forged:true},context)).rejects.toThrow('native_browser_input_invalid');
 const controller=new AbortController();const pending=tool.execute({command:'sequence',steps:[{command:'wait'}],timeout_ms:10000},{...context,abort:controller.signal});
 setTimeout(()=>controller.abort(new Error('owned_cancelled')),150);await expect(pending).rejects.toThrow();expect(processes.every(child=>child.exitCode!==null||child.signalCode!==null)).toBe(true);
 invalidTurn=true;await expect(tool.execute({command:'snapshot'},context)).rejects.toThrow('actual_lease_scope_refused');invalidTurn=false;
 grant=false;await expect(tool.execute({command:'snapshot'},context)).rejects.toThrow('grant_revoked');
 await expect(original.DevRyanBrowserPlugin({})).rejects.toThrow('reviewed_browser_owner_required');
});

test('browser fixture cleanup',async()=>{server.stop(true);await fs.rm(root,{recursive:true,force:true});});
