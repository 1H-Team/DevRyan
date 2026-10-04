import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {isBuiltin} from 'node:module';
import {rewriteReviewedSlimServer,REVIEWED_AST_ASSET_SHA256} from '../packages/web/server/lib/opencode/runtime-host/reviewed-package-transforms.js';
import {rewriteReviewedBrowser} from '../packages/web/server/lib/opencode/runtime-host/reviewed-browser-transform.js';
import {rewriteReviewedImagegen,rewriteReviewedImagegenDebug} from '../packages/web/server/lib/opencode/runtime-host/reviewed-imagegen-transform.js';
import {rewriteReviewedDocumentReader} from '../packages/web/server/lib/opencode/runtime-host/reviewed-document-transform.js';
import {renderReviewedPonytailInstructions} from '../packages/web/server/lib/opencode/runtime-host/reviewed-ponytail-instructions.js';
import {rewriteReviewedClaudeStartup,rewriteReviewedMeridianLibsql,rewriteReviewedClaudeSpawn,rewriteReviewedMeridianHttp,rewriteReviewedClaudeCredentials,REVIEWED_CLAUDE_ASSETS,REVIEWED_CLAUDE_CREDENTIALS} from '../packages/web/server/lib/opencode/runtime-host/reviewed-claude-transform.js';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const resolvePinnedJsonc=async resolved=>{
 const packageRoot=path.resolve(path.dirname(resolved),'../..');
 const packagePath=path.join(packageRoot,'package.json'),packageBytes=await fs.readFile(packagePath);
 const info=JSON.parse(packageBytes.toString('utf8'));
 if(info.name!=='jsonc-parser'||info.version!=='3.3.1'||info.main!=='./lib/umd/main.js'||info.module!=='./lib/esm/main.js'
  ||resolved!==path.join(packageRoot,'lib/umd/main.js'))throw new Error('Pinned JSONC module resolution changed');
 const modulePath=path.join(packageRoot,'lib/esm/main.js');
 if(await fs.realpath(modulePath)!==modulePath)throw new Error('Pinned JSONC module escaped package');
 return {modulePath,packagePath,packageBytes};
};
export const NATIVE_ASSET_SOURCE_SHA=Object.freeze({pty:'fe38312cd4acdfb067f520d3917daf52add098bb267e33bf7a8f7f44fc74ac8f',photon:'d60656705f0d59baa79e36b0381eb023f1864eeb57e92956cf21dcd9fb8f879f'});
/** Build-only transformations require the exact pinned bytes before rewriting. */
export function rewriteNativeAsset(kind,source,{assetPath,assetSha256}={}) {
 if(!Object.hasOwn(NATIVE_ASSET_SOURCE_SHA,kind)||hash(source)!==NATIVE_ASSET_SOURCE_SHA[kind]) throw new Error('Pinned native asset resolver changed');
 if(kind==='pty') {
  if(typeof assetPath!=='string'||!assetPath.startsWith('/')||!/^d333339292bb9f9a739dbce9e2ababbce81b3040ea3d064b8a9b359a1c05ab61$/.test(assetSha256)) throw new Error('Pinned native PTY asset changed');
  return `import embedded from ${JSON.stringify(assetPath)} with {type:'file'};\nconst pty_binding_default={path:embedded,version:'0.1.13',sha256:${JSON.stringify(assetSha256)}};\nexport {pty_binding_default};\n`;
 }
 const original="const path = require('path').join(__dirname, 'photon_rs_bg.wasm');";
 const text=Buffer.from(source).toString('utf8');
 if(text.split(original).length!==2) throw new Error('Pinned native Photon resolver changed');
 return text.replace(original,"const path = globalThis.__OPENCODE_PHOTON_WASM_PATH;\nif (typeof path !== 'string' || !path) throw new Error('Native embedded Photon WASM unavailable');");
}

export const REVIEWED_PONYTAIL_MODULE='devryan:reviewed-ponytail-instructions';
export const REVIEWED_AST_FILENAME='DevRyan-ast-grep-darwin-arm64';

/** Build-only original closure; none of these paths are runtime search roots. */
export async function prepareReviewedNativeInputs(repository) {
 const root=path.join(repository,'packages/web/runtime/reviewed-inputs');
 const inputFiles=new Map();
 const jsoncMain=Bun.resolveSync('jsonc-parser',path.join(repository,'packages/web'));
 const jsonc=await resolvePinnedJsonc(jsoncMain);
 inputFiles.set(jsonc.packagePath,hash(jsonc.packageBytes));
 const read=async relative=>{
  const absolute=path.resolve(root,relative);
  if(!absolute.startsWith(root+path.sep)||(await fs.realpath(absolute))!==absolute)throw new Error('Reviewed input escaped its closure');
  const bytes=await fs.readFile(absolute);inputFiles.set(absolute,hash(bytes));return bytes;
 };
 const manifest=JSON.parse((await read('manifest.json')).toString('utf8'));
 const versions={'slim-2.2.25':'2.2.25','ponytail-4.10.0':'4.10.0','ast-grep-0.45.3':'0.45.3','jsdom-30.1.1':'30.1.1','claude-1.8.0':'1.8.0','imagegen-0.1.12':'0.1.12'};
 if(manifest.schema!==1||!Array.isArray(manifest.inputs)||manifest.inputs.length!==6)throw new Error('Reviewed input manifest changed');
 const seen=new Set();
 for(const input of manifest.inputs){
  if(!Object.hasOwn(versions,input.id)||versions[input.id]!==input.version||seen.has(input.id)||!Array.isArray(input.files))throw new Error('Reviewed input manifest changed');
  seen.add(input.id);const paths=new Set();
  for(const file of input.files){
   if(typeof file.path!=='string'||path.isAbsolute(file.path)||file.path.split(/[\\/]/).some(part=>part==='..'||part==='')||paths.has(file.path))throw new Error('Reviewed input path invalid');
   paths.add(file.path);const bytes=await read(`${input.id}/${file.path}`);
   if(bytes.length!==file.size||hash(bytes)!==file.sha256)throw new Error('Reviewed input bytes changed');
  }
 }
 await read('README.md');await read('slim-2.2.25/dist/server/index.d.ts');await read('jsdom-30.1.1/node_modules/jsdom/lib/api.d.ts');
 const graph=JSON.parse((await read('jsdom-30.1.1/resolutions.json')).toString('utf8'));
 if(graph.schema!==1||!Array.isArray(graph.edges))throw new Error('Reviewed DOM resolution graph invalid');
 const resolutions=new Map();
 for(const edge of graph.edges){
  const importer=path.resolve(root,'jsdom-30.1.1',edge.importer),target=path.resolve(root,'jsdom-30.1.1',edge.target);
  if(!inputFiles.has(importer)||!inputFiles.has(target)||typeof edge.specifier!=='string'||edge.specifier.startsWith('.')||edge.specifier.startsWith('/'))throw new Error('Reviewed DOM resolution graph invalid');
  const key=importer+'\0'+edge.specifier;
  if(resolutions.has(key)&&resolutions.get(key)!==target)throw new Error('Reviewed DOM resolution graph conflict');
  resolutions.set(key,target);
 }
 const claudeGraph=JSON.parse((await read('claude-1.8.0/resolutions.json')).toString('utf8'));
 if(claudeGraph.schema!==1||!Array.isArray(claudeGraph.edges))throw new Error('Reviewed Claude resolution graph invalid');
 for(const edge of claudeGraph.edges){
  const importer=path.resolve(root,'claude-1.8.0',edge.importer),target=path.resolve(root,'claude-1.8.0',edge.target);
  if(!inputFiles.has(importer)||!inputFiles.has(target)||typeof edge.specifier!=='string'||edge.specifier.startsWith('.')||edge.specifier.startsWith('/'))throw new Error('Reviewed Claude resolution graph invalid');
  const key=importer+'\0'+edge.specifier;if(resolutions.has(key)&&resolutions.get(key)!==target)throw new Error('Reviewed Claude resolution graph conflict');resolutions.set(key,target);
 }
 const imagegenPath=path.join(root,'imagegen-0.1.12/dist/index.js'),imagegenOriginal=await read('imagegen-0.1.12/dist/index.js');
 const imagegen=rewriteReviewedImagegen(imagegenOriginal);
 const imagegenDebugPath=path.join(root,'imagegen-0.1.12/node_modules/debug@4.4.3/src/node.js');
 const imagegenDebugOriginal=await fs.readFile(imagegenDebugPath),imagegenDebug=rewriteReviewedImagegenDebug(imagegenDebugOriginal);
 const imagegenGraph=JSON.parse((await read('imagegen-0.1.12/resolutions.json')).toString('utf8'));
 if(imagegenGraph.schema!==1||!Array.isArray(imagegenGraph.edges))throw Error('Reviewed image dependency graph invalid');
 for(const edge of imagegenGraph.edges){
  const importer=path.resolve(root,'imagegen-0.1.12',edge.importer),target=path.resolve(root,'imagegen-0.1.12',edge.target);
  if(!inputFiles.has(importer)||!inputFiles.has(target)||typeof edge.specifier!=='string')throw Error('Reviewed image dependency graph invalid');
  if(edge.specifier.startsWith('.')||edge.specifier.startsWith('/'))continue;
  const key=importer+'\0'+edge.specifier;if(resolutions.has(key)&&resolutions.get(key)!==target)throw Error('Reviewed image dependency graph conflict');resolutions.set(key,target);
 }
 const claudePath=path.join(root,'claude-1.8.0/node_modules/opencode-with-claude/dist/index.js');
 const claudeOriginal=await fs.readFile(claudePath,'utf8'),claudeContents=rewriteReviewedClaudeStartup(claudeOriginal);
 const libsqlPath=path.join(root,'claude-1.8.0/node_modules/@rynfar/meridian/dist/cli-wxk8xvd3.js');
 const libsqlOriginal=await fs.readFile(libsqlPath),libsqlContents=rewriteReviewedMeridianLibsql(libsqlOriginal);
 const spawnPath=path.join(root,'claude-1.8.0/node_modules/@rynfar/meridian/dist/devryan-session-provider-spawn.js');
 const spawnOriginal=await fs.readFile(spawnPath),spawnContents=rewriteReviewedClaudeSpawn(spawnOriginal);
 const httpPath=path.join(root,'claude-1.8.0/node_modules/@rynfar/meridian/dist/devryan-meridian-http-server.js');
 const httpOriginal=await fs.readFile(httpPath),httpContents=rewriteReviewedMeridianHttp(httpOriginal);
 const credentialPath=path.join(root,'claude-1.8.0/node_modules/@rynfar/meridian/dist/cli-khhjyk04.js');
 const credentialOriginal=await fs.readFile(credentialPath),credentialContents=rewriteReviewedClaudeCredentials(credentialOriginal);
 if(hash(credentialContents)!==REVIEWED_CLAUDE_CREDENTIALS.sha256)throw new Error('Reviewed Claude credential output changed');
 const claudeCredentials={...REVIEWED_CLAUDE_CREDENTIALS,contents:credentialContents};
 const claudeAssets=Object.fromEntries(Object.entries(REVIEWED_CLAUDE_ASSETS).map(([name,asset])=>{
  const source=path.join(root,'claude-1.8.0/assets',asset.path);if(inputFiles.get(source)!==asset.sha256)throw new Error('Reviewed Claude asset changed');return [name,{...asset,source}];
 }));
 const slimPath=path.join(root,'slim-2.2.25/dist/server/index.js');
 const slim=rewriteReviewedSlimServer(await fs.readFile(slimPath));
 const ponytail=await renderReviewedPonytailInstructions();
 const documentPath=path.join(repository,'packages/web/server/default-config/plugins/devryan-document-reader.mjs');
 if(await fs.realpath(documentPath)!==documentPath)throw new Error('Reviewed document input escaped repository');
 const documentOriginal=await fs.readFile(documentPath),document=rewriteReviewedDocumentReader(documentOriginal);
 inputFiles.set(documentPath,hash(documentOriginal));
 const documentDeclaration=documentPath.replace(/\.mjs$/,'.d.mts');inputFiles.set(documentDeclaration,hash(await fs.readFile(documentDeclaration)));
 const browserPath=path.join(repository,'packages/web/server/default-config/plugins/devryan-browser.mjs');
 if(await fs.realpath(browserPath)!==browserPath)throw new Error('Reviewed browser input escaped repository');
 const browserOriginal=await fs.readFile(browserPath),browser=rewriteReviewedBrowser(browserOriginal);inputFiles.set(browserPath,hash(browserOriginal));
 const browserDeclaration=browserPath.replace(/\.mjs$/,'.d.mts');inputFiles.set(browserDeclaration,hash(await fs.readFile(browserDeclaration)));


 const astPath=path.join(root,'ast-grep-0.45.3/cli-darwin-arm64',REVIEWED_AST_FILENAME);
 if(inputFiles.get(astPath)!==REVIEWED_AST_ASSET_SHA256)throw new Error('Reviewed AST asset changed');
 const jsdomPath=path.join(root,'jsdom-30.1.1/node_modules/jsdom/lib/jsdom/utils.js');
 const jsdomOriginal=await fs.readFile(jsdomPath);
 if(hash(jsdomOriginal)!=='4c7ec122e932214b83ded95bbe904c392b4b8553a5b9b83ffb8d3d755e43d3d4')throw new Error('Reviewed JSDOM optional resolver changed');
 const canvasOriginal='try {\n  exports.Canvas = require("canvas");\n} catch {\n  exports.Canvas = null;\n}';
 const jsdomText=jsdomOriginal.toString('utf8');
 if(jsdomText.split(canvasOriginal).length!==2)throw new Error('Reviewed JSDOM optional resolver changed');
 const jsdomContents=jsdomText.replace(canvasOriginal,'exports.Canvas = null;');
 const stylePath=path.join(root,'jsdom-30.1.1/node_modules/jsdom/lib/jsdom/living/css/helpers/computed-style.js');
 const styleOriginal=await fs.readFile(stylePath);
 if(hash(styleOriginal)!=='3cb3007707b27a4d8ea8e78d790925f74ae0d805e2a7110c43d29db0669d12d0')throw new Error('Reviewed DOM stylesheet loader changed');
 const styleLoader='const defaultStyleSheet = fs.readFileSync(\n  path.resolve(__dirname, "../../../browser/default-stylesheet.css"),\n  { encoding: "utf-8" }\n);';
 const styleText=styleOriginal.toString('utf8');
 if(styleText.split(styleLoader).length!==2)throw new Error('Reviewed DOM stylesheet loader changed');
 const stylesheet=(await read('jsdom-30.1.1/node_modules/jsdom/lib/jsdom/browser/default-stylesheet.css')).toString('utf8');
 const styleReplacement='const defaultStyleSheet = '+JSON.stringify(stylesheet)+';';
 const styleContents=styleText.replace(styleLoader,styleReplacement);
 const xhrPath=path.join(root,'jsdom-30.1.1/node_modules/jsdom/lib/jsdom/living/xhr/XMLHttpRequest-impl.js');
 const xhrOriginal=await fs.readFile(xhrPath);
 if(hash(xhrOriginal)!=='6fd6e204c59a0fe05fa93e48553efde0d9603f7df525d8432a3261fa77e7f6f7')throw new Error('Reviewed DOM sync XHR resolver changed');
 const xhrText=xhrOriginal.toString('utf8'),xhrResolver='const syncWorkerFile = require.resolve("./xhr-sync-worker.js");',xhrCall='syncWorker = new Worker(syncWorkerFile);';
 if(xhrText.split(xhrResolver).length!==2||xhrText.split(xhrCall).length!==2)throw new Error('Reviewed DOM sync XHR resolver changed');
 // Parsing HTML does not use XHR. Keep the original resolver at the actual
 // worker request; source-denied hosts have no approved sync-XHR capability.
 const xhrContents=xhrText.replace(xhrResolver,'').replace(xhrCall,'syncWorker = new Worker(require.resolve("./xhr-sync-worker.js"));');
 const transforms=[{path:path.relative(repository,imagegenPath),sha256:imagegen.sourceSHA256,outputSha256:imagegen.outputSHA256,reason:'original-image-generation-owned-credential-network-worker',steps:imagegen.transforms},
  {path:path.relative(repository,imagegenDebugPath),sha256:hash(imagegenDebugOriginal),outputSha256:hash(imagegenDebug),reason:'captured-optional-color-helper-absent'},
  {path:path.relative(repository,browserPath),sha256:browser.sourceSHA256,outputSha256:browser.outputSHA256,reason:'production-browser-owned-io',steps:browser.transforms},
  {path:path.relative(repository,documentPath),sha256:document.sourceSHA256,outputSha256:document.outputSHA256,reason:'production-document-owned-io',steps:document.transforms},
  {path:path.relative(repository,slimPath),sha256:slim.sourceSHA256,outputSha256:slim.outputSHA256,
  reason:'reviewed-slim-owned-constructor-seams',steps:slim.transforms},
  {path:REVIEWED_PONYTAIL_MODULE,sha256:hash(JSON.stringify(ponytail.sourceSHA256)),outputSha256:hash(ponytail.moduleSource),
   reason:'reviewed-ponytail-shared-builder',sourceHashes:ponytail.sourceSHA256},
  {path:path.relative(repository,jsdomPath),sha256:hash(jsdomOriginal),outputSha256:hash(jsdomContents),reason:'captured-optional-canvas-absent',steps:[{id:'sealed-jsdom-optional-canvas',originalSHA256:hash(canvasOriginal),outputSHA256:hash('exports.Canvas = null;')}]},
  {path:path.relative(repository,stylePath),sha256:hash(styleOriginal),outputSha256:hash(styleContents),reason:'embed-exact-original-dom-stylesheet',steps:[{id:'sealed-jsdom-stylesheet',originalSHA256:hash(styleLoader),outputSHA256:hash(styleReplacement)}]},
  {path:path.relative(repository,claudePath),sha256:hash(claudeOriginal),outputSha256:hash(claudeContents),reason:'reviewed-original-claude-startup-and-captured-version'},
  {path:path.relative(repository,libsqlPath),sha256:hash(libsqlOriginal),outputSha256:hash(libsqlContents),reason:'verified-private-libsql-and-canonical-project-selection'},
  {path:path.relative(repository,spawnPath),sha256:hash(spawnOriginal),outputSha256:hash(spawnContents),reason:'compiled-original-confined-provider-handoff'},
  {path:path.relative(repository,httpPath),sha256:hash(httpOriginal),outputSha256:hash(httpContents),reason:'worker-owned-http-attempt-admission'}];
 transforms.push({path:path.relative(repository,credentialPath),sha256:hash(credentialOriginal),outputSha256:hash(credentialContents),reason:'sealed-host-selected-claude-renewal'});
 transforms.push({path:path.relative(repository,jsoncMain),sha256:hash(await fs.readFile(jsoncMain)),outputSha256:hash(await fs.readFile(jsonc.modulePath)),reason:'pinned-jsonc-original-esm-module-resolution'},
  {path:path.relative(repository,xhrPath),sha256:hash(xhrOriginal),outputSha256:hash(xhrContents),reason:'compiled-dom-sync-xhr-lazy-original-worker-resolver'});
 return {inputFiles,resolutions,rewrites:new Map([[imagegenPath,imagegen.contents],[imagegenDebugPath,imagegenDebug],[slimPath,slim.contents],[jsdomPath,jsdomContents],[stylePath,styleContents],[xhrPath,xhrContents],[documentPath,document.contents],[browserPath,browser.contents],[claudePath,claudeContents],[libsqlPath,libsqlContents],[spawnPath,spawnContents],[httpPath,httpContents]]),virtualModules:new Map([[REVIEWED_PONYTAIL_MODULE,ponytail.moduleSource],['devryan:reviewed-claude-startup',`export {startReviewedProxy,checkReviewedProxy,scrubReviewedSystem} from ${JSON.stringify(claudePath)};`],['devryan:reviewed-claude-scrub',`export {scrubOpencodeFingerprints} from ${JSON.stringify(path.join(root,'claude-1.8.0/node_modules/@rynfar/meridian-plugin-opencode-scrub/dist/scrub.js'))};`]]),transforms,claudeAssets,claudeCredentials,
  provenance:manifest.inputs.map(({id,version,sourceKind,sourceLocation,license})=>({id,version,sourceKind,sourceLocation,license})),
  ast:{source:astPath,path:REVIEWED_AST_FILENAME,sha256:REVIEWED_AST_ASSET_SHA256}};
}

/** Resolves only explicit modules and exact reviewed rewrite paths. */
export function reviewedNativeInputPlugin({rewrites,virtualModules,inputFiles,resolutions}) {
 return {name:'devryan-reviewed-static-inputs',setup(builder){
  // Workspace lock resolution must not substitute a different package for the captured nested closure.
  builder.onResolve({filter:/^[^./]/},async event=>{
   if(event.path.startsWith('devryan:reviewed-')){
    if(!virtualModules.has(event.path))throw new Error('Unknown reviewed build module');
    return {path:event.path,namespace:'devryan-reviewed'};
   }
   if(isBuiltin(event.path)||event.path.startsWith('bun:'))return {path:event.path,external:true};
   const captured=event.importer.includes('/reviewed-inputs/jsdom-30.1.1/node_modules/')||event.importer.includes('/reviewed-inputs/claude-1.8.0/node_modules/')||event.importer.includes('/reviewed-inputs/imagegen-0.1.12/');
   if(captured){
    const resolved=resolutions.get(event.importer+'\0'+event.path);
    if(resolved)return {path:resolved};
    throw new Error('Reviewed DOM dependency outside captured closure');
   }
   // Bun 1.3.14 drops barrel namespace exports when a matching onResolve
   // callback falls through. Explicit default Bun resolution preserves the
   // actual locked package path and module identity without rewriting sources.
   const resolved=Bun.resolveSync(event.path,path.dirname(event.importer));
   // Bun.resolveSync selects JSONC's UMD main, whose factory-scoped require
   // survives bundling. Use the same pinned original ESM entry Bun.build uses.
   return {path:event.path==='jsonc-parser'?(await resolvePinnedJsonc(resolved)).modulePath:resolved};
  });
  builder.onLoad({filter:/.*/,namespace:'devryan-reviewed'},event=>{
   const contents=virtualModules.get(event.path);if(contents===undefined)throw new Error('Unknown reviewed build module');
   return {contents,loader:'js'};
  });
  builder.onLoad({filter:/\.(?:mjs|js)$/},event=>{
   const contents=rewrites.get(path.resolve(event.path));return contents===undefined?undefined:{contents,loader:'js'};
  });
 }};
}

/** Bun 1.3.14's generated ESM CommonJS shim needs a file-URL base. The
 * manifest-verified Node asset is imported from bytes, so only stdlib access
 * may use a fixed virtual base; runtime package/file resolution stays closed. */
export function rewriteSealedNodeRequire(source){
 const imports=[...source.matchAll(/import\s*\{\s*createRequire(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*\}\s*from\s*["']node:module["'];?/g)];
 if(!imports.length||imports[0].index!==0)throw new Error('Pinned Node require shim import changed');
 const name=imports[0][1]??'createRequire',escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 const declaration=new RegExp(`var\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${escaped}\\(import\\.meta\\.url\\);`,'g');
 const matches=[...source.matchAll(declaration)];if(matches.length!==1)throw new Error('Pinned Node require shim declaration changed');
 const replacement=`var ${matches[0][1]}=(()=>{const original=${name}("file:///DevRyan-native-configuration.mjs");const check=id=>{if(typeof id!=="string"||!__devryanBuiltinRequire(id))throw new Error("native_configuration_external_require_denied");};const owned=id=>{check(id);return original(id);};owned.resolve=id=>{check(id);return original.resolve(id);};return owned;})();`;
 return `import {isBuiltin as __devryanBuiltinRequire} from "node:module";\n`+source.replace(matches[0][0],replacement);
}
