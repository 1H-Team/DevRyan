import {test,expect} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createWindowsPrivateFilesFixture} from '../../../../../harness-runtime/lib/windows-private-files.fixture.js';
import {retainNativeArtifacts,pruneRetainedNativeArtifacts} from './retained-native-artifacts.js';
import {REVIEWED_WINDOWS_GIT_ARCHIVES,REVIEWED_WINDOWS_GIT_VERSION} from './reviewed-windows-git.js';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(action){
 const base=path.resolve('../../.cache/test-fixtures');await fs.mkdir(base,{recursive:true});const root=await fs.mkdtemp(path.join(base,'windows-retention-'));
 const native=createWindowsPrivateFilesFixture(root),controlRoot=path.join(root,'control'),source=path.join(root,'resources');await native.owner.ensureDirectory(controlRoot);await fs.mkdir(source);
 const bytes=Buffer.alloc(17*1024*1024,42),files=[{path:'DevRyan-controller',sha256:hash(bytes),size:bytes.length,mode:0o755},{path:'DevRyan-writer',sha256:hash('writer'),size:6,mode:0o755}];
 await fs.writeFile(path.join(source,files[0].path),bytes);await fs.writeFile(path.join(source,files[1].path),'writer');
 const manifestPath=path.join(source,'native-bundle.json');await fs.writeFile(manifestPath,JSON.stringify({files}));const manifestSha256=hash(await fs.readFile(manifestPath));
 const verifyArtifacts=async({manifestPath})=>({manifestPath,controller:path.join(path.dirname(manifestPath),'DevRyan-controller'),writer:path.join(path.dirname(manifestPath),'DevRyan-writer')});
 const options={controlRoot,manifestPath,manifestSha256,verifyArtifacts,windowsOwner:native.owner,windowsLauncher:native.owner.launcher,platform:'win32'};
 try{await action({...native,root,source,options,files,controlRoot,manifestSha256});}finally{await fs.rm(root,{recursive:true,force:true});}
}
test('Windows retains a controller beyond bounded JSON size through SDKstream and exact tree publication',()=>fixture(async({options,calls,files,source})=>{
 const result=await retainNativeArtifacts(options);expect(calls.filter(row=>row[0]==='streamFile').length).toBe(2);expect(calls.some(row=>row[0]==='renameTree')).toBe(true);
 await fs.rm(source,{recursive:true});for(const row of files){const bytes=await fs.readFile(path.join(path.dirname(result.manifestPath),row.path));expect(bytes.length).toBe(row.size);expect(hash(bytes)).toBe(row.sha256);}
}));
test('Windows retention refuses changed source bytes without publishing or adopting a stage',()=>fixture(async({options,source,controlRoot,calls})=>{
 await fs.writeFile(path.join(source,'DevRyan-writer'),'edited');await expect(retainNativeArtifacts(options)).rejects.toMatchObject({code:'fixture_source_changed'});
 expect(calls.some(row=>row[0]==='renameTree')).toBe(false);expect(await fs.readdir(path.join(controlRoot,'artifacts'))).toEqual([]);expect(calls.some(row=>row[0]==='removeTree')).toBe(true);
}));
test('Windows prune reads private references and removes only exact unreferenced SDKtrees',()=>fixture(async({options,owner,controlRoot,manifestSha256,calls})=>{
 await retainNativeArtifacts(options);const artifacts=path.join(controlRoot,'artifacts'),orphan=hash('orphan'),orphanRoot=path.join(artifacts,orphan);await owner.ensureDirectory(orphanRoot);await owner.write(path.join(orphanRoot,'owned.txt'),Buffer.from('old'));
 const bundle=path.join(controlRoot,'bundles','selected');await owner.ensureDirectory(bundle);await owner.write(path.join(bundle,'descriptor.json'),Buffer.from(JSON.stringify({bundleID:'selected',createdAt:100,launch:{artifactManifestSha256:manifestSha256,artifactManifestPath:path.join(artifacts,manifestSha256,'native-bundle.json')}})));
 await owner.write(path.join(controlRoot,'selection.json'),Buffer.from(JSON.stringify({selectedBundleID:'selected',previousBundleID:null})));
 const result=await pruneRetainedNativeArtifacts({...options,minimumAgeMs:0,now:()=>Date.now()+1000});expect(result.pruned).toEqual([orphan]);expect(await fs.readdir(artifacts)).toEqual([manifestSha256]);expect(calls.some(row=>row[0]==='renameTree'&&row[1]===orphanRoot)).toBe(true);expect(calls.some(row=>row[0]==='removeTree'&&row[1].includes('.pruning-'))).toBe(true);
}));
test('Windows retention has no filesystem mutation fallback without its constructor owner',()=>fixture(async({options,controlRoot})=>{
 await expect(retainNativeArtifacts({...options,windowsOwner:undefined})).rejects.toMatchObject({code:'bundle_artifact_retention_invalid'});await expect(fs.lstat(path.join(controlRoot,'artifacts'))).rejects.toMatchObject({code:'ENOENT'});
}));
test('Windows retains an accepted MinGit inventory beyond the ordinary 256-row cap',()=>fixture(async({options,files,source,calls})=>{
 const arch=process.arch,pin=REVIEWED_WINDOWS_GIT_ARCHIVES[arch],windowsGit={protocol:'devryan.windows-mingit/1',version:REVIEWED_WINDOWS_GIT_VERSION,arch,directory:'git',executable:'git/cmd/git.exe',archiveSha256:pin.sha256,archiveUrl:pin.url};
 const git=[];for(let index=0;index<257;index++){const file='git/dependencies/'+index+'.dll',bytes=Buffer.from('dependency '+index);await fs.mkdir(path.dirname(path.join(source,file)),{recursive:true});await fs.writeFile(path.join(source,file),bytes);git.push({path:file,sha256:hash(bytes),size:bytes.length,mode:0o644});}
 const bytes=Buffer.from(JSON.stringify({windowsGit,files:[...files,...git]}));await fs.writeFile(options.manifestPath,bytes);
 const retained=await retainNativeArtifacts({...options,manifestSha256:hash(bytes)});expect(calls.filter(row=>row[0]==='streamFile')).toHaveLength(259);
 expect(await fs.readFile(path.join(path.dirname(retained.manifestPath),git[256].path),'utf8')).toBe('dependency 256');
}));
test('Windows refuses oversized unreviewed inventories before creating a retention stage',()=>fixture(async({options,files,controlRoot})=>{
 const rows=Array.from({length:257},(_,index)=>({...files[1],path:'asset-'+index})),bytes=Buffer.from(JSON.stringify({files:rows}));await fs.writeFile(options.manifestPath,bytes);
 await expect(retainNativeArtifacts({...options,manifestSha256:hash(bytes)})).rejects.toMatchObject({code:'bundle_artifact_retention_invalid'});await expect(fs.lstat(path.join(controlRoot,'artifacts'))).rejects.toMatchObject({code:'ENOENT'});
}));
