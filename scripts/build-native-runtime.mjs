import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {rewriteNativeAsset,prepareReviewedNativeInputs,reviewedNativeInputPlugin,rewriteSealedNodeRequire} from './native-runtime-assets.mjs';
import {createReviewedNativePluginRegistry} from '../packages/web/server/lib/opencode/runtime-host/native-plugin-registry.ts';
import {rewriteNativeCompactionObservation} from './native-compaction-observation-transform.mjs';
import {CLAUDE_LIFECYCLE_PROTOCOL} from '../packages/web/server/lib/opencode/runtime-host/native-claude-lifecycle.js';
import {NATIVE_BUNDLE_CREDENTIAL_CONTRACT} from '../packages/web/server/lib/opencode/runtime-host/native-bundle-credential-contract.js';

const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {parse:parseJsonc}=createRequire(path.join(repository,'packages/web/package.json'))('jsonc-parser');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const args=process.argv.slice(2),outputIndex=args.indexOf('--output-root');
const productionOutput=path.join(repository,'packages/web/runtime',`${process.platform}-${process.arch}`);
const output=path.resolve(outputIndex<0?productionOutput:args[outputIndex+1]);
const replaceProduction=outputIndex<0;
if(!output.startsWith(repository+path.sep) || args.some((arg,index)=>arg!=='--output-root'&&index!==outputIndex+1)) throw new Error('Owned output root required');
if(Bun.version!=='1.3.14' || process.platform!=='darwin' || process.arch!=='arm64') throw new Error('Native build requires pinned Bun 1.3.14 Darwin arm64');
const host=path.join(repository,'packages/web/server/lib/opencode/runtime-host');
const buildSources=await Promise.all(['scripts/build-native-runtime.mjs','scripts/native-runtime-assets.mjs',
  'scripts/native-compaction-observation-transform.mjs',
  'scripts/build-session-execution.mjs','scripts/verify-session-execution.mjs',
  'packages/harness-runtime/native/session-execution.c','packages/harness-runtime/native/session-spawn-darwin.c',
  'packages/web/server/lib/opencode/runtime-host/reviewed-package-transforms.js',
  'packages/web/server/lib/opencode/runtime-host/reviewed-document-transform.js',
  'packages/web/server/lib/opencode/runtime-host/reviewed-browser-transform.js',
  'packages/web/server/lib/opencode/runtime-host/reviewed-ponytail-instructions.js',
  'packages/web/server/lib/opencode/runtime-host/reviewed-claude-transform.js',
].map(async file=>({path:file,sha256:hash(await fs.readFile(path.join(repository,file)))})));
const lockBytes=await fs.readFile(path.join(repository,'bun.lock')),lock=parseJsonc(lockBytes.toString());
const loaded=new Map(),transforms=[];
const coreRoot=await fs.realpath(path.join(repository,'node_modules/@opencode/core'));
let coreDigest=hash(await fs.readFile(path.join(coreRoot,'package.json')));
const reviewed=await prepareReviewedNativeInputs(repository);
const entries=[['controller',path.join(host,'controller-entry.ts')],['writer',path.join(host,'writer-worker.ts')]];
const configurationEntry=path.join(host,'reviewed-configuration-entry.ts');
const ptyBinding=path.join(coreRoot,'dist/chunks/credential-dajrwvna.js');
const ptyPackage=createRequire(path.join(coreRoot,'package.json')).resolve('@opencode-ai/pty-darwin-arm64/package.json');
const ptyBinary=path.join(path.dirname(ptyPackage),'bin/opencode-pty'),ptySha=hash(await fs.readFile(ptyBinary));
const photonFile=createRequire(path.join(coreRoot,'package.json')).resolve('@silvia-odwyer/photon-node');
const ptySource=rewriteNativeAsset('pty',await fs.readFile(ptyBinding),{assetPath:ptyBinary,assetSha256:ptySha});
const photonSource=rewriteNativeAsset('photon',await fs.readFile(photonFile));
const compactionFile=path.join(coreRoot,'dist/chunks/credential-nye1dag9.js');
const compaction=rewriteNativeCompactionObservation(await fs.readFile(compactionFile,'utf8'),path.join(host,'native-compaction-observation.ts'));
const rewrites=new Map([[ptyBinding,ptySource],[photonFile,photonSource],[compactionFile,compaction.contents]]);
for(const [file,contents] of rewrites) transforms.push({path:path.relative(repository,file),sha256:hash(await fs.readFile(file)),outputSha256:hash(contents),
  reason:file===ptyBinding?'compiled-dynamic-package-resolve-unavailable':file===compactionFile?'pinned-native-compaction-read-only-observation':'compiled-photon-source-wasm-read-denied'});
const plugin={name:'devryan-pinned-asset-resolvers',setup(builder){builder.onLoad({filter:/(credential-dajrwvna|credential-nye1dag9|photon_rs)\.js$/},event=>{const contents=rewrites.get(path.resolve(event.path));if(contents===undefined) throw new Error('Unexpected native asset resolver');return {contents,loader:'js'};});}};
const settings={target:'bun',minify:true,conditions:['bun'],sourcemap:'none',metafile:true,plugins:[plugin,reviewedNativeInputPlugin(reviewed)]};
const stage=await fs.mkdtemp(path.join(await fs.mkdir(path.dirname(output),{recursive:true}).then(()=>path.dirname(output)),'native-build-'));
try {
  // Inventory the actual linked graph before embedding its immutable identity.
  const definitions={DEVRYAN_NATIVE_BUILD_ID:JSON.stringify('0'.repeat(64)),DEVRYAN_HOST_DIGEST:JSON.stringify('0'.repeat(64)),DEVRYAN_REVIEWED_PLUGIN_ORIGINS:'[]',DEVRYAN_CORE_DIGEST:JSON.stringify(coreDigest)};
  const scans=await Promise.all([
    Bun.build({...settings,entrypoints:entries.map(([,entry])=>entry),outdir:path.join(stage,'inventory'),define:definitions}),
    Bun.build({...settings,target:'node',conditions:['node'],format:'esm',entrypoints:[configurationEntry],outdir:path.join(stage,'configuration-inventory'),define:definitions}),
  ]);
  for(const scan of scans) {
  if(!scan.success) throw new AggregateError(scan.logs,'Native graph inventory failed');
  for(const input of Object.keys(scan.metafile.inputs)) {
    if([...reviewed.virtualModules.keys()].some(id=>input===`devryan-reviewed:${id}`))continue;
    const absolute=await fs.realpath(path.resolve(repository,input));
    if(!absolute.startsWith(repository+path.sep)) throw new Error('Native graph escaped repository');
    loaded.set(absolute,hash(await fs.readFile(absolute)));
  }
  }
  const linkedFiles=new Map(loaded);
  for(const [file,digest] of reviewed.inputFiles)loaded.set(file,digest);
  transforms.push(...reviewed.transforms);
  const reviewedPlugins=[];
  for(const [id,file,capabilities] of [
    ['devryan.managed-task','managed-task.ts',['managed-task']],
    ['devryan.council','council.ts',['managed-task']],
    ['devryan.reviewed-skills','native-skills.ts',['read']],
    ['devryan.configured-instructions','native-configured-instructions.ts',['control']],
    ['devryan.harness-context','native-session-context.ts',['control']],
    ['devryan.browser','native-browser-plugin.ts',['process']],
    ['devryan.document-reader','native-document-plugin.ts',['read']],
    ['devryan.slim','native-slim-runtime.ts',['read','write','process','network','control']],
    ['devryan.slim-commands','native-slim-commands.ts',['control']],
    ['devryan.slim-lifecycle','native-slim-runtime.ts',['control']],
    ['devryan.ponytail','native-ponytail.js',['control']],
    ['devryan.provider-compat','native-provider-compat-plugin.ts',['provider']],
    ['opencode-gpt-imagegen','native-imagegen-plugin.ts',['write','network']],
  ]){
    const absolute=path.join(host,file),manifestDigest=hash(await fs.readFile(absolute));
    loaded.set(absolute,manifestDigest);reviewedPlugins.push({id,manifestDigest,capabilities});
  }
  const hostDigest=hash(JSON.stringify([...linkedFiles].filter(([file])=>file.startsWith(host+path.sep))
    .map(([file,sha256])=>({path:path.relative(host,file),sha256})).sort((a,b)=>a.path.localeCompare(b.path))));
  coreDigest=hash(JSON.stringify([...loaded].filter(([file])=>file.startsWith(coreRoot+path.sep)).map(([file,sha256])=>({path:path.relative(coreRoot,file),sha256})).sort((a,b)=>a.path.localeCompare(b.path))));
  const sourceFiles=[...loaded].map(([file,sha256])=>({path:path.relative(repository,file),sha256})).sort((a,b)=>a.path.localeCompare(b.path));
  const packageRoots=new Map(),directoryOwners=new Map();
  for(const file of loaded.keys()) {
    let directory=path.dirname(file),root=directoryOwners.get(directory);
    const traversed=[];
    while(!root&&directory.startsWith(repository+path.sep)) {
      traversed.push(directory);
      try {const info=JSON.parse(await fs.readFile(path.join(directory,'package.json'),'utf8'));if(info.name&&info.version){root=directory;packageRoots.set(root,info);break;}} catch {}
      directory=path.dirname(directory);
    }
    for(const directory of traversed) directoryOwners.set(directory,root);
  }
  const resolvedPackages=[];
  for(const [root,info] of packageRoots) {
    const files=sourceFiles.filter(row=>path.join(repository,row.path).startsWith(root+path.sep));
    const tuple=Object.values(lock.packages??{}).find(tuple=>Array.isArray(tuple)&&tuple[0]===`${info.name}@${info.version}`);
    const integrity=Array.isArray(tuple)?tuple.find(value=>typeof value==='string'&&value.startsWith('sha512-')):undefined;
    resolvedPackages.push({name:info.name,version:info.version,integrity:integrity??`source-sha256:${hash(JSON.stringify(files))}`,packageJsonSha256:hash(await fs.readFile(path.join(root,'package.json'))),treeSha256:hash(JSON.stringify(files))});
  }
  resolvedPackages.sort((a,b)=>a.name.localeCompare(b.name)||a.version.localeCompare(b.version));
  const inputs={buildSources,lockSha256:hash(lockBytes),coreDigest,hostDigest,sourceFiles,resolvedPackages,
    reviewedInputProvenance:reviewed.provenance,
    nativeRegistrations:[...createReviewedNativePluginRegistry(coreDigest,{hostDigest}).values()].map(({id,manifestDigest,capabilities})=>({id,manifestDigest,capabilities})),reviewedPlugins,transforms};
  const identity={bunVersion:Bun.version,bunRevision:Bun.revision,opencodeVersion:'2.0.20',target:'bun-darwin-arm64',compiledContracts:[NATIVE_BUNDLE_CREDENTIAL_CONTRACT,CLAUDE_LIFECYCLE_PROTOCOL,'devryan-v2-clone/1','devryan.primary-step-stop/1','devryan.bundle.credential-owners/2'],inputs};
  const buildId=hash(JSON.stringify(identity));
  const files=[];
  const configurationFilename='DevRyan-native-configuration.mjs';
  const configuration=await Bun.build({...settings,target:'node',conditions:['node'],format:'esm',entrypoints:[configurationEntry],
    outdir:stage,naming:{entry:configurationFilename},define:{DEVRYAN_NATIVE_BUILD_ID:JSON.stringify(buildId)}});
  if(!configuration.success)throw new AggregateError(configuration.logs,'Reviewed configuration compile failed');
  const configurationOutput=path.join(stage,configurationFilename);
  await fs.writeFile(configurationOutput,rewriteSealedNodeRequire(await fs.readFile(configurationOutput,'utf8')));
  const configurationBytes=await fs.readFile(configurationOutput);
  await fs.chmod(path.join(stage,configurationFilename),0o644);
  files.push({role:'asset',path:configurationFilename,size:configurationBytes.length,sha256:hash(configurationBytes),mode:0o644,signing:{mode:'unsigned',verified:false}});
  const credentialAsset=reviewed.claudeCredentials;
  if(hash(credentialAsset.contents)!==credentialAsset.sha256)throw new Error('Reviewed Claude credential module changed');
  await fs.writeFile(path.join(stage,credentialAsset.path),credentialAsset.contents,{mode:credentialAsset.mode});
  files.push({role:'asset',path:credentialAsset.path,size:Buffer.byteLength(credentialAsset.contents),sha256:credentialAsset.sha256,mode:credentialAsset.mode,signing:{mode:'unsigned',verified:false}});
  for(const [role,entry] of entries) {
    const filename=`DevRyan-native-${role}`,destination=path.join(stage,filename);
    const result=await Bun.build({...settings,entrypoints:[entry],compile:{target:'bun-darwin-arm64',outfile:destination,autoloadDotenv:false,autoloadBunfig:false,autoloadTsconfig:false,autoloadPackageJson:false},
      define:{DEVRYAN_NATIVE_BUILD_ID:JSON.stringify(buildId),DEVRYAN_HOST_DIGEST:JSON.stringify(hostDigest),DEVRYAN_REVIEWED_PLUGIN_ORIGINS:JSON.stringify(reviewedPlugins),DEVRYAN_CORE_DIGEST:JSON.stringify(coreDigest)}});
    if(!result.success) throw new AggregateError(result.logs,`Native ${role} compile failed`);
    await fs.chmod(destination,0o755);
    // Bun's appended executable payload invalidates its template signature.
    // These development artifacts are explicitly ad-hoc; release signing is a separate existing release gate.
    const sign=spawnSync('/usr/bin/codesign',['--force','--sign','-',destination],{encoding:'utf8'});
    if(sign.status!==0) throw new Error('Compiled native ad-hoc signing failed: '+sign.stderr);
    const inspect=spawnSync('/usr/bin/codesign',['-d','--verbose=4',destination],{encoding:'utf8'});
    let signing={mode:'unsigned',verified:false};
    if(inspect.status===0) {
      const verified=spawnSync('/usr/bin/codesign',['--verify','--strict',destination],{encoding:'utf8'});
      if(verified.status!==0) throw new Error('Compiled native signature invalid: '+verified.stderr);
      const cdhash=/^CDHash=(.+)$/m.exec(inspect.stderr)?.[1],teamID=/^TeamIdentifier=(.+)$/m.exec(inspect.stderr)?.[1];
      signing={mode:teamID&&teamID!=='not set'?'release':'adhoc',verified:true,cdhash,...(teamID&&teamID!=='not set'?{teamID}:{})};
    } else if(!inspect.stderr.includes('not signed')) throw new Error('Compiled native signing state unavailable');
    const bytes=await fs.readFile(destination);files.push({role,path:filename,size:bytes.length,sha256:hash(bytes),mode:0o755,signing});
  }
  for(const [file,digest] of loaded) if(hash(await fs.readFile(file))!==digest) throw new Error('Native build source changed');
  for(const source of buildSources)if(hash(await fs.readFile(path.join(repository,source.path)))!==source.sha256)throw new Error('Native build helper changed');
  if(hash(await fs.readFile(path.join(repository,'bun.lock')))!==hash(lockBytes))throw new Error('Native build lock changed');
  const astDestination=path.join(stage,reviewed.ast.path);
  await fs.copyFile(reviewed.ast.source,astDestination);await fs.chmod(astDestination,0o755);
  const astBytes=await fs.readFile(astDestination);
  if(hash(astBytes)!==reviewed.ast.sha256)throw new Error('Copied AST asset changed');
  const astInfo=spawnSync('/usr/bin/codesign',['-d','--verbose=4',astDestination],{encoding:'utf8'});
  const astVerify=spawnSync('/usr/bin/codesign',['--verify','--strict',astDestination],{encoding:'utf8'});
  if(astInfo.status!==0||astVerify.status!==0)throw new Error('Reviewed AST asset signature invalid');
  files.push({role:'asset',path:reviewed.ast.path,size:astBytes.length,sha256:reviewed.ast.sha256,mode:0o755,
    signing:{mode:'adhoc',verified:true,cdhash:/^CDHash=(.+)$/m.exec(astInfo.stderr)?.[1]}});
  for(const asset of Object.values(reviewed.claudeAssets)){
    const destination=path.join(stage,asset.path);await fs.copyFile(asset.source,destination);await fs.chmod(destination,asset.mode);
    const bytes=await fs.readFile(destination);if(hash(bytes)!==asset.sha256)throw new Error('Copied Claude asset changed');
    const info=spawnSync('/usr/bin/codesign',['-d','--verbose=4',destination],{encoding:'utf8'});
    const verified=spawnSync('/usr/bin/codesign',['--verify','--strict',destination],{encoding:'utf8'});
    if(info.status!==0||verified.status!==0)throw new Error('Reviewed Claude asset signature invalid');
    const teamID=/^TeamIdentifier=(.+)$/m.exec(info.stderr)?.[1];
    files.push({role:'asset',path:asset.path,size:bytes.length,sha256:asset.sha256,mode:asset.mode,
      signing:{mode:teamID&&teamID!=='not set'?'release':'adhoc',verified:true,cdhash:/^CDHash=(.+)$/m.exec(info.stderr)?.[1],...(teamID&&teamID!=='not set'?{teamID}:{})}});
  }
  // Explicit qualification outputs retain the accepted supervisor. A clean
  // production build compiles and verifies that same confined launcher owner.
  const launcher='DevRyan-execution-darwin-arm64';
  const launcherSource=path.join(repository,'packages/web/runtime/darwin-arm64');
  const haveLauncher=await fs.lstat(path.join(launcherSource,launcher+'.json')).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
  if(!haveLauncher){
    const built=spawnSync(process.execPath,['scripts/build-session-execution.mjs',stage,'--verify'],{cwd:repository,encoding:'utf8',maxBuffer:4*1024*1024});
    if(built.error||built.status!==0)throw built.error??new Error('Confined launcher acceptance failed: '+built.stderr);
    for(const filename of [launcher,launcher+'-spawn.dylib']){
      const sign=spawnSync('/usr/bin/codesign',['--force','--sign','-',path.join(stage,filename)],{encoding:'utf8'});
      if(sign.status!==0)throw new Error('Confined launcher signing failed: '+sign.stderr);
    }
    const policyPath=path.join(stage,launcher+'.json'),policy=JSON.parse(await fs.readFile(policyPath,'utf8'));
    policy.sha256=hash(await fs.readFile(path.join(stage,launcher)));policy.spawnSha256=hash(await fs.readFile(path.join(stage,policy.spawnLibrary)));
    await fs.writeFile(policyPath,JSON.stringify(policy,null,2)+'\n');
  }
  for(const filename of [launcher,`${launcher}.json`,`${launcher}-spawn.dylib`]) {
    const target=path.join(stage,filename);if(haveLauncher)await fs.copyFile(path.join(launcherSource,filename),target);
    const stat=await fs.stat(target),bytes=await fs.readFile(target);
    let signing={mode:'unsigned',verified:false};
    if(!filename.endsWith('.json')) {
      const info=spawnSync('/usr/bin/codesign',['-d','--verbose=4',target],{encoding:'utf8'});
      const verify=spawnSync('/usr/bin/codesign',['--verify','--strict',target],{encoding:'utf8'});
      if(info.status!==0||verify.status!==0) throw new Error('Accepted launcher asset signature invalid');
      signing={mode:'adhoc',verified:true,cdhash:/^CDHash=(.+)$/m.exec(info.stderr)?.[1]};
    }
    files.push({role:'asset',path:filename,size:bytes.length,sha256:hash(bytes),mode:stat.mode&0o777,signing});
  }
  const manifest={schema:1,buildId,...identity,files,acceptedLauncher:{path:launcher}};
  await fs.writeFile(path.join(stage,'native-bundle.json'),JSON.stringify(manifest,null,2)+'\n');
  await fs.rm(path.join(stage,'inventory'),{recursive:true,force:true});
  await fs.rm(path.join(stage,'configuration-inventory'),{recursive:true,force:true});
  const {verifyNativeRuntimeArtifacts}=await import('../packages/web/server/lib/opencode/runtime-host/native-artifacts.js');
  await verifyNativeRuntimeArtifacts({manifestPath:path.join(stage,'native-bundle.json'),manifestSha256:hash(await fs.readFile(path.join(stage,'native-bundle.json'))),launcher:path.join(stage,launcher)});
  if(replaceProduction){
    const previous=output+`.previous-${process.pid}`;
    const exists=await fs.lstat(output).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
    if(exists && (await fs.realpath(output)!==output || !(await fs.lstat(output)).isDirectory()))throw new Error('Production artifact root is not canonical');
    if(exists)await fs.rename(output,previous);
    try{await fs.rename(stage,output);}catch(error){if(exists)await fs.rename(previous,output);throw error;}
    if(exists)await fs.rm(previous,{recursive:true});
  }else{
    try {await fs.lstat(output);throw new Error('Output root already exists');}catch(error){if(error.code!=='ENOENT')throw error;}
    await fs.rename(stage,output);
  }
  process.stdout.write(JSON.stringify({output,buildId,manifestSha256:hash(await fs.readFile(path.join(output,'native-bundle.json'))),files:files.map(({path,sha256})=>({path,sha256}))})+'\n');
} catch(error) {await fs.rm(stage,{recursive:true,force:true});throw error;}
