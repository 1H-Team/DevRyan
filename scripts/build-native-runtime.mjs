import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {rewriteNativeAsset,rewriteUnavailableNativePty,prepareReviewedNativeInputs,reviewedNativeInputPlugin,rewriteSealedNodeRequire} from './native-runtime-assets.mjs';
import {hydrateWindowsReviewedExecutables} from './build-windows-reviewed-executables.mjs';
import {hydrateWindowsGit} from './build-windows-git.mjs';
import {assertWindowsBinaryArchitecture,readWindowsReviewedLibsqlAsset} from './build-windows-reviewed-libsql.mjs';
import {createReviewedNativePluginRegistry} from '../packages/web/server/lib/opencode/runtime-host/native-plugin-registry.ts';
import {rewriteNativeCompactionObservation} from './native-compaction-observation-transform.mjs';
import {CLAUDE_LIFECYCLE_PROTOCOL} from '../packages/web/server/lib/opencode/runtime-host/native-claude-lifecycle.js';
import {NATIVE_BUNDLE_CREDENTIAL_CONTRACT} from '../packages/web/server/lib/opencode/runtime-host/native-bundle-credential-contract.js';

const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {parse:parseJsonc}=createRequire(path.join(repository,'packages/web/package.json'))('jsonc-parser');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const args=process.argv.slice(2),outputIndex=args.indexOf('--output-root');
const windowsCandidate=args.length===1&&args[0]==='--windows-candidate';
if(!(args.length===0 || (args.length===2&&args[0]==='--output-root'&&args[1]) || windowsCandidate))throw new Error('Owned output root required');
const productionOutput=path.join(repository,'packages/web/runtime',`${process.platform}-${process.arch}`);
const output=windowsCandidate?path.join(repository,'.cache/windows-native',process.arch,'runtime-candidate'):path.resolve(outputIndex<0?productionOutput:args[outputIndex+1]);
const replaceProduction=outputIndex<0&&!windowsCandidate;
if(!output.startsWith(repository+path.sep))throw new Error('Owned output root required');
if(Bun.version!=='1.3.14' || (windowsCandidate?process.platform!=='win32'||!['x64','arm64'].includes(process.arch):process.platform!=='darwin'||process.arch!=='arm64')) throw new Error('Native build requires pinned Bun 1.3.14 and a supported native host');
const target=`${process.platform}-${process.arch}`,compileTarget=windowsCandidate?`bun-windows-${process.arch}`:'bun-darwin-arm64';
const host=path.join(repository,'packages/web/server/lib/opencode/runtime-host');
const buildSources=await Promise.all(['scripts/build-native-runtime.mjs','scripts/native-runtime-assets.mjs',
  'scripts/native-compaction-observation-transform.mjs',
  'scripts/build-session-execution.mjs','scripts/verify-session-execution.mjs',
  'scripts/build-windows-reviewed-executables.mjs','scripts/build-windows-reviewed-libsql.mjs','scripts/build-windows-git.mjs',
  ...(windowsCandidate?['packages/harness-runtime/native/session-execution-windows.c']:[]),
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
const reviewed=await prepareReviewedNativeInputs(repository,{target});
let windowsGitResource;
if(windowsCandidate){
  windowsGitResource=await hydrateWindowsGit({repository,arch:process.arch,fetchImpl:async()=>{throw new Error('Pinned Windows Git must be qualified before compilation');}});
  for(const row of windowsGitResource.files)reviewed.inputFiles.set(path.join(windowsGitResource.directory,row.path.slice(4)),row.sha256);
  const {directory,assets}=await hydrateWindowsReviewedExecutables({repository,arch:process.arch,fetchImpl:async()=>{throw new Error('Windows reviewed inputs must be qualified before compilation');}});
  const ast=assets.find(asset=>asset.kind==='ast'),claude=assets.find(asset=>asset.kind==='claude');
  if(!ast||!claude)throw new Error('Windows reviewed input inventory incomplete');
  const libsql=await readWindowsReviewedLibsqlAsset({repository,arch:process.arch});
  reviewed.ast={source:path.join(directory,ast.path),path:ast.path,sha256:ast.sha256};
  reviewed.claudeAssets={claude:{source:path.join(directory,claude.path),path:claude.path,sha256:claude.sha256,version:claude.version,mode:0o755},libsql};
  for(const asset of [reviewed.ast,...Object.values(reviewed.claudeAssets)])reviewed.inputFiles.set(asset.source,asset.sha256);
  reviewed.inputFiles.set(libsql.evidencePath,libsql.evidenceSha256);
}
const entries=[['controller',path.join(host,'controller-entry.ts')],['writer',path.join(host,'writer-entry.ts')]];
const configurationEntry=path.join(host,'reviewed-configuration-entry.ts');
const ptyBinding=path.join(coreRoot,windowsCandidate?'dist/persistent-pty/binary.bun.js':'dist/chunks/credential-dajrwvna.js');
const photonFile=createRequire(path.join(coreRoot,'package.json')).resolve('@silvia-odwyer/photon-node');
let ptySource;
if(windowsCandidate)ptySource=rewriteUnavailableNativePty(await fs.readFile(ptyBinding));
else{
  const ptyPackage=createRequire(path.join(coreRoot,'package.json')).resolve('@opencode-ai/pty-darwin-arm64/package.json');
  const ptyBinary=path.join(path.dirname(ptyPackage),'bin/opencode-pty');
  ptySource=rewriteNativeAsset('pty',await fs.readFile(ptyBinding),{assetPath:ptyBinary,assetSha256:hash(await fs.readFile(ptyBinary))});
}
const photonSource=rewriteNativeAsset('photon',await fs.readFile(photonFile));
const compactionFile=path.join(coreRoot,'dist/chunks/credential-nye1dag9.js');
const compaction=rewriteNativeCompactionObservation(await fs.readFile(compactionFile,'utf8'),path.join(host,'native-compaction-observation.ts'));
const rewrites=new Map([[ptyBinding,ptySource],[photonFile,photonSource],[compactionFile,compaction.contents]]);
for(const [file,contents] of rewrites) transforms.push({path:path.relative(repository,file),sha256:hash(await fs.readFile(file)),outputSha256:hash(contents),
  reason:file===ptyBinding?(windowsCandidate?'windows-persistent-pty-unavailable':'compiled-dynamic-package-resolve-unavailable'):file===compactionFile?'pinned-native-compaction-read-only-observation':'compiled-photon-source-wasm-read-denied'});
const assetFilter=windowsCandidate?/(credential-nye1dag9|persistent-pty[\\/]binary\.bun|photon_rs)\.js$/:/(credential-dajrwvna|credential-nye1dag9|photon_rs)\.js$/;
const plugin={name:'devryan-pinned-asset-resolvers',setup(builder){builder.onLoad({filter:assetFilter},event=>{const contents=rewrites.get(path.resolve(event.path));if(contents===undefined) throw new Error('Unexpected native asset resolver');return {contents,loader:'js'};});}};
const settings={target:'bun',minify:true,conditions:['bun'],sourcemap:'none',metafile:true,plugins:[plugin,reviewedNativeInputPlugin(reviewed)]};
await fs.mkdir(path.dirname(output),{recursive:true});
// Windows keeps compiled executable handles open. Its unqualified output is
// created exclusively; only the last receipt can attest successful checks.
const stage=windowsCandidate?await fs.mkdir(output).then(()=>output):await fs.mkdtemp(path.join(path.dirname(output),'native-build-'));
let failureEvidence;
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
  const identity={bunVersion:Bun.version,bunRevision:Bun.revision,opencodeVersion:'2.0.20',target:`bun-${target}`,compiledContracts:[NATIVE_BUNDLE_CREDENTIAL_CONTRACT,CLAUDE_LIFECYCLE_PROTOCOL,'devryan-v2-clone/1','devryan.primary-step-stop/1','devryan.bundle.credential-owners/2'],inputs,
    ...(windowsGitResource?{windowsGit:windowsGitResource.windowsGit}:{})};
  const buildId=hash(JSON.stringify(identity));
  const files=[];
  if(windowsCandidate)failureEvidence={schema:1,status:'failed',admission:false,
    scope:'Failed native build/boot diagnostic only; no accepted launcher or runtime admission',
    buildId,...identity,files,bootProbes:[]};
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
    const filename=`DevRyan-native-${role}${windowsCandidate?'.exe':''}`,destination=path.join(stage,filename);
    const result=await Bun.build({...settings,entrypoints:[entry],compile:{target:compileTarget,outfile:destination,autoloadDotenv:false,autoloadBunfig:false,autoloadTsconfig:false,autoloadPackageJson:false},
      define:{DEVRYAN_NATIVE_BUILD_ID:JSON.stringify(buildId),DEVRYAN_HOST_DIGEST:JSON.stringify(hostDigest),DEVRYAN_REVIEWED_PLUGIN_ORIGINS:JSON.stringify(reviewedPlugins),DEVRYAN_CORE_DIGEST:JSON.stringify(coreDigest)}});
    if(!result.success) throw new AggregateError(result.logs,`Native ${role} compile failed`);
    await fs.chmod(destination,0o755);
    // Bun's appended executable payload invalidates its template signature.
    // These development artifacts are explicitly ad-hoc; release signing is a separate existing release gate.
    let signing={mode:'unsigned',verified:false};
    if(!windowsCandidate){
    const sign=spawnSync('/usr/bin/codesign',['--force','--sign','-',destination],{encoding:'utf8'});
    if(sign.status!==0) throw new Error('Compiled native ad-hoc signing failed: '+sign.stderr);
    const inspect=spawnSync('/usr/bin/codesign',['-d','--verbose=4',destination],{encoding:'utf8'});
    if(inspect.status===0) {
      const verified=spawnSync('/usr/bin/codesign',['--verify','--strict',destination],{encoding:'utf8'});
      if(verified.status!==0) throw new Error('Compiled native signature invalid: '+verified.stderr);
      const cdhash=/^CDHash=(.+)$/m.exec(inspect.stderr)?.[1],teamID=/^TeamIdentifier=(.+)$/m.exec(inspect.stderr)?.[1];
      signing={mode:teamID&&teamID!=='not set'?'release':'adhoc',verified:true,cdhash,...(teamID&&teamID!=='not set'?{teamID}:{})};
    } else if(!inspect.stderr.includes('not signed')) throw new Error('Compiled native signing state unavailable');
    }
    const bytes=await fs.readFile(destination);if(windowsCandidate)assertWindowsBinaryArchitecture(bytes,process.arch);
    files.push({role,path:filename,size:bytes.length,sha256:hash(bytes),mode:0o755,signing});
  }
  for(const [file,digest] of loaded) if(hash(await fs.readFile(file))!==digest) throw new Error('Native build source changed');
  for(const source of buildSources)if(hash(await fs.readFile(path.join(repository,source.path)))!==source.sha256)throw new Error('Native build helper changed');
  if(hash(await fs.readFile(path.join(repository,'bun.lock')))!==hash(lockBytes))throw new Error('Native build lock changed');
  const astDestination=path.join(stage,reviewed.ast.path);
  await fs.copyFile(reviewed.ast.source,astDestination);await fs.chmod(astDestination,0o755);
  const astBytes=await fs.readFile(astDestination);
  if(hash(astBytes)!==reviewed.ast.sha256)throw new Error('Copied AST asset changed');
  let astSigning={mode:'unsigned',verified:false};
  if(windowsCandidate)assertWindowsBinaryArchitecture(astBytes,process.arch);
  else{
  const astInfo=spawnSync('/usr/bin/codesign',['-d','--verbose=4',astDestination],{encoding:'utf8'});
  const astVerify=spawnSync('/usr/bin/codesign',['--verify','--strict',astDestination],{encoding:'utf8'});
  if(astInfo.status!==0||astVerify.status!==0)throw new Error('Reviewed AST asset signature invalid');
  astSigning={mode:'adhoc',verified:true,cdhash:/^CDHash=(.+)$/m.exec(astInfo.stderr)?.[1]};
  }
  files.push({role:'asset',path:reviewed.ast.path,size:astBytes.length,sha256:reviewed.ast.sha256,mode:0o755,signing:astSigning});
  for(const asset of Object.values(reviewed.claudeAssets)){
    const destination=path.join(stage,asset.path);await fs.copyFile(asset.source,destination);await fs.chmod(destination,asset.mode);
    const bytes=await fs.readFile(destination);if(hash(bytes)!==asset.sha256)throw new Error('Copied Claude asset changed');
    let signing={mode:'unsigned',verified:false};
    if(windowsCandidate)assertWindowsBinaryArchitecture(bytes,process.arch);
    else{
    const info=spawnSync('/usr/bin/codesign',['-d','--verbose=4',destination],{encoding:'utf8'});
    const verified=spawnSync('/usr/bin/codesign',['--verify','--strict',destination],{encoding:'utf8'});
    if(info.status!==0||verified.status!==0)throw new Error('Reviewed Claude asset signature invalid');
    const teamID=/^TeamIdentifier=(.+)$/m.exec(info.stderr)?.[1];
    signing={mode:teamID&&teamID!=='not set'?'release':'adhoc',verified:true,cdhash:/^CDHash=(.+)$/m.exec(info.stderr)?.[1],...(teamID&&teamID!=='not set'?{teamID}:{})};
    }
    files.push({role:'asset',path:asset.path,size:bytes.length,sha256:asset.sha256,mode:asset.mode,signing});
  }
  if(windowsCandidate){
    // Keep the entire official MinGit loader/runtime inventory and licenses.
    // Every byte is a manifest asset; no user's installed Git or PATH enters it.
    for(const row of windowsGitResource.files){
      const source=path.join(windowsGitResource.directory,row.path.slice(4)),destination=path.join(stage,row.path);
      await fs.mkdir(path.dirname(destination),{recursive:true});await fs.copyFile(source,destination);await fs.chmod(destination,row.mode);
      const bytes=await fs.readFile(destination);if(bytes.length!==row.size||hash(bytes)!==row.sha256)throw new Error('Copied pinned Windows Git asset changed');
      files.push({role:'asset',...row,signing:{mode:'unsigned',verified:false}});
    }
    // A candidate has no native-bundle.json or acceptedLauncher. Production
    // artifact verification continues to refuse these independently built files.
    await fs.rm(path.join(stage,'inventory'),{recursive:true});
    await fs.rm(path.join(stage,'configuration-inventory'),{recursive:true});
    const scratch=await fs.mkdtemp(path.join(stage,'boot-refusal-'));
    const bootRefusals=[];
    try{
      const env=Object.fromEntries(['PATH','SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT'].filter(key=>typeof process.env[key]==='string').map(key=>[key,process.env[key]]));
      Object.assign(env,{HOME:scratch,USERPROFILE:scratch,APPDATA:scratch,LOCALAPPDATA:scratch,TEMP:scratch,TMP:scratch,TMPDIR:scratch,NO_COLOR:'1'});
      for(const role of ['controller','writer']){
        const result=spawnSync(path.join(stage,`DevRyan-native-${role}.exe`),[],{input:'',cwd:scratch,env,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:65536});
        failureEvidence.bootProbes.push({role,exitCode:result.status,signal:result.signal,errorCode:result.error?.code??null,
          stdoutBytes:Buffer.byteLength(result.stdout??''),stderrBytes:Buffer.byteLength(result.stderr??''),
          stdoutSha256:hash(result.stdout??''),stderrSha256:hash(result.stderr??''),
          stderrSummary:(result.stderr??'').split(/\r?\n/).filter(line=>line.length<=400&&/^(?:[A-Za-z]*Error:|error:|\s*code:)/.test(line)).slice(0,8)});
        if(result.error||result.status!==1)throw new Error(`Windows ${role} boot refusal failed`);
        const reply=JSON.parse(result.stdout.trim());
        if(reply.ok!==false||reply.error?.code!==(role==='controller'?'native_boot_missing':undefined)||reply.error?.message!==(role==='controller'?'native_boot_missing':'native_worker_input_invalid'))throw new Error(`Windows ${role} boot refusal changed`);
        bootRefusals.push({role,status:'passed',exitCode:result.status,stdoutSha256:hash(result.stdout),stderrSha256:hash(result.stderr)});
      }
    }finally{await fs.rm(scratch,{recursive:true,force:true});}
    for(const [file,digest] of loaded)if(hash(await fs.readFile(file))!==digest)throw new Error('Native build source changed');
    for(const source of buildSources)if(hash(await fs.readFile(path.join(repository,source.path)))!==source.sha256)throw new Error('Native build helper changed');
    if(hash(await fs.readFile(path.join(repository,'bun.lock')))!==hash(lockBytes))throw new Error('Native build lock changed');
    const candidate={schema:1,status:'unqualified',admission:false,
      scope:'Native compilation, sealed resource identity and empty-input boot refusal only; no confinement, initialized controller/writer or runtime admission acceptance',
      buildId,...identity,files,bootRefusals};
    await fs.writeFile(path.join(stage,'native-candidate.json'),JSON.stringify(candidate,null,2)+'\n',{flag:'wx'});
    process.stdout.write(JSON.stringify({output,buildId,status:candidate.status,admission:false,candidateSha256:hash(await fs.readFile(path.join(output,'native-candidate.json')))})+'\n');
  }else{
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
  }
} catch(error) {
  if(windowsCandidate){
    // This exclusive output never becomes a production bundle. Preserve the
    // original failure even when compiled files cannot yet be moved/deleted.
    if(failureEvidence)await fs.writeFile(path.join(stage,'native-candidate-failure.json'),JSON.stringify(failureEvidence,null,2)+'\n',{flag:'wx'});
    process.stderr.write('Unqualified Windows failure evidence: '+stage+'\n');
  }else await fs.rm(stage,{recursive:true,force:true});
  throw error;
}
