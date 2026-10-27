import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const REVIEWED_WINDOWS_GIT_VERSION='2.56.0.windows.2';
export const REVIEWED_WINDOWS_GIT_ARCHIVES=Object.freeze({
 x64:Object.freeze({sha256:'da35e72aa21c005a5a0d298cfbae110bc1609a815730ea0dde84b01a1b3cd3be',url:'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/MinGit-2.56.0.2-64-bit.zip',fileCount:373,backend:'git/ucrt64/bin/git.exe',inventorySha256:'c84c6a023e2d2cc362c6ae7159dcd517a524cd39593ad0a72051cc5945b3ce41'}),
 arm64:Object.freeze({sha256:'38b33dc6024026e3315cf88ab2cfea65205bbd7bb3a8e824bd21c8ad4fe609a7',url:'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/MinGit-2.56.0.2-arm64.zip',fileCount:499,backend:'git/clangarm64/bin/git.exe',inventorySha256:'496c2ee6a614be4581a1d9532389b10b9e40f67597cda6cde4499c3eda8fa571'}),
});
const fail=()=>Object.assign(new Error('native_runtime_artifacts_unverified'),{code:'native_runtime_artifacts_unverified',status:503});
export function verifyWindowsGitMetadata(value,arch){
 const pin=REVIEWED_WINDOWS_GIT_ARCHIVES[arch];
 if(!pin||!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==7
  ||value.protocol!=='devryan.windows-mingit/1'||value.version!==REVIEWED_WINDOWS_GIT_VERSION||value.arch!==arch
  ||value.directory!=='git'||value.executable!=='git/cmd/git.exe'||value.archiveSha256!==pin.sha256||value.archiveUrl!==pin.url)throw fail();
 return value;
}
export function nativeArtifactInventoryLimit(manifest,platform,arch){
 if(platform!=='win32'){if(manifest.windowsGit!==undefined)throw fail();return 256;}
 if(manifest.windowsGit===undefined)return 256;
 verifyWindowsGitMetadata(manifest.windowsGit,arch);return 4096;
}
export function validWindowsArtifactPath(value){
 return !value.includes('\\')&&value.split('/').every(part=>part&&!/[<>:"|?*\u0000-\u001f]/.test(part)&&!/[. ]$/.test(part)
  &&!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
/** The accepted archive owns every executable, DLL, helper, template and license below git. */
export async function verifyWindowsGitInventory({manifest,directory,arch}){
 const metadata=verifyWindowsGitMetadata(manifest.windowsGit,arch),expectedFiles=new Set(),expectedDirectories=new Set(['git']);
 let executable;
 for(const row of manifest.files){
  if(!row.path.startsWith('git/'))continue;
  if(row.role!=='asset'||row.mode!==0o644||row.signing?.mode!=='unsigned'||!validWindowsArtifactPath(row.path))throw fail();
  expectedFiles.add(row.path);
  for(let parent=path.posix.dirname(row.path);parent!=='.';parent=path.posix.dirname(parent))expectedDirectories.add(parent);
  if(row.path===metadata.executable)executable=row;
 }
 const pin=REVIEWED_WINDOWS_GIT_ARCHIVES[arch];
 if(!executable||expectedFiles.size!==pin.fileCount||!expectedFiles.has(pin.backend)||!expectedFiles.has('git/LICENSE.txt'))throw fail();
 // Archive mode is a canonical provenance field; platform file permissions are
 // independently checked by native-artifacts before this inventory is accepted.
 const rows=manifest.files.filter(row=>row.path.startsWith('git/')).map(row=>({path:row.path,size:row.size,sha256:row.sha256,mode:0o644})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 if(createHash('sha256').update(JSON.stringify(rows)).digest('hex')!==pin.inventorySha256)throw fail();
 const seenFiles=new Set(),seenDirectories=new Set();
 const visit=async relative=>{
  const target=path.join(directory,relative),stat=await fs.lstat(target);
  if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(target)!==target||!expectedDirectories.has(relative))throw fail();
  seenDirectories.add(relative);
  for(const entry of await fs.readdir(target,{withFileTypes:true})){
   const child=relative+'/'+entry.name;
   if(entry.isDirectory()){await visit(child);continue;}
   if(!entry.isFile()||entry.isSymbolicLink()||!expectedFiles.has(child))throw fail();
   seenFiles.add(child);
  }
 };
 await visit('git');
 if(seenFiles.size!==expectedFiles.size||seenDirectories.size!==expectedDirectories.size)throw fail();
 return Object.freeze({path:path.join(directory,metadata.executable),directory:path.join(directory,metadata.directory),version:metadata.version,arch:metadata.arch,sha256:executable.sha256,archiveSha256:metadata.archiveSha256});
}
