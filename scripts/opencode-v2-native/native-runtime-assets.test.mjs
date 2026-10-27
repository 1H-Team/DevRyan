import {test} from 'bun:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {createRequire} from 'node:module';import {createHash} from 'node:crypto';import path from 'node:path';
import os from 'node:os';
import {rewriteNativeAsset,rewriteNativeAgentDefaults,NATIVE_AGENT_DEFAULTS_SOURCE_SHA256,rewriteUnavailableNativePty,NATIVE_ASSET_SOURCE_SHA,prepareReviewedNativeInputs,REVIEWED_AST_FILENAME} from '../native-runtime-assets.mjs';
import {execFileSync} from 'node:child_process';
import {findNativeCoreSources} from '../native-core-sources.mjs';
const repository=path.resolve(import.meta.dirname,'../..'),core=await fs.realpath(path.join(repository,'node_modules/@opencode/core'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
test('FFI verification embeds the native library from the locked core dependency',async()=>{
 const verifier=path.join(repository,'packages/web/server/lib/opencode/runtime-host/verify-assets.ts');
 const source=await fs.readFile(verifier,'utf8');
 const imported=source.match(/import ffiAsset from '([^']+)' with \{type:'file'\}/)?.[1];
 assert.ok(imported);
 const require=createRequire(path.join(core,'package.json'));
 const expected=path.join(path.dirname(require.resolve('bun-pty/package.json')),'rust-pty/target/release/librust_pty_arm64.dylib');
 assert.equal(await fs.realpath(path.resolve(path.dirname(verifier),imported)),await fs.realpath(expected));
 assert.ok(source.includes(`if(hash(ffiBytes)!=='${hash(await fs.readFile(expected))}')`));
});
test('Windows-style Git checkout preserves byte-pinned reviewed resources',async()=>{
 const fixture=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'devryan-reviewed-checkout-')));
 const files=['packages/web/server/default-config/plugins/devryan-document-reader.mjs','packages/web/server/default-config/plugins/devryan-browser.mjs'];
 try{
  execFileSync('git',['init','-q'],{cwd:fixture});
  await fs.copyFile(path.join(repository,'.gitattributes'),path.join(fixture,'.gitattributes'));
  const originals=await Promise.all(files.map(file=>fs.readFile(path.join(repository,file))));
  for(let i=0;i<files.length;i++){await fs.mkdir(path.dirname(path.join(fixture,files[i])),{recursive:true});await fs.writeFile(path.join(fixture,files[i]),originals[i]);}
  execFileSync('git',['-c','core.autocrlf=false','add','-f','.gitattributes',...files],{cwd:fixture});
  for(const file of files)await fs.rm(path.join(fixture,file));
  execFileSync('git',['-c','core.autocrlf=true','checkout','--',...files],{cwd:fixture});
  for(let i=0;i<files.length;i++)assert.deepEqual(await fs.readFile(path.join(fixture,files[i])),originals[i]);
 }finally{await fs.rm(fixture,{recursive:true,force:true});}
});
test('asset rewrites require exact pinned sources and embed only reviewed native paths',async()=>{
 const require=createRequire(path.join(core,'package.json'));
 const pty=await fs.readFile((await findNativeCoreSources(core)).pty);
 assert.equal(hash(pty),NATIVE_ASSET_SOURCE_SHA.pty);
 const assetPath=path.join(path.dirname(require.resolve('@opencode-ai/pty-darwin-arm64/package.json')),'bin/opencode-pty');
 const assetSha256=hash(await fs.readFile(assetPath));
 const transformed=rewriteNativeAsset('pty',pty,{assetPath,assetSha256});
 assert.match(transformed,/with \{type:'file'\}/);assert.match(transformed,/version:'0.3.1'/);assert.doesNotMatch(transformed,/binaryPath|createRequire/);
 const photon=await fs.readFile(require.resolve('@silvia-odwyer/photon-node'));
 const rewritten=rewriteNativeAsset('photon',photon);
 assert.match(rewritten,/globalThis.__OPENCODE_PHOTON_WASM_PATH/);assert.doesNotMatch(rewritten,/join\(__dirname, 'photon_rs_bg.wasm'\)/);
 assert.equal(rewritten.includes('new WebAssembly.Module(bytes)'),true);
 for(const kind of ['pty','photon']) assert.throws(()=>rewriteNativeAsset(kind,Buffer.from('changed source'),{assetPath,assetSha256}),/resolver changed/);
 assert.throws(()=>rewriteNativeAsset('pty',pty,{assetPath,assetSha256:'0'.repeat(64)}),/asset changed/);
});
test('agent defaults regain only the 2.0.24 external-directory ask directly after allow-all',async()=>{
 const file=await fs.realpath(path.join(path.dirname(core),'schema/dist/agent.js')),source=await fs.readFile(file);
 assert.equal(hash(source),NATIVE_AGENT_DEFAULTS_SOURCE_SHA256);
 const rules=text=>[...text.matchAll(/\{ action: "([^"]+)", resource: "([^"]+)", effect: "([^"]+)" \}/g)].map(match=>match.slice(1).join(' '));
 assert.deepEqual(rules(rewriteNativeAgentDefaults(source)),['* * allow','external_directory * ask',...rules(source.toString('utf8')).slice(1)]);
 assert.throws(()=>rewriteNativeAgentDefaults(Buffer.from('changed source')),/agent defaults changed/);
});
test('Windows native PTY refuses before environment or filesystem discovery',async()=>{
 const source=await fs.readFile(path.join(core,'dist/persistent-pty/binary.bun.js'));
 const transformed=rewriteUnavailableNativePty(source);
 const resolveBinary=new Function('process',transformed.replace('export {resolveBinary};','return resolveBinary;'))(new Proxy({}, {get(){throw new Error('environment must not be read');}}));
 await assert.rejects(resolveBinary('/not-an-owned-path'),/native_pty_platform_unsupported/);
 assert.doesNotMatch(transformed,/import|require|mkdir|OPENCODE_PTY_BIN|process/);
 assert.throws(()=>rewriteUnavailableNativePty(Buffer.concat([source,Buffer.from('\n')])),/resolver changed/);
});
test('reviewed original closure and exact constructor transforms are inventoried without runtime cache roots',async()=>{
 const reviewed=await prepareReviewedNativeInputs(repository);
 const root=path.join(repository,'packages/web/runtime/reviewed-inputs');
 const manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8'));
 for(const input of manifest.inputs)for(const file of input.files)assert.equal(reviewed.inputFiles.get(path.join(root,input.id,file.path)),file.sha256);
 // Ponytail was removed: no captured input, linked file, transform or virtual module remains.
 assert.deepEqual(manifest.inputs.map(input=>input.id).sort(),['ast-grep-0.45.3','claude-1.11.2','imagegen-0.1.12','jsdom-30.1.1']);
 assert.equal(Object.hasOwn(manifest.runtimeDisposition,'Ponytail'),false);
 assert.equal([...reviewed.inputFiles.keys()].some(file=>file.startsWith(path.join(root,'ponytail-'))),false);
 assert.equal([...reviewed.virtualModules.keys(),...reviewed.transforms.map(item=>String(item.path))].some(id=>/ponytail/i.test(id)),false);
 // The built-in agents are workspace source (packages/agents-core), not a
 // captured input with a build-time rewrite.
 assert.equal(manifest.inputs.some(input=>input.id.startsWith('slim-')),false);
 assert.equal([...reviewed.inputFiles.keys(),...reviewed.rewrites.keys()].some(file=>file.startsWith(path.join(root,'slim-'))),false);
 assert.equal(reviewed.transforms.some(item=>item.reason==='reviewed-slim-owned-constructor-seams'),false);
 assert.equal(reviewed.claudeCredentials.path,'DevRyan-Claude-credentials.mjs');
 assert.equal(reviewed.claudeCredentials.sha256,hash(reviewed.claudeCredentials.contents));
 assert.equal(reviewed.claudeCredentials.mode,0o644);
 const checkpointOwner=path.join(repository,'packages/web/server/lib/opencode/meridian-passthrough-handoff.js');
 const checkpointCaptured=path.join(root,'claude-1.11.2/node_modules/@rynfar/meridian/dist/devryan-meridian-passthrough-handoff.js');
 const checkpointContents=await fs.readFile(checkpointOwner,'utf8');
 assert.equal(reviewed.rewrites.get(checkpointCaptured),checkpointContents);
 assert.equal(reviewed.inputFiles.get(checkpointOwner),hash(checkpointContents));
 assert.ok(reviewed.transforms.some(row=>row.path===path.relative(repository,checkpointCaptured)&&row.reason==='canonical-transport-owned-checkpoint-verification'));
 const meridian=reviewed.rewrites.get(path.join(root,'claude-1.11.2/node_modules/@rynfar/meridian/dist/cli-ykdmqmn4.js'));
 assert.match(meridian,/__DEVRYAN_CLAUDE_CHECKPOINT_DIAGNOSTIC/);
 assert.match(meridian,/passthrough\.checkpoint_replay/);
 assert.match(meridian,/retryStalledCheckpoint\(\(\) => runSdkQueryAttempt\(/);
 assert.match(reviewed.claudeCredentials.contents,/export \{createPlatformCredentialStore, ensureFreshToken, refreshOAuthToken\};/);
 assert.equal(reviewed.ast.path,REVIEWED_AST_FILENAME);
 assert.equal(reviewed.ast.sha256,hash(await fs.readFile(reviewed.ast.source)));
 assert.equal(reviewed.provenance.find(value=>value.id==='ast-grep-0.45.3').license.standaloneLicenseCaptured,false);
 assert.equal(reviewed.provenance.find(value=>value.id==='jsdom-30.1.1').version,'30.1.1');
 const domRoot=path.join(root,'jsdom-30.1.1/node_modules/jsdom/lib/jsdom');
 assert.match(reviewed.rewrites.get(path.join(domRoot,'utils.js')),/exports.Canvas = null;/);
 assert.doesNotMatch(reviewed.rewrites.get(path.join(domRoot,'utils.js')),/require\("canvas"\)/);
 assert.doesNotMatch(reviewed.rewrites.get(path.join(domRoot,'living/css/helpers/computed-style.js')),/const defaultStyleSheet = fs.readFileSync/);
 assert.equal(reviewed.resolutions.has(path.join(domRoot,'browser/Window.js')+'\0whatwg-url'),true);
 const jsoncMain=Bun.resolveSync('jsonc-parser',path.join(repository,'packages/web'));
 const jsoncPackage=path.resolve(path.dirname(jsoncMain),'../../package.json');
 const workspace=reviewed.workspaceResolutions.get(path.join(repository,'packages/shared-runtime'));
 assert.equal(workspace.get('adm-zip'),Bun.resolveSync('adm-zip',path.join(repository,'packages/shared-runtime')));
 assert.equal(workspace.has('undeclared-fixture-package'),false);
 assert.equal(reviewed.inputFiles.get(path.join(repository,'packages/shared-runtime/package.json')),hash(await fs.readFile(path.join(repository,'packages/shared-runtime/package.json'))));
 assert.equal(reviewed.inputFiles.get(path.join(repository,'bun.lock')),hash(await fs.readFile(path.join(repository,'bun.lock'))));
 assert.equal(reviewed.inputFiles.get(jsoncPackage),hash(await fs.readFile(jsoncPackage)));
 assert.equal(reviewed.transforms.find(item=>item.reason==='pinned-jsonc-original-esm-module-resolution').sha256,hash(await fs.readFile(jsoncMain)));
 const workspaceManifest=new Set([...reviewed.workspaceResolutions.keys()].map(directory=>path.join(directory,'package.json')));
 assert.equal([...reviewed.inputFiles].every(([file])=>file.startsWith(root+path.sep)||file===jsoncPackage||file===checkpointOwner||file===path.join(repository,'bun.lock')||workspaceManifest.has(file)
  ||file.startsWith(path.join(repository,'node_modules/.bun')+path.sep)&&path.basename(file)==='package.json'
  ||file===path.join(repository,'packages/web/server/default-config/plugins/devryan-document-reader.mjs')||file===path.join(repository,'packages/web/server/default-config/plugins/devryan-document-reader.d.mts')||file===path.join(repository,'packages/web/server/default-config/plugins/devryan-browser.mjs')||file===path.join(repository,'packages/web/server/default-config/plugins/devryan-browser.d.mts')),true);
});
