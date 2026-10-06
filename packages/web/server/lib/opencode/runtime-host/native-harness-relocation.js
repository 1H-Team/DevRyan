import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {createOwnedGitRunner} from '../../../../../harness-runtime/lib/session-changes-git.js';
import {isWindowsPrivateControlName} from '../../../../../harness-runtime/lib/windows-private-files.js';
import {inspectBundleHarness} from './bundle-harness-integrity.js';
import {verifyNativeImportChild} from './native-migration-files.js';
import {parseNativeHarnessRequest,parseNativeHarnessResult,NATIVE_PROCESS_LIMITS,NATIVE_HARNESS_LIMITS} from './native-process-protocol.js';
import {canonicalJSON,sha256,bundleFailure,containsPath} from './bundle-migration-inventory.js';
import {BUNDLE_DOCUMENT_MAX_BYTES} from './bundle-document-limits.js';

const fail=code=>{throw bundleFailure(code);};
const metadata = new Set(['core.repositoryformatversion','core.filemode','core.bare','core.logallrefupdates','core.ignorecase','core.precomposeunicode','extensions.objectformat']);
export function validateNativeGitConfig(bytes){
 const rows=bytes.toString('utf8').split('\0');if(rows.pop()!=='')fail('native_harness_git_config_unsupported');
 const values=new Map();
 for(const row of rows){const split=row.indexOf('\n'),key=row.slice(0,split),value=row.slice(split+1);
  if(split<1||!metadata.has(key)||values.has(key))fail('native_harness_git_config_unsupported');
  if(key==='core.repositoryformatversion'?!['0','1'].includes(value):key==='extensions.objectformat'?!['sha1','sha256'].includes(value):!['true','false'].includes(value))fail('native_harness_git_config_unsupported');
  values.set(key,value);
 }
 if(values.get('core.bare')!=='true'||!values.has('core.repositoryformatversion'))fail('native_harness_git_config_unsupported');
 if(values.get('extensions.objectformat')==='sha256'&&values.get('core.repositoryformatversion')!=='1')fail('native_harness_git_config_unsupported');
}
const privateJSON=async file=>{
 const handle=await fs.open(file,'r');try{const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>BUNDLE_DOCUMENT_MAX_BYTES)fail('bundle_document_invalid');
  const bytes=await handle.readFile();if(bytes.length!==stat.size)fail('bundle_document_invalid');return {bytes,value:JSON.parse(bytes.toString('utf8'))};
 }finally{await handle.close();}
};
function fixedFiles(root,mutating){
 const renames=[];
 const relative=file=>{if(!containsPath(root,file)||path.normalize(file)!==file)fail('native_harness_write_scope_invalid');return path.relative(root,file).split(path.sep).join('/');};
 const writable=file=>{const name=relative(file);if(!mutating||!(name==='orchestration/ledger.json'
  ||/^harness\/(provider-recovery|context)\/[A-Za-z0-9_-]+\.json$/.test(name)
  ||/^harness\/evidence\/records\/[A-Za-z0-9_-]+\.json$/.test(name)))fail('native_harness_write_scope_invalid');};
 return {
  readJSON:async file=>{relative(file);return (await privateJSON(file)).value;},
  readEnvelope:async file=>{relative(file);return (await privateJSON(file)).bytes;},
  saveJSON:async(file,value)=>{
   writable(file);const bytes=Buffer.from(canonicalJSON(value)+'\n');if(bytes.length>BUNDLE_DOCUMENT_MAX_BYTES)fail('bundle_document_too_large');
   const temporary=path.join(path.dirname(file),'.'+path.basename(file)+'.tmp-'+randomBytes(16).toString('hex'));
   const handle=await fs.open(temporary,'wx');try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
   await fs.rename(temporary,file);return sha256(bytes);
  },
  deleteFile:async file=>{writable(file);await fs.unlink(file);},
  renameDirectory:async(source,target)=>{
   if(!mutating||![source,target].every(file=>/^harness\/session-mutations\/[a-f0-9]{64}$/.test(relative(file))))fail('native_harness_write_scope_invalid');
   await fs.rename(source,target);renames.push({source,target});
  },
  // The outer native job flushes objects AND refs before any success is accepted.
  // No Node directory fsync is substituted for that Windows durability proof.
  deferObjectDurability:async directory=>{if(!mutating||!/^harness\/session-mutations\/[a-f0-9]{64}$/.test(relative(directory)))fail('native_harness_write_scope_invalid');},
  rebasedPath:file=>{for(const {source,target}of renames)if(containsPath(source,file))file=path.join(target,path.relative(source,file));return file;},
 };
}
async function fixedGit(root,mutating){
 const artifactRoot=path.dirname(process.execPath),gitRoot=path.join(artifactRoot,'git'),binary=path.join(gitRoot,'cmd','git.exe');
 const environment={SystemRoot:process.env.SystemRoot,SYSTEMROOT:process.env.SYSTEMROOT,WINDIR:process.env.WINDIR,
  HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE,TMP:process.env.TMP,TEMP:process.env.TEMP,TMPDIR:process.env.TMPDIR,
  GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_SYSTEM:'NUL',GIT_CONFIG_GLOBAL:'NUL',GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1',
  GIT_EXEC_PATH:path.join(gitRoot,process.arch==='arm64'?'clangarm64':'ucrt64','bin')};
 const argumentsPrefix=['--no-pager','-c','core.hooksPath=NUL','-c','core.fsmonitor=false','-c','gc.auto=0','-c','maintenance.auto=false','-c','core.pager=false','-c','protocol.allow=never'];
 const configs=[];
 // Parse captured config as data outside its repository. The synthetic GIT_DIR
 // does not exist, so Git startup cannot load that repository's local includes.
 const parserHome=process.env.HOME;
 const parser=createOwnedGitRunner({binary,environment,argumentsPrefix:[...argumentsPrefix,`--git-dir=${path.join(parserHome,'config-parser-absent')}`],assertAllowed:(cwd,args)=>{
  if(cwd!==parserHome||args[0]!=='config'||args[1]!=='--no-includes'||args[2]!=='--file'
   ||!containsPath(path.join(root,'harness','session-mutations'),args[3])||path.basename(args[3])!=='config'
   ||args[4]!=='--null'||args[5]!=='--list'||args.length!==6)fail('native_harness_git_scope_invalid');
 }});
 const runner=createOwnedGitRunner({binary,environment,argumentsPrefix,assertAllowed:(cwd,args,{env})=>{
  const prefix=path.join(root,'harness','session-mutations')+path.sep;
  if(!cwd.startsWith(prefix)||!/^[a-f0-9]{64}$/.test(path.relative(prefix,cwd))||args[0]!=='--git-dir'||args[1]!==path.join(cwd,'git'))fail('native_harness_git_scope_invalid');
  const rest=args.slice(2),command=rest[0]==='--literal-pathspecs'?rest[1]:rest[0];
  if(!(mutating?['for-each-ref','rev-parse','ls-tree','cat-file','read-tree','hash-object','update-index','write-tree','update-ref']:['for-each-ref','rev-parse','ls-tree','cat-file']).includes(command))fail('native_harness_git_scope_invalid');
  if(env&&Object.keys(env).some(key=>key!=='GIT_INDEX_FILE'))fail('native_harness_git_scope_invalid');
  if(env?.GIT_INDEX_FILE&&(!containsPath(cwd,env.GIT_INDEX_FILE)||path.dirname(env.GIT_INDEX_FILE)!==cwd||!/^[-a-f0-9]{36}\.metadata-index$/.test(path.basename(env.GIT_INDEX_FILE))))fail('native_harness_git_scope_invalid');
 }});
 const storage=path.join(root,'harness','session-mutations');
 for(const entry of await fs.readdir(storage,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;})){
  if(isWindowsPrivateControlName(entry.name))continue;
  if(!entry.isDirectory()||!/^[a-f0-9]{64}$/.test(entry.name))fail('bundle_harness_layout_invalid');
  const cwd=path.join(storage,entry.name),gitDirectory=path.join(cwd,'git'),config=path.join(gitDirectory,'config');
  for(const name of ['commondir','config.worktree','objects/info/alternates','objects/info/http-alternates','info/grafts']){
   try{await fs.lstat(path.join(gitDirectory,name));fail('native_harness_git_config_unsupported');}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  const stat=await fs.lstat(config);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)fail('native_harness_git_config_unsupported');
  const bytes=await fs.readFile(config);
  validateNativeGitConfig(await parser.git(parserHome,['config','--no-includes','--file',config,'--null','--list'],{limit:65536}));
  configs.push({file:config,sha256:sha256(bytes),ino:stat.ino,dev:stat.dev});
 }
 return {runner,recheck:async rebase=>{for(const row of configs){const file=rebase(row.file),stat=await fs.lstat(file);if(stat.isSymbolicLink()||stat.ino!==row.ino||stat.dev!==row.dev||stat.size>65536||sha256(await fs.readFile(file))!==row.sha256)fail('native_harness_git_config_changed');}}};
}

/** Fixed compiled mode only; the outer native job owns its entire write lifetime. */
export async function runNativeHarnessRelocation(input,nonce){
 const request=parseNativeHarnessRequest(input);
 await verifyNativeImportChild(nonce,{operation:'relocate-bundle-harness',root:request.webDataDirectory,rootExclusions:'runtime-bundle',mutating:request.relocate});
 const {runner,recheck}=await fixedGit(request.webDataDirectory,request.relocate),nativeFiles=fixedFiles(request.webDataDirectory,request.relocate);
 const {protocol,requestID,webDataDirectory,...options}=request;void protocol;
 const harness=await inspectBundleHarness(webDataDirectory,{...options,gitRunner:runner,nativeFiles});await recheck(nativeFiles.rebasedPath);
 return parseNativeHarnessResult({protocol:'devryan-native-harness-relocation/1',requestID,status:request.relocate?'relocated':'inspected',harness},request);
}

/** Node host owns immutable artifacts, exact output root, receipt and environment. */
export async function runNativeHarnessRelocationProcess({binary,controlRoot,windowsOwner,request:input,beforeSpawn}){
 const request=parseNativeHarnessRequest(input),nonce=randomBytes(16).toString('hex'),root=request.webDataDirectory;
 if(typeof windowsOwner?.beginNativeImport!=='function'||typeof beforeSpawn!=='function')fail('private_windows_storage_authority_unavailable');
 const gitPath=path.join(path.dirname(binary),'git','cmd','git.exe');
 const receiptParent=path.join(controlRoot,'native-import-receipts'),environmentParent=path.join(controlRoot,'native-import-homes');
 await windowsOwner.ensureDirectory(receiptParent);await windowsOwner.ensureDirectory(environmentParent);
 const environmentRoot=path.join(environmentParent,nonce);await windowsOwner.createDirectory(environmentRoot);
 const controller=await windowsOwner.largeFile(binary),git=await windowsOwner.largeFile(gitPath),expectedArtifactToken=await windowsOwner.tree(path.dirname(binary));
 const expectedRootToken=await windowsOwner.tree(root,{exclusions:'runtime-bundle'}),nativeReceipt=path.join(receiptParent,nonce+'.json');
 const lease=windowsOwner.beginNativeImport({operation:'relocate-bundle-harness',rootExclusions:'runtime-bundle',mutating:request.relocate,environmentRoot,
  controller:binary,controllerSha256:controller.token.split(':')[2],root,expectedRootToken,expectedArtifactToken,nativeReceipt,nonce});
 try{
  await lease.ready;await lease.assertHeld();
  const verified=await beforeSpawn();
  const acceptedController=verified?.manifest?.files?.find(row=>row.role==='controller'&&path.resolve(verified.directory,row.path)===binary);
  if(verified?.controller!==binary||verified.directory!==path.dirname(binary)||acceptedController?.sha256!==controller.token.split(':')[2]
   ||verified.reviewedGit?.path!==gitPath||verified.reviewedGit.sha256!==git.token.split(':')[2])fail('native_harness_git_artifacts_unverified');
  await lease.assertHeld();await lease.writeRequest(Buffer.from(JSON.stringify(request)+'\n'));const result=await lease.finish();
  if(result.stdout.length>NATIVE_HARNESS_LIMITS.resultBytes||result.stderr.length>NATIVE_PROCESS_LIMITS.bootBytes)fail('native_harness_output_bound');
  const persisted=JSON.parse((await windowsOwner.read(nativeReceipt)).bytes.toString('utf8'));
  if(result.receipt?.nonce!==nonce||result.receipt.controllerToken!==controller.token||result.receipt.operation!=='relocate-bundle-harness'
   ||result.receipt.rootExclusions!=='runtime-bundle'||result.receipt.mutating!==request.relocate||result.receipt.gitToken!==git.token||typeof result.receipt.environmentToken!=='string'
   ||!result.receipt.jobSettled||!result.receipt.namespaceFlushed||result.receipt.exitCode!==0
   ||canonicalJSON(persisted)!==canonicalJSON(result.receipt)||result.receipt.rootToken!==await windowsOwner.tree(root,{exclusions:'runtime-bundle'})
   ||!request.relocate&&result.receipt.rootToken!==expectedRootToken)fail('native_harness_settlement_unconfirmed');
  const wire=parseNativeHarnessResult(JSON.parse(result.stdout.toString('utf8')),request);
  await windowsOwner.removeTree(environmentRoot,result.receipt.environmentToken);return wire.harness;
 }catch(error){try{await lease.cancel();}catch(cleanup){throw new AggregateError([error,cleanup],'Native harness relocation settlement failed');}throw error;}
}
