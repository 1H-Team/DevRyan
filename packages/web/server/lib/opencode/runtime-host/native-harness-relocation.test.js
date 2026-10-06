import {afterEach,expect,test} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {runNativeHarnessRelocationProcess,validateNativeGitConfig} from './native-harness-relocation.js';
import {runNativeMigrationProcess} from './native-migration-process.js';
import {parseNativeHarnessRequest,parseNativeHarnessResult} from './native-process-protocol.js';
import {createOwnedGitRunner,git} from '../../../../../harness-runtime/lib/session-changes-git.js';
import {openChangeStore,changeKey} from '../../../../../harness-runtime/lib/session-changes-store.js';
import {inspectBundleHarness} from './bundle-harness-integrity.js';
const roots=[];
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
async function fixture(){const parent=path.resolve('../../.cache/test-fixtures');await fs.mkdir(parent,{recursive:true});const root=await fs.mkdtemp(path.join(parent,'native-relocation-'));roots.push(root);return root;}
const digest='a'.repeat(64),gitDigest='b'.repeat(64);
const request=root=>({protocol:'devryan-native-harness-relocation/1',requestID:'harness_test',webDataDirectory:path.join(root,'web'),sourceWebDataDirectory:path.join(root,'source'),checkpointID:'test',projectMap:[],relocate:false});
function ownedFixture(root){
 const binary=path.join(root,'artifacts','DevRyan-native-controller.exe'),events=[];let held=false,options,wire;
 const owner={ensureDirectory:async()=>{},createDirectory:async()=>{},largeFile:async file=>({token:`file:1:${file===binary?digest:gitDigest}`}),tree:async()=> 'tree:1:held',read:async()=>({bytes:Buffer.from(JSON.stringify(wire))}),removeTree:async()=>events.push('remove-environment'),
  beginNativeImport:input=>{options=input;return {ready:Promise.resolve().then(()=>{held=true;events.push('ready');}),assertHeld:()=>{expect(held).toBe(true);events.push('assert');},writeRequest:async()=>events.push('request'),cancel:async()=>{events.push('cancel');held=false;},finish:async()=>{
   events.push('finish');wire={nonce:options.nonce,controllerToken:`file:1:${digest}`,gitToken:`file:1:${gitDigest}`,environmentToken:'tree:1:environment',operation:options.operation,rootExclusions:options.rootExclusions,mutating:options.mutating,jobSettled:true,namespaceFlushed:true,exitCode:0,rootToken:'tree:1:held'};held=false;
   return {receipt:wire,stdout:Buffer.from(JSON.stringify({protocol:'devryan-native-harness-relocation/1',requestID:'harness_test',status:'inspected',harness:{refs:[],sessionReferences:[],messageReferences:[]}})),stderr:Buffer.alloc(0)};
  }};}};
 const verify=async()=>{expect(held).toBe(true);events.push('verify');return {controller:binary,directory:path.dirname(binary),manifest:{files:[{path:path.basename(binary),role:'controller',sha256:digest}]},reviewedGit:{path:path.join(path.dirname(binary),'git','cmd','git.exe'),sha256:gitDigest}};};
 return {binary,owner,events,verify};
}
test('held verifier binds accepted controller and Git before request and retires exact environment after settlement',async()=>{
 const root=await fixture(),f=ownedFixture(root);
 await expect(runNativeHarnessRelocationProcess({binary:f.binary,controlRoot:root,windowsOwner:f.owner,request:request(root),beforeSpawn:f.verify})).resolves.toEqual({refs:[],sessionReferences:[],messageReferences:[]});
 expect(f.events).toEqual(['ready','assert','verify','assert','request','finish','remove-environment']);
});
test.each(['verifier-refused','controller-changed','git-changed'])('failed held verification never sends child request: %s',async defect=>{
 const root=await fixture(),f=ownedFixture(root),verify=async()=>{const value=await f.verify();if(defect==='verifier-refused')throw Error('rejected-accepted-manifest');if(defect==='controller-changed')value.manifest.files[0].sha256='c'.repeat(64);else value.reviewedGit.sha256='c'.repeat(64);return value;};
 await expect(runNativeHarnessRelocationProcess({binary:f.binary,controlRoot:root,windowsOwner:f.owner,request:request(root),beforeSpawn:verify})).rejects.toThrow();expect(f.events).toEqual(['ready','assert','verify','cancel']);
});
test.each(['missing-receipt','wrong-root','wrong-git','unsettled','unflushed','nonzero'])('lost or altered native settlement stays refused: %s',async defect=>{
 const root=await fixture(),f=ownedFixture(root),begin=f.owner.beginNativeImport;
 f.owner.beginNativeImport=input=>{const lease=begin(input),finish=lease.finish;lease.finish=async()=>{const result=await finish();if(defect==='missing-receipt')delete result.receipt;else if(defect==='wrong-root')result.receipt.rootToken='tree:1:foreign';else if(defect==='wrong-git')result.receipt.gitToken='file:1:foreign';else if(defect==='unsettled')result.receipt.jobSettled=false;else if(defect==='unflushed')result.receipt.namespaceFlushed=false;else result.receipt.exitCode=1;return result;};return lease;};
 await expect(runNativeHarnessRelocationProcess({binary:f.binary,controlRoot:root,windowsOwner:f.owner,request:request(root),beforeSpawn:f.verify})).rejects.toMatchObject({code:'native_harness_settlement_unconfirmed'});
 expect(f.events).toEqual(['ready','assert','verify','assert','request','finish','cancel']);
});
test('ordinary Windows migration verifies under ownership and refuses before child creation',async()=>{
 const root=await fixture(),f=ownedFixture(root),candidate=path.join(root,'bundles','candidate');await fs.mkdir(path.dirname(f.binary),{recursive:true});await fs.writeFile(f.binary,'fixture');
 const input={protocol:'devryan-native-migration/1',requestID:'migrate_test',bundleID:'candidate',isolatedRoot:path.join(candidate,'global'),candidateDatabasePath:path.join(candidate,'opencode','opencode.db'),receiptPath:path.join(candidate,'sources','migration.json'),auxiliary:{kind:'absent'},projectMap:[]};
 await expect(runNativeMigrationProcess({binary:f.binary,cwd:root,environment:{},windowsOwner:f.owner,request:input,beforeSpawn:async()=>{await f.verify();throw Error('accepted-manifest-rejected');}})).rejects.toThrow('accepted-manifest-rejected');expect(f.events).toEqual(['ready','assert','verify','cancel']);
});
test('config parser allows generated bare metadata and refuses executable or external configuration',()=>{
 const valid='core.repositoryformatversion\n0\0core.filemode\nfalse\0core.bare\ntrue\0';expect(()=>validateNativeGitConfig(Buffer.from(valid))).not.toThrow();
 for(const extra of ['include.path\nC:/foreign\0','includeif.gitdir:x.path\nforeign\0','core.hookspath\nforeign\0','core.fsmonitor\nforeign\0','extensions.worktreeconfig\ntrue\0','filter.x.clean\ncommand\0','core.repositoryformatversion\n0\0'])expect(()=>validateNativeGitConfig(Buffer.from(valid+extra))).toThrow('native_harness_git_config_unsupported');
 expect(()=>validateNativeGitConfig(Buffer.from(valid.replace('core.bare\ntrue','core.bare\nfalse')))).toThrow();expect(()=>validateNativeGitConfig(Buffer.from(valid+'extensions.objectformat\nsha256\0'))).toThrow();
});
test('wire rejects authority overrides, duplicate references and foreign result binding',async()=>{
 const root=await fixture(),input=request(root);expect(parseNativeHarnessRequest(input)).toEqual(input);
 for(const changed of [{...input,gitBinary:'/ambient/git'},{...input,webDataDirectory:root+'/x/../web'},{...input,sessionIDs:['ses_x','ses_x']},{...input,checkpointID:'../escape'}])expect(()=>parseNativeHarnessRequest(changed)).toThrow();
 expect(()=>parseNativeHarnessResult({protocol:input.protocol,requestID:'foreign',status:'inspected',harness:{refs:[],sessionReferences:[],messageReferences:[]}},input)).toThrow();
});
test('owned Git seam preserves state, lease refs, archived objects and metadata through project relocation',async()=>{
 const root=await fixture(),web=path.join(root,'web'),source=path.join(root,'project'),target=path.join(root,'moved'),storage=path.join(web,'harness','session-mutations',changeKey(source)),gitDir=path.join(storage,'git');await fs.mkdir(storage,{recursive:true});await git(storage,['init','--bare','--quiet',gitDir]);
 const commands=[],runner=createOwnedGitRunner({binary:'/usr/bin/git',environment:{PATH:'/usr/bin:/bin',HOME:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null'},argumentsPrefix:['--no-pager','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false'],assertAllowed:(cwd,args)=>{commands.push(args);expect(path.dirname(cwd)).toBe(path.dirname(storage));expect(args.slice(0,2)).toEqual(['--git-dir',path.join(cwd,'git')]);}});
 const state=await openChangeStore(storage,gitDir,{gitRunner:runner});state.set('meta.json',{version:1,directory:source,sequence:7});state.set('operations/history.json',{directory:source,payload:{retained:'all-fields'}});await state.commit();const lease='refs/devryan/leases/10000000-0000-4000-8000-000000000001';await runner.git(storage,['--git-dir',gitDir,'update-ref',lease,state.tree]);
 const original=state.tree,config=await fs.readFile(path.join(gitDir,'config')),inventory=await inspectBundleHarness(web,{gitRunner:runner});expect((await runner.git(storage,['--git-dir',gitDir,'rev-parse','refs/devryan/state'])).toString().trim()).toBe(original);
 await inspectBundleHarness(web,{gitRunner:runner,relocate:true,checkpointID:'owned',projectMap:[{sourceDirectory:source,targetDirectory:target,mode:'synthetic-copy'}]});const moved=path.join(path.dirname(storage),changeKey(target)),movedGit=path.join(moved,'git');expect(await fs.readFile(path.join(movedGit,'config'))).toEqual(config);
 const after=await openChangeStore(moved,movedGit,{gitRunner:runner});expect(await after.get('operations/history.json')).toEqual({directory:target,payload:{retained:'all-fields'}});for(const ref of inventory.refs)expect((await runner.git(moved,['--git-dir',movedGit,'rev-parse',`refs/devryan/migration/owned/${ref.ref.slice('refs/devryan/'.length)}`])).toString().trim()).toBe(ref.oid);
 const leaseStore=await openChangeStore(moved,movedGit,{ref:lease,gitRunner:runner});expect(await leaseStore.get('operations/history.json')).toEqual({directory:target,payload:{retained:'all-fields'}});expect(commands.some(args=>args.includes('cat-file'))).toBe(true);expect(commands.some(args=>args.includes('update-index'))).toBe(true);await expect(git(moved,['--git-dir',movedGit,'rev-parse','HEAD'],{ownedRunner:{}})).rejects.toMatchObject({code:'owned_git_runner_invalid'});
});
