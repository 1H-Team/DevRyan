import {test,expect} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {REVIEWED_WINDOWS_GIT_ARCHIVES,REVIEWED_WINDOWS_GIT_VERSION,nativeArtifactInventoryLimit,validWindowsArtifactPath,verifyWindowsGitInventory,verifyWindowsGitMetadata} from './reviewed-windows-git.js';
const metadata=arch=>({protocol:'devryan.windows-mingit/1',version:REVIEWED_WINDOWS_GIT_VERSION,arch,directory:'git',executable:'git/cmd/git.exe',archiveSha256:REVIEWED_WINDOWS_GIT_ARCHIVES[arch].sha256,archiveUrl:REVIEWED_WINDOWS_GIT_ARCHIVES[arch].url});
const acceptedRows=JSON.parse(await fs.readFile(new URL('../../../../../../scripts/opencode-v2-native/fixtures/reviewed-windows-git-x64.json',import.meta.url),'utf8'));
test('accepted MinGit metadata pins architecture, stable archive and complete root',()=>{
 for(const arch of ['x64','arm64']){
  expect(verifyWindowsGitMetadata(metadata(arch),arch)).toEqual(metadata(arch));
  for(const changed of [{arch:arch==='x64'?'arm64':'x64'},{archiveSha256:'0'.repeat(64)},{archiveUrl:'https://example.test/git.zip'},{directory:'other'},{executable:'git/bin/git.exe'},{extra:true}])
   expect(()=>verifyWindowsGitMetadata({...metadata(arch),...changed},arch)).toThrow('native_runtime_artifacts_unverified');
 }
});
test('4096 inventory cap applies only to pinned Windows Git and preserves other targets',()=>{
 expect(nativeArtifactInventoryLimit({windowsGit:metadata('x64')},'win32','x64')).toBe(4096);
 expect(nativeArtifactInventoryLimit({},'win32','x64')).toBe(256);
 expect(nativeArtifactInventoryLimit({},'darwin','arm64')).toBe(256);
 expect(()=>nativeArtifactInventoryLimit({windowsGit:metadata('arm64')},'darwin','arm64')).toThrow();
 expect(()=>nativeArtifactInventoryLimit({windowsGit:{...metadata('x64'),version:'latest'}},'win32','x64')).toThrow();
});
test('Windows inventory paths reject alternate separators, streams, DOS devices and aliases',()=>{
 for(const value of ['git/cmd/git.exe','git/usr/share/licenses/COPYING'])expect(validWindowsArtifactPath(value)).toBe(true);
 for(const value of ['git\\cmd\\git.exe','git/cmd/git.exe:stream','git/NUL','git/con.txt','git/COM1.dll','git/cmd./git.exe','git/cmd /git.exe','git//git.exe','git/../git.exe'])expect(validWindowsArtifactPath(value)).toBe(false);
});
async function fixture(action){
 const base=path.resolve('../../.cache/test-fixtures');await fs.mkdir(base,{recursive:true});const directory=await fs.realpath(await fs.mkdtemp(path.join(base,'git-inventory-')));
 const files=acceptedRows.map(row=>({...row,role:'asset',signing:{mode:'unsigned'}}));
 for(const row of files){const target=path.join(directory,row.path);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,row.path);}
 const manifest={windowsGit:metadata('x64'),files};try{await action({directory,manifest});}finally{await fs.rm(directory,{recursive:true,force:true});}
}
test('accepted inventory retains DLLs, non-EXE libexec helpers and licenses',()=>fixture(async input=>{
 const accepted=await verifyWindowsGitInventory({...input,arch:'x64'});expect(accepted.path).toBe(path.join(input.directory,'git/cmd/git.exe'));expect(accepted.directory).toBe(path.join(input.directory,'git'));expect(accepted.sha256).toBe(acceptedRows.find(row=>row.path==='git/cmd/git.exe').sha256);
}));
test('runtime Git inventory refuses an uninventoried DLL or directory',()=>fixture(async input=>{
 const extra=path.join(input.directory,'git/ucrt64/bin/injected.dll');await fs.writeFile(extra,'extra');await expect(verifyWindowsGitInventory({...input,arch:'x64'})).rejects.toMatchObject({code:'native_runtime_artifacts_unverified'});
 await fs.rm(extra);await fs.mkdir(path.join(input.directory,'git/extra'));await expect(verifyWindowsGitInventory({...input,arch:'x64'})).rejects.toMatchObject({code:'native_runtime_artifacts_unverified'});
}));
test('runtime Git inventory refuses omitted dependencies and linked helpers',()=>fixture(async input=>{
 const helper=path.join(input.directory,'git/ucrt64/libexec/git-core/git-merge-octopus');await fs.rm(helper);await expect(verifyWindowsGitInventory({...input,arch:'x64'})).rejects.toThrow();
 await fs.symlink(path.join(input.directory,'git/cmd/git.exe'),helper);await expect(verifyWindowsGitInventory({...input,arch:'x64'})).rejects.toThrow();
}));
test('runtime Git inventory requires the pinned cmd entry and asset roles',()=>fixture(async input=>{
 await expect(verifyWindowsGitInventory({...input,manifest:{...input.manifest,files:input.manifest.files.filter(row=>row.path!=='git/cmd/git.exe')},arch:'x64'})).rejects.toThrow();
 input.manifest.files[1].role='writer';await expect(verifyWindowsGitInventory({...input,arch:'x64'})).rejects.toThrow();
}));
test('runtime Git inventory refuses a truncated archive even when its remaining rows match disk',()=>fixture(async input=>{
 const removed=input.manifest.files.pop();await fs.rm(path.join(input.directory,removed.path));await expect(verifyWindowsGitInventory({...input,arch:'x64'})).rejects.toThrow();
}));
test('runtime Git inventory rejects rewritten dependency hashes under unchanged archive metadata',()=>fixture(async input=>{
 input.manifest.files.find(row=>row.path.endsWith('.dll')).sha256='0'.repeat(64);await expect(verifyWindowsGitInventory({...input,arch:'x64'})).rejects.toThrow();
}));
