import {test,expect,afterEach} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {pruneRetainedNativeArtifacts,retainNativeArtifacts} from './retained-native-artifacts.js';
const roots=[];afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
const hash=value=>createHash('sha256').update(value).digest('hex');
test('retains the complete manifest-owned inventory, modes and Claude asset independently of Resources',async()=>{
 const root=await fs.mkdtemp(path.resolve('../../.cache/v2-validation/artifact-retention-'));roots.push(root);
 const source=path.join(root,'resources'),controlRoot=path.join(root,'control');await fs.mkdir(source);await fs.mkdir(controlRoot);
 const names=['DevRyan-controller','DevRyan-writer','DevRyan-Claude-credentials.mjs'],files=[];
 for(const name of names){const file=path.join(source,name),bytes=name+' fixture bytes';await fs.writeFile(file,bytes,{mode:name.endsWith('.mjs')?0o644:0o755});files.push({path:name,sha256:hash(bytes),size:Buffer.byteLength(bytes),mode:name.endsWith('.mjs')?0o644:0o755});}
 const manifestPath=path.join(source,'native-bundle.json');await fs.writeFile(manifestPath,JSON.stringify({files}));const manifestSha256=hash(await fs.readFile(manifestPath));
 const verifyArtifacts=async input=>({manifestPath:input.manifestPath,launcher:path.join(path.dirname(input.manifestPath),'launcher'),controller:path.join(path.dirname(input.manifestPath),names[0]),writer:path.join(path.dirname(input.manifestPath),names[1])});
 const retained=await retainNativeArtifacts({controlRoot,manifestPath,manifestSha256,verifyArtifacts});
 expect(retained.manifestPath).toBe(path.join(controlRoot,'artifacts',manifestSha256,'native-bundle.json'));
 await fs.rm(source,{recursive:true});
 for(const row of files){const file=path.join(path.dirname(retained.manifestPath),row.path);expect(hash(await fs.readFile(file))).toBe(row.sha256);expect((await fs.stat(file)).mode&0o777).toBe(row.mode);}
});

const HOUR=60*60_000;
// Fixture control root: retained sets, bundle descriptors and the selector only.
const control=async name=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),name)));roots.push(root);
 const controlRoot=path.join(root,'control'),artifacts=path.join(controlRoot,'artifacts');await fs.mkdir(artifacts,{recursive:true,mode:0o700});
 const set=async(label,{age=2*HOUR}={})=>{const sha=hash(label),directory=path.join(artifacts,sha);await fs.mkdir(directory);await fs.writeFile(path.join(directory,'native-bundle.json'),label);
  const at=new Date(Date.now()-age);await fs.utimes(directory,at,at);return sha;};
 const bundle=async(bundleID,sha,createdAt)=>{const directory=path.join(controlRoot,'bundles',bundleID);await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(path.join(directory,'descriptor.json'),JSON.stringify({schema:1,bundleID,generation:2,createdAt,launch:{artifactManifestSha256:sha,artifactManifestPath:path.join(artifacts,sha,'native-bundle.json')}}));};
 const select=(selectedBundleID,previousBundleID=null)=>fs.writeFile(path.join(controlRoot,'selection.json'),JSON.stringify({schema:1,revision:3,selectedBundleID,previousBundleID,transition:'activate',reconciliationRequired:false,preparedManifestSha256:'0'.repeat(64)}));
 const temporary=async(name,{age=2*HOUR}={})=>{const directory=path.join(artifacts,name);await fs.mkdir(path.join(directory,'nested'),{recursive:true});await fs.writeFile(path.join(directory,'nested','DevRyan-controller'),'partial');
  const at=new Date(Date.now()-age);await fs.utimes(directory,at,at);return name;};
 return {root,controlRoot,artifacts,set,bundle,select,temporary};
};
test('prunes only aged sets no selected, previous, newer draft, rollback intent or baseline references, and sweeps abandoned copies',async()=>{
 const c=await control('artifact-prune-');
 const selected=await c.set('selected'),previous=await c.set('previous'),draft=await c.set('draft'),intentCandidate=await c.set('intent-candidate'),baseline=await c.set('baseline');
 const old=await c.set('old'),orphan=await c.set('orphan'),fresh=await c.set('fresh',{age:0});
 await c.bundle('old',old,1_000);await c.bundle('previous',previous,2_000);await c.bundle('selected',selected,3_000);await c.bundle('native-draft-r3',draft,4_000);
 await c.select('selected','previous');
 await fs.mkdir(path.join(c.controlRoot,'rollback'));
 await fs.writeFile(path.join(c.controlRoot,'rollback','intent.json'),JSON.stringify({protocol:'devryan.bundle.rollback-intent/1',state:'resumed',candidateManifestSha256:intentCandidate,targetManifestSha256:previous}));
 await fs.writeFile(path.join(c.controlRoot,'rollback','selected.json'),JSON.stringify({schema:1,candidateBundleID:'selected',targetBundleID:'previous',targetManifestSha256:baseline}));
 await fs.mkdir(path.join(c.controlRoot,'bundles','.stale-0123456789abcdef'));
 const abandoned=await c.temporary(`.retaining-${'a'.repeat(8)}-0000-4000-8000-000000000000`),interrupted=await c.temporary('.pruning-00000000-0000-4000-8000-000000000001');
 const live=await c.temporary(`.retaining-${'b'.repeat(8)}-0000-4000-8000-000000000000`,{age:0});
 const result=await pruneRetainedNativeArtifacts({controlRoot:c.controlRoot});
 expect(result.pruned.sort()).toEqual([old,orphan].sort());expect(result.swept.sort()).toEqual([abandoned,interrupted].sort());
 expect((await fs.readdir(c.artifacts)).sort()).toEqual([selected,previous,draft,intentCandidate,baseline,fresh,live].sort());
 // Nothing left to prune: a second pass is a no-op.
 expect(await pruneRetainedNativeArtifacts({controlRoot:c.controlRoot})).toEqual({pruned:[],swept:[]});
});
test('pruning never follows a symlink and removes nothing while any reference is unreadable',async()=>{
 const c=await control('artifact-prune-refusal-'),outside=path.join(c.root,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'kept.txt'),'kept');
 const selected=await c.set('selected'),orphan=await c.set('orphan');await c.bundle('selected',selected,1_000);
 const linkedSet=path.join(c.artifacts,hash('linked')),linkedTemporary=path.join(c.artifacts,'.retaining-00000000-0000-4000-8000-00000000000c');
 await fs.symlink(outside,linkedSet);await fs.symlink(outside,linkedTemporary);
 // No selector yet: every set may still be a first launch's candidate.
 await expect(pruneRetainedNativeArtifacts({controlRoot:c.controlRoot})).rejects.toMatchObject({code:'bundle_artifact_retention_invalid'});
 await c.select('selected');
 for(const broken of [
  async()=>fs.mkdir(path.join(c.controlRoot,'bundles','interrupted-draft')),
  async()=>{await fs.rm(path.join(c.controlRoot,'bundles','interrupted-draft'),{recursive:true});await fs.mkdir(path.join(c.controlRoot,'rollback'));await fs.writeFile(path.join(c.controlRoot,'rollback','intent.json'),'{"candidateManifestSha256":"not-a-digest"}');},
 ]){
  await broken();
  await expect(pruneRetainedNativeArtifacts({controlRoot:c.controlRoot})).rejects.toMatchObject({code:'bundle_artifact_retention_invalid'});
  expect(await fs.stat(path.join(c.artifacts,orphan)).then(stat=>stat.isDirectory())).toBe(true);
 }
 await fs.rm(path.join(c.controlRoot,'rollback'),{recursive:true});
 expect((await pruneRetainedNativeArtifacts({controlRoot:c.controlRoot})).pruned).toEqual([orphan]);
 expect((await fs.lstat(linkedSet)).isSymbolicLink()).toBe(true);expect((await fs.lstat(linkedTemporary)).isSymbolicLink()).toBe(true);
 expect(await fs.readFile(path.join(outside,'kept.txt'),'utf8')).toBe('kept');
});
test('retention sweeps an abandoned copy and refreshes the age of a set it reuses',async()=>{
 const c=await control('artifact-retain-sweep-'),source=path.join(c.root,'resources');await fs.mkdir(source);
 const bytes='DevRyan-controller fixture bytes',files=[{path:'DevRyan-controller',sha256:hash(bytes),size:Buffer.byteLength(bytes),mode:0o755}];
 await fs.writeFile(path.join(source,'DevRyan-controller'),bytes,{mode:0o755});
 const manifestPath=path.join(source,'native-bundle.json');await fs.writeFile(manifestPath,JSON.stringify({files}));const manifestSha256=hash(await fs.readFile(manifestPath));
 const verifyArtifacts=async input=>({manifestPath:input.manifestPath,controller:path.join(path.dirname(input.manifestPath),'DevRyan-controller'),writer:path.join(path.dirname(input.manifestPath),'DevRyan-writer')});
 const abandoned=await c.temporary('.retaining-00000000-0000-4000-8000-00000000000d');
 await retainNativeArtifacts({controlRoot:c.controlRoot,manifestPath,manifestSha256,verifyArtifacts});
 expect(await fs.readdir(c.artifacts)).toEqual([manifestSha256]);expect(await fs.stat(path.join(c.artifacts,abandoned)).catch(error=>error.code)).toBe('ENOENT');
 const at=new Date(Date.now()-2*HOUR);await fs.utimes(path.join(c.artifacts,manifestSha256),at,at);
 await retainNativeArtifacts({controlRoot:c.controlRoot,manifestPath,manifestSha256,verifyArtifacts});
 expect(Date.now()-(await fs.stat(path.join(c.artifacts,manifestSha256))).mtimeMs).toBeLessThan(HOUR);
});
